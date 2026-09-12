/**
 * connection.ts
 * -------------
 * Transport + reconnection. This is the ONLY file that touches the raw
 * browser WebSocket API. Nothing here knows how to draw a cursor or lerp a
 * position - that's render.ts / interpolation.ts. This separation is what
 * lets a new action type be added by editing protocol.ts + this file's
 * small OUTGOING_THROTTLE_MS table, without touching App.tsx's rendering.
 *
 * Bandwidth strategy (see ARCHITECTURE.md for the full tradeoff writeup):
 * - `mousemove` fires at 60-120Hz depending on hardware. We do NOT send on
 *   every event. Each action type has its own minimum send interval; cursor
 *   updates are capped at ~30Hz (33ms), and additionally skipped entirely if
 *   the position hasn't moved more than a small threshold since the last
 *   SENT sample (near-zero movement = near-zero information).
 * - Reactions are discrete/rare, so they're sent immediately (no throttle).
 *
 * Reconnection strategy:
 * - On an unintentional close (network drop), we retry with exponential
 *   backoff (500ms -> 1s -> 2s -> 4s, capped at 5s) and re-send `join` with
 *   the SAME clientId once reopened, so the server treats it as a resume
 *   (see Room.join in room.ts) rather than a brand-new participant.
 * - Calling `room.close()` is an intentional leave: no reconnect attempt.
 */

import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type ParticipantInfo,
} from "./protocol";

export type OutgoingAction =
  | { type: "cursor"; x: number; y: number }
  | { type: "reaction"; x: number; y: number; emoji: string };

export type RemoteAction =
  | { type: "cursor"; x: number; y: number; t: number; seq: number }
  | {
      type: "reaction";
      x: number;
      y: number;
      emoji: string;
      t: number;
      seq: number;
    };

export type ConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface RoomOptions {
  roomId: string;
  clientId: string;
  name?: string;
  /** Defaults to same-host `/ws`, overridable for local dev against a
   *  different port or a deployed server URL. */
  url?: string;
}

/** Minimum ms between SENT messages, per outgoing action type. Adding a new
 *  action type just means adding a line here - no other code changes. */
const OUTGOING_THROTTLE_MS: Record<OutgoingAction["type"], number> = {
  cursor: 33, // ~30Hz cap, well under a 60-120Hz mousemove firehose
  reaction: 0, // discrete + rare: always send immediately
};

/** Below this normalized-distance since the last SENT cursor sample, we
 *  skip sending entirely - a stationary mouse shouldn't cost bandwidth. */
const MIN_CURSOR_DELTA = 0.0025;

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5000;

type RemoteActionHandler = (clientId: string, action: RemoteAction) => void;
type PeerJoinedHandler = (peer: ParticipantInfo) => void;
type PeerLeftHandler = (clientId: string) => void;
type WelcomeHandler = (
  selfId: string,
  color: string,
  participants: ParticipantInfo[],
) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type LatencyHandler = (rttMs: number) => void;

export interface Room {
  sendAction(action: OutgoingAction): void;
  onRemoteAction(cb: RemoteActionHandler): () => void;
  onPeerJoined(cb: PeerJoinedHandler): () => void;
  onPeerLeft(cb: PeerLeftHandler): () => void;
  onWelcome(cb: WelcomeHandler): () => void;
  onStatusChange(cb: StatusHandler): () => void;
  onLatency(cb: LatencyHandler): () => void;
  /** Intentional leave - no reconnect attempts afterward. */
  close(): void;
}

function defaultWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export function createRoom(options: RoomOptions): Room {
  const url = options.url ?? defaultWsUrl();

  let ws: WebSocket | null = null;
  let closedIntentionally = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const remoteActionHandlers = new Set<RemoteActionHandler>();
  const peerJoinedHandlers = new Set<PeerJoinedHandler>();
  const peerLeftHandlers = new Set<PeerLeftHandler>();
  const welcomeHandlers = new Set<WelcomeHandler>();
  const statusHandlers = new Set<StatusHandler>();
  const latencyHandlers = new Set<LatencyHandler>();

  const seqCounters: Record<OutgoingAction["type"], number> = {
    cursor: 0,
    reaction: 0,
  };
  const lastSentAt: Record<OutgoingAction["type"], number> = {
    cursor: 0,
    reaction: 0,
  };
  let lastSentCursor: { x: number; y: number } | null = null;

  let latencyPingInterval: ReturnType<typeof setInterval> | null = null;

  function emitStatus(status: ConnectionStatus): void {
    for (const cb of statusHandlers) cb(status);
  }

  function sendRaw(msg: ClientMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function connect(): void {
    emitStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempt = 0;
      sendRaw({
        type: "join",
        roomId: options.roomId,
        clientId: options.clientId,
        name: options.name,
      });
      emitStatus("open");

      // App-level latency probe, independent of the WS protocol's own
      // ping/pong frames (browsers don't expose those to JS anyway).
      latencyPingInterval = setInterval(() => {
        sendRaw({ type: "ping", t: Date.now() });
      }, 4000);
    };

    ws.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return; // malformed JSON from the network: drop, don't crash
      }
      const msg: ServerMessage | null = parseServerMessage(parsed);
      if (!msg) return; // unknown/invalid shape: drop, don't crash

      switch (msg.type) {
        case "welcome":
          for (const cb of welcomeHandlers)
            cb(msg.selfId, msg.color, msg.participants);
          break;
        case "peer_joined":
          for (const cb of peerJoinedHandlers) {
            cb({
              clientId: msg.clientId,
              name: msg.name,
              color: msg.color,
              x: msg.x,
              y: msg.y,
            });
          }
          break;
        case "peer_left":
          for (const cb of peerLeftHandlers) cb(msg.clientId);
          break;
        case "cursor":
          for (const cb of remoteActionHandlers) {
            cb(msg.clientId, {
              type: "cursor",
              x: msg.x,
              y: msg.y,
              t: msg.t,
              seq: msg.seq,
            });
          }
          break;
        case "reaction":
          for (const cb of remoteActionHandlers) {
            cb(msg.clientId, {
              type: "reaction",
              x: msg.x,
              y: msg.y,
              emoji: msg.emoji,
              t: msg.t,
              seq: msg.seq,
            });
          }
          break;
        case "pong": {
          const rtt = Date.now() - msg.t;
          for (const cb of latencyHandlers) cb(rtt);
          break;
        }
        case "error":
          console.warn("[room] server error:", msg.reason);
          break;
      }
    };

    ws.onclose = () => {
      if (latencyPingInterval) {
        clearInterval(latencyPingInterval);
        latencyPingInterval = null;
      }
      if (closedIntentionally) {
        emitStatus("closed");
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      // 'close' always follows 'error' for the browser WebSocket API, so
      // reconnect scheduling happens once, in onclose, not here.
    };
  }

  function scheduleReconnect(): void {
    emitStatus("reconnecting");
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    sendAction(action) {
      const now = performance.now();
      const minInterval = OUTGOING_THROTTLE_MS[action.type];

      if (action.type === "cursor") {
        if (
          lastSentCursor &&
          Math.hypot(action.x - lastSentCursor.x, action.y - lastSentCursor.y) <
            MIN_CURSOR_DELTA
        ) {
          return; // negligible movement: not worth a network message
        }
      }

      if (now - lastSentAt[action.type] < minInterval) {
        return; // throttled: too soon since the last send of this type
      }
      lastSentAt[action.type] = now;

      const seq = seqCounters[action.type]++;
      const t = Date.now();

      if (action.type === "cursor") {
        lastSentCursor = { x: action.x, y: action.y };
        sendRaw({ type: "cursor", seq, x: action.x, y: action.y, t });
      } else {
        sendRaw({
          type: "reaction",
          seq,
          x: action.x,
          y: action.y,
          emoji: action.emoji,
          t,
        });
      }
    },

    onRemoteAction(cb) {
      remoteActionHandlers.add(cb);
      return () => remoteActionHandlers.delete(cb);
    },
    onPeerJoined(cb) {
      peerJoinedHandlers.add(cb);
      return () => peerJoinedHandlers.delete(cb);
    },
    onPeerLeft(cb) {
      peerLeftHandlers.add(cb);
      return () => peerLeftHandlers.delete(cb);
    },
    onWelcome(cb) {
      welcomeHandlers.add(cb);
      return () => welcomeHandlers.delete(cb);
    },
    onStatusChange(cb) {
      statusHandlers.add(cb);
      return () => statusHandlers.delete(cb);
    },
    onLatency(cb) {
      latencyHandlers.add(cb);
      return () => latencyHandlers.delete(cb);
    },

    close() {
      closedIntentionally = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (latencyPingInterval) clearInterval(latencyPingInterval);
      ws?.close();
    },
  };
}
