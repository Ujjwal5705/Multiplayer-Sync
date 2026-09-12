/**
 * render.ts
 * ---------
 * Pure canvas drawing. Knows nothing about WebSockets, protocol messages,
 * or interpolation math - it only ever receives already-resolved positions
 * (normalized 0..1) and draws pixels. This isolation is what the brief's
 * "code architecture" criterion is asking for: swap interpolation.ts's
 * algorithm entirely and this file doesn't change at all.
 *
 * We deliberately do NOT draw the local user's own cursor - the real OS
 * mouse pointer already shows them where they are (same convention as
 * Figma/Google Docs style cursor demos). Only remote participants get a
 * drawn cursor.
 */

export interface CursorRenderState {
  clientId: string;
  name: string;
  color: string;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  latencyMs?: number;
}

export interface ReactionInstance {
  id: string;
  x: number;
  y: number;
  emoji: string;
  spawnedAt: number; // performance.now() at spawn
}

export const REACTION_LIFETIME_MS = 900;

/** Manages the list of currently-animating reaction bursts. Bounded by
 *  construction: expired reactions are pruned every frame, so this never
 *  grows without limit no matter how long the session runs or how many
 *  taps happen. */
export class ReactionManager {
  private reactions: ReactionInstance[] = [];
  private nextId = 0;

  spawn(x: number, y: number, emoji: string): void {
    this.reactions.push({
      id: `r${this.nextId++}`,
      x,
      y,
      emoji,
      spawnedAt: performance.now(),
    });
  }

  /** Call once per frame before reading `.all()`. */
  prune(now: number): void {
    this.reactions = this.reactions.filter(
      (r) => now - r.spawnedAt < REACTION_LIFETIME_MS,
    );
  }

  all(): readonly ReactionInstance[] {
    return this.reactions;
  }
}

/** Sizes the canvas's backing store for the device pixel ratio so drawing
 *  stays crisp on high-DPI screens, while returning LOGICAL (CSS) width/
 *  height for all the normalized-coordinate math to use. */
export function fitCanvasToContainer(canvas: HTMLCanvasElement): {
  width: number;
  height: number;
} {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  const targetW = width * dpr;
  const targetH = height * dpr;
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  return { width, height };
}

function drawCursor(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cursor: CursorRenderState,
): void {
  // Pointer glyph (a simple rotated teardrop, cheap to draw at 60fps).
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-Math.PI / 8);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 16);
  ctx.lineTo(4.5, 12.5);
  ctx.lineTo(7.5, 18.5);
  ctx.lineTo(10, 17.2);
  ctx.lineTo(7, 11.2);
  ctx.lineTo(12.5, 11.2);
  ctx.closePath();
  ctx.fillStyle = cursor.color;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Name pill label, offset below-right of the cursor tip.
  const label =
    cursor.latencyMs !== undefined
      ? `${cursor.name} · ${Math.max(0, Math.round(cursor.latencyMs))}ms`
      : cursor.name;

  ctx.font = "12px system-ui, sans-serif";
  const paddingX = 6;
  const textWidth = ctx.measureText(label).width;
  const pillW = textWidth + paddingX * 2;
  const pillH = 18;
  const pillX = px + 14;
  const pillY = py + 14;

  ctx.beginPath();
  const radius = 8;
  ctx.moveTo(pillX + radius, pillY);
  ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, radius);
  ctx.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, radius);
  ctx.arcTo(pillX, pillY + pillH, pillX, pillY, radius);
  ctx.arcTo(pillX, pillY, pillX + pillW, pillY, radius);
  ctx.closePath();
  ctx.fillStyle = cursor.color;
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, pillX + paddingX, pillY + pillH / 2 + 1);
}

function drawReaction(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  reaction: ReactionInstance,
  now: number,
): void {
  const progress = Math.min(
    1,
    (now - reaction.spawnedAt) / REACTION_LIFETIME_MS,
  );
  const rise = 40 * progress; // floats upward as it ages
  const scale = 1 + 0.4 * Math.sin(progress * Math.PI); // small pop then settle
  const alpha = 1 - progress; // fades out

  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.font = `${28 * scale}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(reaction.emoji, px, py - rise);
  ctx.restore();
}

/** Draws one full frame. `cursors` should already be the INTERPOLATED
 *  positions for this instant (see interpolation.ts) - this function does
 *  no smoothing itself, it just converts normalized coords to pixels and
 *  paints them. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cursors: CursorRenderState[],
  reactions: readonly ReactionInstance[],
  now: number,
): void {
  ctx.clearRect(0, 0, width, height);

  for (const reaction of reactions) {
    drawReaction(ctx, reaction.x * width, reaction.y * height, reaction, now);
  }

  for (const cursor of cursors) {
    drawCursor(ctx, cursor.x * width, cursor.y * height, cursor);
  }
}
