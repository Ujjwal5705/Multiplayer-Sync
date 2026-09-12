/**
 * server.ts
 * ---------
 * Minimal HTTP + WebSocket server. `ws` is used ONLY as the RFC-6455 frame
 * implementation (Node has no built-in WebSocket server) - every bit of
 * room/presence/protocol/heartbeat logic below is ours. See ARCHITECTURE.md
 * for why this is a defensible reading of "no ws-free" vs. "no sync library."
 *
 * Connection lifecycle:
 *  1. Client opens the socket, then sends a `join` message (first message).
 *  2. We validate it, register them in a Room, and reply with `welcome`
 *     (full snapshot of current participants).
 *  3. From then on, `cursor` / `reaction` / `ping` messages are validated,
 *     ordering-checked, and fanned out by the Room.
 *  4. A ping/pong heartbeat detects half-open connections (cable pulled,
 *     laptop lid closed) that never fire a clean 'close' event.
 */

import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RoomRegistry } from "./room.js";
import { parseClientMessage, type ServerMessage } from "./protocol.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HEARTBEAT_INTERVAL_MS = 15_000;

const registry = new RoomRegistry();

interface SocketMeta {
  roomId: string;
  clientId: string;
  isAlive: boolean;
}
const socketMeta = new Map<WebSocket, SocketMeta>();

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function sendError(ws: WebSocket, reason: string): void {
  send(ws, { type: "error", reason });
}

function handleJoin(
  ws: WebSocket,
  roomId: string,
  clientId: string,
  name?: string,
): void {
  const room = registry.getOrCreate(roomId);
  const participants = room.join(clientId, name, ws);
  const color = room.getColor(clientId)!;

  socketMeta.set(ws, { roomId, clientId, isAlive: true });

  send(ws, {
    type: "welcome",
    selfId: clientId,
    color,
    serverTime: Date.now(),
    participants,
  });
}

function handleClose(ws: WebSocket): void {
  const meta = socketMeta.get(ws);
  socketMeta.delete(ws);
  if (!meta) return;

  const room = registry.get(meta.roomId);
  if (room) {
    room.leave(meta.clientId);
    registry.cleanupIfEmpty(meta.roomId);
  }
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (raw) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString());
    } catch {
      sendError(ws, "malformed json");
      return;
    }

    const msg = parseClientMessage(parsedJson);
    if (!msg) {
      sendError(ws, "unknown or malformed message type");
      return;
    }

    if (msg.type === "join") {
      handleJoin(ws, msg.roomId, msg.clientId, msg.name);
      return;
    }

    const meta = socketMeta.get(ws);
    if (!meta) {
      sendError(ws, "must send 'join' before any other message");
      return;
    }
    meta.isAlive = true; // any traffic counts as a liveness signal

    const room = registry.getOrCreate(meta.roomId);
    switch (msg.type) {
      case "cursor":
        room.applyCursor(meta.clientId, msg);
        break;
      case "reaction":
        room.applyReaction(meta.clientId, msg);
        break;
      case "ping":
        send(ws, { type: "pong", t: msg.t });
        break;
    }
  });

  ws.on("pong", () => {
    const meta = socketMeta.get(ws);
    if (meta) meta.isAlive = true;
  });

  ws.on("close", () => handleClose(ws));

  // 'error' is typically followed by 'close' for the same socket, so we
  // don't duplicate cleanup here - just avoid an unhandled-error crash.
  ws.on("error", () => {});
});

// Heartbeat sweep: every interval, ping everyone; anyone who didn't answer
// the PREVIOUS ping (isAlive still false) is terminated. This bounds how
// long a half-open connection's cursor can linger to ~2x the interval.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const meta = socketMeta.get(ws);
    if (meta && !meta.isAlive) {
      ws.terminate(); // fires 'close' -> handleClose does the cleanup
      continue;
    }
    if (meta) meta.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

httpServer.listen(PORT, () => {
  console.log(`multiplayer-sync server listening on :${PORT} (ws path: /ws)`);
});

process.on("SIGTERM", () => {
  clearInterval(heartbeat);
  wss.close();
  httpServer.close(() => process.exit(0));
});
