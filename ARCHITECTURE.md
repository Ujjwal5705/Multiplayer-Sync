# Architecture

## Code layout

```
multiplayer-sync-assignment/
├── server/src/
│   ├── protocol.ts      # message types + runtime validators (shared w/ client, duplicated)
│   ├── room.ts          # presence, ordering, broadcast fan-out - the "sync engine"
│   └── server.ts        # transport plumbing: HTTP+WS, heartbeat, connection lifecycle
├── client/src/
│   ├── protocol.ts      # identical copy of server/src/protocol.ts
│   ├── connection.ts    # createRoom(): the ONLY file touching the WebSocket API
│   ├── interpolation.ts # delay-buffer smoothing of remote positions
│   ├── render.ts        # pure canvas drawing, no networking knowledge
│   └── App.tsx          # wires the above together + React UI chrome
```

Each layer only knows about the one below it through a narrow interface:
`App.tsx` never touches `WebSocket` directly, `render.ts` never touches
network messages, and `interpolation.ts` never touches the DOM. Adding a
new action type (e.g. "poke") means: add a variant to `protocol.ts`, add a
line to `OUTGOING_THROTTLE_MS` in `connection.ts`, add a case to `deliver()`
and `room.ts`'s apply logic, and add a render case in `render.ts`. Nothing
about the transport, heartbeat, or reconnect logic changes.

## Why `ws` (npm) instead of hand-rolling RFC 6455 framing

The brief prohibits real-time *sync* libraries (Socket.IO, Yjs, PartyKit,
Liveblocks, Ably, Pusher) because those do the interesting part - rooms,
state reconciliation, broadcast - for you. `ws` does none of that: it is
purely a WebSocket protocol (RFC 6455) frame encoder/decoder, exposing
`send`/`message`/`close`/`error`/`ping`/`pong` and nothing else. Node has no
built-in WebSocket server API, so some implementation of the wire protocol
is unavoidable; writing our own byte-level frame parser would not
demonstrate anything about sync engine design (the actual subject of this
assignment) and was judged out of scope. Every bit of room management,
presence, ordering, and broadcast logic in `room.ts` and `server.ts` is
hand-written.

## Protocol design

All types live in `protocol.ts` as a discriminated union on `type`.

**Client -> Server:**

| type | shape | notes |
|---|---|---|
| `join` | `{ type, roomId, clientId, name? }` | first message on any connection |
| `cursor` | `{ type, seq, x, y, t }` | `x`/`y` normalized 0..1 |
| `reaction` | `{ type, seq, x, y, emoji, t }` | discrete, immediate |
| `ping` | `{ type, t }` | app-level RTT probe, distinct from WS-frame ping/pong |

**Server -> Client:**

| type | shape | notes |
|---|---|---|
| `welcome` | `{ type, selfId, color, serverTime, participants[] }` | sent once, right after join |
| `peer_joined` | `{ type, clientId, name, color, x, y }` | broadcast to existing members |
| `peer_left` | `{ type, clientId }` | broadcast on disconnect/leave |
| `cursor` | `{ type, clientId, seq, x, y, t }` | relayed, sender excluded |
| `reaction` | `{ type, clientId, seq, x, y, emoji, t }` | relayed, sender excluded |
| `pong` | `{ type, t }` | echoes the client's `ping.t` |
| `error` | `{ type, reason }` | malformed/unknown input, or protocol violation |

Coordinates are normalized (0..1 fractions of the shared surface) so the
protocol is resolution-independent - a 4K monitor and a phone agree on
"where" a point is without either side needing to know the other's
viewport size.

### Throttling / batching

Raw `mousemove` fires at 60-120Hz depending on hardware. Sending every
event would be roughly 2-4x more network traffic than needed for a visually
indistinguishable result. `connection.ts` enforces, client-side:

- **A hard rate cap per action type** (`OUTGOING_THROTTLE_MS`): cursor
  updates are capped at ~30Hz (33ms between sends); reactions are discrete
  and rare, so they're sent immediately with no cap.
