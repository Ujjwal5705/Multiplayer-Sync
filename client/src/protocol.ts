/**
 * protocol.ts
 * -----------
 * Single source of truth for every message that crosses the wire.
 *
 * Design notes (see ARCHITECTURE.md for the full writeup):
 * - Every message is a discriminated union on `type`, so TypeScript can
 *   narrow correctly and adding a new action type never touches transport code.
 * - Messages are kept intentionally flat and small (bandwidth matters at
 *   30-60Hz across many clients).
 * - `seq` is a per-sender monotonically increasing counter used for
 *   ordering/staleness checks. `t` is the sender's local clock at the moment
 *   the action happened (used for interpolation timing), NOT a trusted
 *   authoritative time.
 * - Nothing here is ever `eval`'d or trusted blindly: parseClientMessage /
 *   parseServerMessage are the ONLY way malformed/unknown input becomes a
 *   typed message. Anything that doesn't validate returns `null` and is
 *   dropped rather than crashing or being silently forwarded.
 */

// ---------- Shared primitives ----------

export type ClientId = string;

/** Bound to keep a hostile/buggy client from spamming huge payloads. */
export const MAX_EMOJI_LENGTH = 8;
export const MAX_NAME_LENGTH = 24;

// ---------- Client -> Server messages ----------

export interface JoinMessage {
  type: "join";
  roomId: string;
  clientId: ClientId;
  name?: string;
}

export interface CursorMessage {
  type: "cursor";
  seq: number;
  x: number; // normalized 0..1 (fraction of the shared canvas), see render.ts
  y: number; // normalized 0..1
  t: number; // sender's Date.now() at time of sampling
}

export interface ReactionMessage {
  type: "reaction";
  seq: number;
  x: number;
  y: number;
  emoji: string;
  t: number;
}

/** App-level ping, separate from the WebSocket protocol ping/pong frames.
 *  Used purely to let the client measure round-trip latency for display. */
export interface PingMessage {
  type: "ping";
  t: number; // client's Date.now() when sent, echoed back verbatim
}

export type ClientMessage =
  | JoinMessage
  | CursorMessage
  | ReactionMessage
  | PingMessage;

// ---------- Server -> Client messages ----------

export interface ParticipantInfo {
  clientId: ClientId;
  name: string;
  color: string;
  x: number;
  y: number;
}

/** Sent once, right after a successful join: full current snapshot of the
 *  room so a new client doesn't have to wait for the next tick from every
 *  peer to see who's already there. See ARCHITECTURE.md "join strategy". */
export interface WelcomeMessage {
  type: "welcome";
  selfId: ClientId;
  color: string;
  serverTime: number;
  participants: ParticipantInfo[];
}

export interface PeerJoinedMessage {
  type: "peer_joined";
  clientId: ClientId;
  name: string;
  color: string;
  x: number;
  y: number;
}

export interface PeerLeftMessage {
  type: "peer_left";
  clientId: ClientId;
}

export interface RelayedCursorMessage {
  type: "cursor";
  clientId: ClientId;
  seq: number;
  x: number;
  y: number;
  t: number;
}

export interface RelayedReactionMessage {
  type: "reaction";
  clientId: ClientId;
  seq: number;
  x: number;
  y: number;
  emoji: string;
  t: number;
}

export interface PongMessage {
  type: "pong";
  t: number; // echoes the client's PingMessage.t
}

export interface ErrorMessage {
  type: "error";
  reason: string;
}

export type ServerMessage =
  | WelcomeMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RelayedCursorMessage
  | RelayedReactionMessage
  | PongMessage
  | ErrorMessage;

// ---------- Runtime validation ----------
// Hand-written type guards rather than a schema library: the message shapes
// are small and stable, and this keeps the dependency list at zero for the
// part of the system that's supposed to demonstrate understanding of the
// protocol, not a library's schema DSL.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown, maxLen = 256): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maxLen;
}

/** Coordinates are normalized 0..1 fractions of the shared surface so the
 *  protocol doesn't care about each client's viewport size. Clamp instead
 *  of rejecting on tiny float overshoot (e.g. 1.0000000002) from resizing. */
