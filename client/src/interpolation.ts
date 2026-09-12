/**
 * interpolation.ts
 * ----------------
 * Strategy chosen: small delay-buffer interpolation.
 *
 * Instead of drawing a remote cursor at the position of the LAST message we
 * received (which snaps/teleports whenever network timing is irregular), we
 * deliberately render slightly in the past: `RENDER_DELAY_MS` behind now.
 * By the time we need to draw that past instant, we usually already have
 * TWO real samples straddling it, so we can linearly interpolate between
 * them instead of guessing.
 *
 * Tradeoff (documented per the brief's requirement):
 * - Cost: every remote cursor is always ~100ms "behind" real time. That is
 *   the price of smoothness and is a deliberate, tunable constant.
 * - Benefit: motion is smooth even when packets arrive at irregular
 *   intervals (throttled 30Hz sender, plus jitter from the network), because
 *   we're always interpolating between two REAL known points rather than
 *   snapping to whatever arrived most recently.
 * - Fallback: if the network stalls long enough that we run out of buffered
 *   samples ahead of the render time, we extrapolate forward from the last
 *   known velocity - capped at MAX_EXTRAPOLATION_MS so a cursor doesn't fly
 *   off to infinity during a long stall. Past that cap we freeze in place,
 *   which is preferable to guessing wildly wrong.
 *
 * Memory bound: each client's buffer is capped at MAX_BUFFER_SAMPLES and we
 * additionally drop samples once they're too old to ever be needed again,
 * so a long-running session does not accumulate unbounded history.
 */

export interface PositionSample {
  x: number;
  y: number;
  t: number; // sender's clock at capture time (protocol's `t`)
  seq: number;
}

export const RENDER_DELAY_MS = 10;
const MAX_EXTRAPOLATION_MS = 250;
const MAX_BUFFER_SAMPLES = 8;

interface ClientBuffer {
  samples: PositionSample[]; // ascending by t
  lastSeq: number;
}

export class CursorInterpolator {
  private buffers = new Map<string, ClientBuffer>();

  /** Feed a freshly received remote sample. Silently ignores anything
   *  older than what we've already buffered for that sender (defense in
   *  depth - the server already drops stale sequence numbers before
   *  relaying, but a client should never trust the network to be tidy). */
  pushSample(clientId: string, sample: PositionSample): void {
    let buf = this.buffers.get(clientId);
    if (!buf) {
      buf = { samples: [], lastSeq: -1 };
      this.buffers.set(clientId, buf);
    }
    if (sample.seq <= buf.lastSeq && buf.samples.length > 0) return;
    buf.lastSeq = sample.seq;

    buf.samples.push(sample);
    if (buf.samples.length > MAX_BUFFER_SAMPLES) {
      buf.samples.shift();
    }
  }

  /** Removes all buffered history for a client (call on peer_left) so
   *  memory doesn't grow across the lifetime of a long session with many
   *  join/leave churns. */
  removeClient(clientId: string): void {
    this.buffers.delete(clientId);
  }

  clientIds(): string[] {
    return [...this.buffers.keys()];
  }

  /** Returns the best-known interpolated/extrapolated position for
   *  `clientId` at wall-clock `now` (i.e. Date.now()), or null if we have
   *  no data yet for that client. */
  sample(clientId: string, now: number): { x: number; y: number } | null {
    const buf = this.buffers.get(clientId);
    if (!buf || buf.samples.length === 0) return null;

    const renderTime = now - RENDER_DELAY_MS;
    const samples = buf.samples;

    // Prune anything that can no longer be useful: once a sample's time is
    // older than TWO samples back from renderTime, nothing will ever
    // bracket it again with a newer one. Keep at least 2 for interpolation.
    while (samples.length > 2 && samples[1].t < renderTime) {
      samples.shift();
    }

    if (samples.length === 1) {
      return { x: samples[0].x, y: samples[0].y };
    }

    // Case 1: renderTime falls at or before our oldest sample - just joined,
    // or the buffer only has "future" samples relative to renderTime yet.
    const first = samples[0];
    if (renderTime <= first.t) {
      return { x: first.x, y: first.y };
    }

    // Case 2: find two consecutive samples that bracket renderTime and lerp.
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      if (renderTime >= a.t && renderTime <= b.t) {
        const span = b.t - a.t;
        const frac = span > 0 ? (renderTime - a.t) / span : 1;
        return {
          x: a.x + (b.x - a.x) * frac,
          y: a.y + (b.y - a.y) * frac,
        };
      }
    }

    // Case 3: renderTime is past our newest sample - the network has
    // stalled or the sender stopped moving recently. Extrapolate forward
    // from the last known velocity, capped so we don't run away forever.
    const last = samples[samples.length - 1];
    const prev = samples[samples.length - 2];
    const dt = last.t - prev.t;
    const overshoot = Math.min(renderTime - last.t, MAX_EXTRAPOLATION_MS);

    if (dt <= 0) {
      return { x: last.x, y: last.y };
    }
    const vx = (last.x - prev.x) / dt;
    const vy = (last.y - prev.y) / dt;
    return {
      x: last.x + vx * overshoot,
      y: last.y + vy * overshoot,
    };
  }
}