- **A minimum-movement threshold** (`MIN_CURSOR_DELTA`): even within the
  33ms window, if the cursor has moved less than 0.25% of the canvas since
  the last *sent* sample, we skip sending - a stationary mouse costs zero
  bandwidth instead of ~30 messages/sec of noise.

This is a client-side policy, not a server-enforced one: the server trusts
the client's pacing rather than re-throttling on receipt, since re-checking
timing server-side would only catch a misbehaving client, which is out of
scope for a no-auth, no-adversarial-clients assignment (documented as a
limitation, not an oversight).

### What lives on the server vs. what's purely relayed

The server is the source of truth for exactly three things: **who is in a
room**, **each participant's last known position/color/name** (needed to
build a snapshot for late joiners), and **the highest sequence number seen
per client per stream** (needed to reject stale/out-of-order messages).
Everything else - the actual cursor motion, the reaction bursts - is purely
relayed: the server does not interpret, store history of, or replay past
positions/reactions. This keeps the server "simple and honest": it is a
stateful presence directory + relay, not a simulation authority.

## Interpolation strategy

**Chosen approach: small delay-buffer interpolation** (`interpolation.ts`).

Rather than rendering a remote cursor at the position of the most recently
received message (which visibly snaps whenever two updates arrive close
together after a gap), we deliberately render `RENDER_DELAY_MS` (100ms)
*behind* real time. By the time we need to draw that past instant, we
usually already have two real, bracketing samples to linearly interpolate
between - so motion is reconstructed from real data rather than
extrapolated blindly from a single stale point.

**Fallback: bounded extrapolation.** If the network stalls long enough that
the render time runs past the newest buffered sample, we project forward
using the last known velocity, capped at `MAX_EXTRAPOLATION_MS` (250ms).
Past that cap, the cursor freezes rather than continuing to guess - a
frozen cursor reads as "they stopped," which is honest; a cursor that flew
off-screen during a 5-second stall would not be.

**Tradeoff:** every remote cursor is always ~100ms behind the sender's real
position. This is a deliberate, tunable cost:
- Lower `RENDER_DELAY_MS` (e.g. 10-30ms) -> snappier, but any jitter in
  packet arrival becomes visible as micro-stutters, because there's less
  buffer to smooth over.
- Higher `RENDER_DELAY_MS` (e.g. 150-250ms) -> smoother under worse jitter,
  but the cursor visibly lags the real mouse more.
- 100ms was chosen as a reasonable middle ground for a ~30Hz send rate
  (roughly 3 update intervals of buffer) and confirmed visually smooth even
  with an in-app-simulated 300-400ms of added lag/jitter (see the "Simulate
  lag" slider in the demo UI, built specifically because browser DevTools
  network throttling only affects newly-opened connections and behaves
  inconsistently across browsers - unreliable for a live interview demo).

**Memory bound:** each remote client's sample buffer is capped at 8 entries
and aggressively pruned once a sample can no longer bracket any future
render time, so a multi-hour session does not accumulate unbounded history.

## Ordering / conflict handling

Every `cursor` and `reaction` message carries a per-sender, per-stream
monotonic `seq`. The server (`room.ts`) tracks the highest `seq` accepted
per client per stream and **silently drops** anything at or below that
watermark before relaying - this is the concrete handling of "messages
arrive out of order." The client's interpolator (`interpolation.ts`) also
independently ignores anything at or below the highest `seq` it has already
buffered for that sender, as defense-in-depth in case a future transport
change (e.g. multiple relay hops) reintroduces reordering that a single
TCP-backed WebSocket connection wouldn't otherwise produce.

