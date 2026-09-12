/**
 * room.ts
 * -------
 * All state for a single room lives here. Deliberately NOT a distributed
 * system: one room = one JS object in this process's memory. No persistence
 * across restarts (documented limitation).
 *
 * Responsibilities:
 * - Track connected clients and their last-known cursor position/color/name.
 * - Validate per-sender ordering (drop stale/out-of-order cursor & reaction
 *   messages using per-message-type sequence numbers).
 * - Fan out messages to every OTHER client in the room in O(n) per message
 *   (not O(n^2): each incoming message triggers exactly one pass over the
 *   room's client list, nothing recursive/cascading).
 * - Never echo a message back to the sender (the sender already applied its
 *   own input locally for zero-latency local feedback - see connection.ts).
 */

import type { WebSocket } from "ws";
import type {
  ServerMessage,
  ParticipantInfo,
  ClientId,
  CursorMessage,
  ReactionMessage,
} from "./protocol.js";

const COLOR_PALETTE = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

interface Participant {
  clientId: ClientId;
  name: string;
  color: string;
  socket: WebSocket;
  x: number;
  y: number;
  /** Highest sequence number we've accepted so far, per stream. Any incoming
   *  message with seq <= this is stale/out-of-order and gets dropped. */
  lastCursorSeq: number;
  lastReactionSeq: number;
  /** Updated on every inbound message OR pong; used by the server's
   *  heartbeat sweep to decide who's gone dark. */
  lastSeenAt: number;
}

let nextColorIndex = 0;

export class Room {
  readonly roomId: string;
  private participants = new Map<ClientId, Participant>();

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  get size(): number {
    return this.participants.size;
  }

  isEmpty(): boolean {
    return this.participants.size === 0;
  }

  /** Adds a client and returns the snapshot it should receive immediately,
   *  plus broadcasts `peer_joined` to everyone already in the room.
   *  Join strategy: full-state snapshot (not replay of history) - a new
   *  client gets exactly where everyone currently is, in one message,
   *  rather than waiting for each peer's next tick. See ARCHITECTURE.md. */
  join(
    clientId: ClientId,
    name: string | undefined,
    socket: WebSocket,
  ): ParticipantInfo[] {
    const existing = this.participants.get(clientId);
    if (existing) {
      // Reconnect with the same clientId: replace the socket, keep position,
      // don't duplicate the participant or re-announce them as new.
      existing.socket = socket;
      existing.lastSeenAt = Date.now();
      return this.snapshot(clientId);
    }

    const color = COLOR_PALETTE[nextColorIndex % COLOR_PALETTE.length];
    nextColorIndex++;

    const participant: Participant = {
      clientId,
      name: (name && name.trim()) || `Guest-${clientId.slice(0, 4)}`,
      color,
      socket,
      x: 0.5,
      y: 0.5,
      lastCursorSeq: -1,
      lastReactionSeq: -1,
      lastSeenAt: Date.now(),
    };
    this.participants.set(clientId, participant);

    this.broadcast(
      {
        type: "peer_joined",
        clientId: participant.clientId,
        name: participant.name,
        color: participant.color,
        x: participant.x,
        y: participant.y,
      },
      clientId,
    );

    return this.snapshot(clientId);
  }

  private snapshot(excludeClientId: ClientId): ParticipantInfo[] {
    const out: ParticipantInfo[] = [];
    for (const p of this.participants.values()) {
      if (p.clientId === excludeClientId) continue;
      out.push({
        clientId: p.clientId,
        name: p.name,
        color: p.color,
        x: p.x,
        y: p.y,
      });
    }
    return out;
  }

  getColor(clientId: ClientId): string | undefined {
    return this.participants.get(clientId)?.color;
  }

  touch(clientId: ClientId): void {
    const p = this.participants.get(clientId);
    if (p) p.lastSeenAt = Date.now();
  }

  /** Returns true if the cursor update was fresh and should be relayed. */
  applyCursor(clientId: ClientId, msg: CursorMessage): boolean {
    const p = this.participants.get(clientId);
    if (!p) return false;
    if (msg.seq <= p.lastCursorSeq) return false; // stale/out-of-order: drop
    p.lastCursorSeq = msg.seq;
    p.x = msg.x;
    p.y = msg.y;
    p.lastSeenAt = Date.now();
    this.broadcast(
      { type: "cursor", clientId, seq: msg.seq, x: msg.x, y: msg.y, t: msg.t },
      clientId,
    );
    return true;
  }

  applyReaction(clientId: ClientId, msg: ReactionMessage): boolean {
    const p = this.participants.get(clientId);
    if (!p) return false;
    if (msg.seq <= p.lastReactionSeq) return false;
    p.lastReactionSeq = msg.seq;
    p.lastSeenAt = Date.now();
    this.broadcast(
      {
        type: "reaction",
        clientId,
        seq: msg.seq,
        x: msg.x,
        y: msg.y,
        emoji: msg.emoji,
        t: msg.t,
      },
      clientId,
    );
    return true;
  }

  /** Removes a client and tells everyone else. Idempotent: safe to call
   *  twice for the same clientId (e.g. both 'close' and a heartbeat sweep
   *  race) without sending a duplicate peer_left. */
  leave(clientId: ClientId): void {
    const existed = this.participants.delete(clientId);
    if (existed) {
      this.broadcast({ type: "peer_left", clientId }, clientId);
    }
  }

  /** Clients whose lastSeenAt is older than `maxAgeMs` - used by the
   *  server's heartbeat sweep to find dead connections whose 'close'
   *  event never fired (e.g. yanked network cable). */
  findStale(maxAgeMs: number): ClientId[] {
    const now = Date.now();
    const stale: ClientId[] = [];
    for (const p of this.participants.values()) {
      if (now - p.lastSeenAt > maxAgeMs) stale.push(p.clientId);
    }
    return stale;
  }

  /** Single O(n) pass over this room's clients. Never sends to `excludeId`
   *  (the sender), which is what stops us from echoing actions back to the
   *  client that produced them. */
  private broadcast(message: ServerMessage, excludeId: ClientId): void {
    const payload = JSON.stringify(message);
    for (const p of this.participants.values()) {
      if (p.clientId === excludeId) continue;
      if (p.socket.readyState === p.socket.OPEN) {
        p.socket.send(payload);
      }
    }
  }
}

export class RoomRegistry {
  private rooms = new Map<string, Room>();

  /** Look up a room without creating one - used on disconnect, where we
   *  never want to accidentally resurrect an already-cleaned-up room. */
  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getOrCreate(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** Drop empty rooms so memory doesn't grow unbounded across many
   *  short-lived rooms over a long server lifetime. */
  cleanupIfEmpty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.isEmpty()) {
      this.rooms.delete(roomId);
    }
  }

  all(): IterableIterator<Room> {
    return this.rooms.values();
  }
}
