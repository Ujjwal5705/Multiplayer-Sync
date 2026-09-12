# Real-Time Multiplayer Cursor/State Sync

A live, multi-tab cursor + reaction sync built on raw WebSockets, with a
hand-rolled protocol, client-side interpolation, and an honest, minimal
server. No Socket.IO, Yjs, PartyKit, Liveblocks, or any other sync
library — see `ARCHITECTURE.md` for the full design writeup.

**Live demo:** https://multiplayer-sync-1.onrender.com
**Server health check:** https://multiplayer-sync.onrender.com/health

## Setup

Requires Node.js 18+.

### 1. Start the server

```bash
cd server
npm install
npm run dev
```

You should see:
```
multiplayer-sync server listening on :8080 (ws path: /ws)
```

### 2. Start the client

In a second terminal:

```bash
cd client
npm install
npm run dev
```

Open the printed URL (typically `http://localhost:5173`). The Vite dev
server proxies `/ws` through to the backend on `:8080` (see
`client/vite.config.ts`), so no extra configuration is needed locally.

### 3. Test with multiple clients

Open the same URL in **3-5 separate browser tabs** (use "new tab", not
"duplicate tab" — see the note in `App.tsx`'s `getOrCreateClientId` about
why duplicated tabs need a moment's care). Join each with a different name
and the same Room ID (defaults to `watch-party-42`). Move your mouse in one
tab and watch it appear, smoothly, in the others. Click anywhere on the
stage to drop a reaction.

There's also a **"Simulate lag" slider** in the bottom dock — drag it up to
artificially delay/jitter incoming messages and see the interpolation hold
up, without needing to fight with browser DevTools network throttling
(which only affects newly-opened connections and is inconsistent across
browsers).

## Known limitations

- **No persistence.** Restarting the server drops all rooms and presence.
  There is nothing to restore — it's an intentionally in-memory relay.
- **No horizontal scaling.** This is a single Node process holding all room
  state in memory; see `ARCHITECTURE.md` for a written (not implemented)
  discussion of how this would need to change to scale out.
- **No authentication / access control.** Room IDs are a shared secret at
  best. Anyone with the ID can join (matches the brief's "no auth needed").
- **Dead-connection detection is bounded, not instant.** A truly dead socket
  (cable pulled, laptop lid closed) is detected within ~15-30s via
  heartbeat ping/pong, not immediately. A clean tab close is detected
  immediately via the `close` event.
- **No shared types package.** `protocol.ts` is duplicated verbatim between
  `server/src/protocol.ts` and `client/src/protocol.ts` since the brief
  doesn't require a monorepo. If the protocol changes, both copies need to
  be updated together.
- **Per-client latency is only measured for yourself.** We show your own
  round-trip ping to the server, not each remote peer's ping to the server —
  the protocol doesn't currently relay that number between clients (a
  a straightforward extension: the server could periodically broadcast
  each connected client's last-measured RTT).
- **Two action types.** Per the brief's own guidance ("a small, correct,
  smooth 2-action demo beats a large, janky one"), only cursor movement and
  a single tap-to-react action are implemented.

## AI tool disclosure

This project was built with the help of Claude, used for:
- Architecture/design discussion and protocol design tradeoffs
- Writing the initial implementation of each file
- Debugging two real issues hit during testing: a Vite dev-server/WebSocket
  origin mismatch (`vite.config.ts` proxy), and a `sessionStorage`
  duplicate-tab collision that caused two browser tabs to share the same
  `clientId` (fixed via `App.tsx`'s reload-detection logic)

All code was reviewed, tested manually across multiple browser tabs.

## Time spent

6 Hours