There is no "conflict resolution" beyond ordering, because cursor and
reaction actions do not have any shared mutable state to conflict over -
each participant only ever writes their own position/reactions, and the
server never merges two clients' updates into one value. Two clients
tapping the same point at the same time simply produces two independent
reaction bursts, which is the honest, correct outcome for this data model
(there is nothing to reconcile - see the "bonus points" note below on why
implementing conflict reconciliation wasn't applicable here).

## Failure handling

| Scenario | Behavior |
|---|---|
| **Malformed/unknown message** | `parseClientMessage`/`parseServerMessage` return `null`; the message is dropped and (client->server) an `error` reply is sent. Never crashes, never silently "guesses" a shape. |
| **Out-of-order/duplicate `seq`** | Dropped by the server before relay, and independently by the client's interpolator. |
| **Clean tab close** | WebSocket `close` fires immediately -> `room.leave()` -> `peer_left` broadcast -> other clients' interpolators are cleaned up (`removeClient`). |
| **Dropped connection (no clean close)** | Detected via heartbeat: every 15s the server pings all sockets; a socket that didn't answer the *previous* ping is `terminate()`d, which fires `close` and runs the same cleanup path. Worst-case ghost time: ~30s. |
| **Client-side network drop** | `connection.ts` detects `onclose`, retries with exponential backoff (500ms -> 1s -> 2s -> 4s, capped at 5s), and resends `join` with the *same* `clientId` on reopen, which the server treats as a resume (`Room.join`'s existing-clientId branch swaps in the new socket instead of creating a duplicate participant). |
| **Reconnect creating a duplicate tab's identity** | Caught during real testing: browsers **clone `sessionStorage` when a tab is duplicated**, which collided two demo tabs onto the same `clientId` and made the server correctly (per its resume logic) treat them as one person. Fixed in `App.tsx` by only trusting the stored id on a genuine same-tab reload (detected via `PerformanceNavigationTiming.type === "reload"`); any other navigation mints a fresh id. |

## Bonus items status

- Done - **extrapolation**: implemented, capped at 250ms (see interpolation section above).
- Done - **per-client latency visualization**: implemented for the local client's own RTT to the server (shown in the dock). Not implemented: relaying *other* clients' RTT to everyone, which would need a small protocol addition (server periodically broadcasts each participant's last measured RTT).
- Not done - **adaptive throttling based on measured RTT**: straightforward extension - feed the `onLatency` callback's value into `OUTGOING_THROTTLE_MS`'s cursor entry, raising the interval under high RTT to avoid piling up a queue of stale updates.
- Not applicable - **conflict reconciliation for simultaneous actions**: see the "Ordering / conflict handling" section above for why this data model doesn't produce conflicts to reconcile.
- Done - **horizontal scaling discussion** (written only, per the brief), below.

### If this needed to scale beyond one process

The current design keeps all room state in one Node process's memory,
which is why `room.size` and broadcast are both simple, synchronous, and
fast - but it also means a room's participants must all be connected to
the *same* process. To scale horizontally:

1. **Move room membership + last-known-position to a shared store**
   (Redis is the natural fit): `HSET room:{id} client:{id} '{x,y,color,...}'`.
   Any server process can then answer "who's in this room" without owning
   all its sockets.
2. **Replace the in-process `broadcast()` with a pub/sub fan-out**: each
   server process subscribes to a Redis channel (or NATS subject) per room
   it has at least one local socket in, and republishes any message it
   receives locally to that channel; every process subscribed to the
   channel relays it to its own locally-connected sockets for that room.
   This turns the current O(n) in-memory loop into "O(local n) plus one
   publish," which scales because rooms are (per the brief) small - 3-10
   clients - so most rooms would live entirely on one process most of the
   time anyway, and cross-process fan-out is the exception, not the rule.
3. **Sticky sessions or a connection-aware load balancer** would still be
   needed at the WebSocket layer itself (a client's single long-lived
   connection can't be transparently moved between processes mid-session
   the way a stateless HTTP request can).
4. **Sequence-number ordering would need to become room-scoped** rather
   than per-process, since two processes could otherwise assign
   overlapping meaning to "seq" - in practice this is already fine as-is,
   since `seq` is generated client-side per sender, not server-side, so it
   doesn't need any change to remain correct across processes.