function isNormalizedCoord(v: unknown): v is number {
  return isFiniteNumber(v) && v >= -0.05 && v <= 1.05;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case "join": {
      if (!isNonEmptyString(msg.roomId, 64)) return null;
      if (!isNonEmptyString(msg.clientId, 64)) return null;
      if (
        msg.name !== undefined &&
        !isNonEmptyString(msg.name, MAX_NAME_LENGTH)
      )
        return null;
      return {
        type: "join",
        roomId: msg.roomId,
        clientId: msg.clientId,
        name: msg.name as string | undefined,
      };
    }
    case "cursor": {
      if (!isFiniteNumber(msg.seq) || msg.seq < 0) return null;
      if (!isNormalizedCoord(msg.x) || !isNormalizedCoord(msg.y)) return null;
      if (!isFiniteNumber(msg.t)) return null;
      return { type: "cursor", seq: msg.seq, x: msg.x, y: msg.y, t: msg.t };
    }
    case "reaction": {
      if (!isFiniteNumber(msg.seq) || msg.seq < 0) return null;
      if (!isNormalizedCoord(msg.x) || !isNormalizedCoord(msg.y)) return null;
      if (!isNonEmptyString(msg.emoji, MAX_EMOJI_LENGTH)) return null;
      if (!isFiniteNumber(msg.t)) return null;
      return {
        type: "reaction",
        seq: msg.seq,
        x: msg.x,
        y: msg.y,
        emoji: msg.emoji,
        t: msg.t,
      };
    }
    case "ping": {
      if (!isFiniteNumber(msg.t)) return null;
      return { type: "ping", t: msg.t };
    }
    default:
      return null; // unknown type: reject, don't guess
  }
}

export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case "welcome": {
      if (!isNonEmptyString(msg.selfId, 64)) return null;
      if (!isNonEmptyString(msg.color, 16)) return null;
      if (!isFiniteNumber(msg.serverTime)) return null;
      if (!Array.isArray(msg.participants)) return null;
      const participants: ParticipantInfo[] = [];
      for (const p of msg.participants) {
        if (typeof p !== "object" || p === null) return null;
        const rec = p as Record<string, unknown>;
        if (!isNonEmptyString(rec.clientId, 64)) return null;
        if (!isNonEmptyString(rec.name, MAX_NAME_LENGTH)) return null;
        if (!isNonEmptyString(rec.color, 16)) return null;
        if (!isNormalizedCoord(rec.x) || !isNormalizedCoord(rec.y)) return null;
        participants.push({
          clientId: rec.clientId,
          name: rec.name,
          color: rec.color,
          x: rec.x,
          y: rec.y,
        });
      }
      return {
        type: "welcome",
        selfId: msg.selfId,
        color: msg.color,
        serverTime: msg.serverTime,
        participants,
      };
    }
    case "peer_joined": {
      if (!isNonEmptyString(msg.clientId, 64)) return null;
      if (!isNonEmptyString(msg.name, MAX_NAME_LENGTH)) return null;
      if (!isNonEmptyString(msg.color, 16)) return null;
      if (!isNormalizedCoord(msg.x) || !isNormalizedCoord(msg.y)) return null;
      return {
        type: "peer_joined",
        clientId: msg.clientId,
        name: msg.name,
        color: msg.color,
        x: msg.x,
        y: msg.y,
      };
    }
    case "peer_left": {
      if (!isNonEmptyString(msg.clientId, 64)) return null;
      return { type: "peer_left", clientId: msg.clientId };
    }
    case "cursor": {
      if (!isNonEmptyString(msg.clientId, 64)) return null;
      if (!isFiniteNumber(msg.seq)) return null;
      if (!isNormalizedCoord(msg.x) || !isNormalizedCoord(msg.y)) return null;
      if (!isFiniteNumber(msg.t)) return null;
      return {
        type: "cursor",
        clientId: msg.clientId,
        seq: msg.seq,
        x: msg.x,
        y: msg.y,
        t: msg.t,
      };
    }
    case "reaction": {
      if (!isNonEmptyString(msg.clientId, 64)) return null;
      if (!isFiniteNumber(msg.seq)) return null;
      if (!isNormalizedCoord(msg.x) || !isNormalizedCoord(msg.y)) return null;
      if (!isNonEmptyString(msg.emoji, MAX_EMOJI_LENGTH)) return null;
      if (!isFiniteNumber(msg.t)) return null;
      return {
        type: "reaction",
        clientId: msg.clientId,
        seq: msg.seq,
        x: msg.x,
        y: msg.y,
        emoji: msg.emoji,
        t: msg.t,
      };
    }
    case "pong": {
      if (!isFiniteNumber(msg.t)) return null;
      return { type: "pong", t: msg.t };
    }
    case "error": {
      if (!isNonEmptyString(msg.reason, 256)) return null;
      return { type: "error", reason: msg.reason };
    }
    default:
      return null;
  }
}
