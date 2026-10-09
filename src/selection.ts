import type { Rect } from "./types.js";
import { floodRegion } from "./raster.js";

export type SelectMode = "replace" | "add" | "subtract" | "intersect";

export function combineMasks(prev: Uint8Array | undefined, next: Uint8Array, mode: SelectMode): Uint8Array {
  if (mode === "replace" || !prev) return mode === "subtract" ? new Uint8Array(next.length) : next;
  const out = new Uint8Array(next.length);
  for (let i = 0; i < out.length; i++) {
    const a = prev[i]! !== 0;
    const b = next[i]! !== 0;
    out[i] = (mode === "add" ? a || b : mode === "subtract" ? a && !b : a && b) ? 1 : 0;
  }
  return out;
}

export function rectMask(w: number, h: number, r: Rect): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) {
    for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.w); x++) mask[y * w + x] = 1;
  }
  return mask;
}

/** Magic wand: contiguous region around a seed, or every pixel of the index. */
export function colorMask(
  cel: Uint8Array,
  w: number,
  h: number,
  index: number,
  contiguous: boolean,
  seed: { x: number; y: number } | undefined,
  wrap: boolean,
): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (contiguous && seed) {
    if (cel[seed.y * w + seed.x] !== index) return mask;
    for (const p of floodRegion(cel, w, h, seed.x, seed.y, wrap)) mask[p] = 1;
    return mask;
  }
  for (let i = 0; i < cel.length; i++) if (cel[i] === index) mask[i] = 1;
  return mask;
}

export function contentMask(cel: Uint8Array): Uint8Array {
  const mask = new Uint8Array(cel.length);
  for (let i = 0; i < cel.length; i++) if (cel[i] !== 0) mask[i] = 1;
  return mask;
}

export function maskBounds(mask: Uint8Array, w: number, h: number): Rect | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function maskCount(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/** Bounding box of non-transparent pixels. */
export function contentBounds(pixels: Uint8Array, w: number, h: number): Rect | null {
  return maskBounds(pixels, w, h);
}

function place(w: number, h: number, x: number, y: number, wrap: boolean): number {
  if (wrap) return (((y % h) + h) % h) * w + (((x % w) + w) % w);
  if (x < 0 || y < 0 || x >= w || y >= h) return -1;
  return y * w + x;
}

export interface TransformResult {
  cel: Uint8Array;
  mask: Uint8Array;
  /** Selected pixels that left the canvas (wrap off). */
  clipped: number;
}

/**
 * Moves/transforms the selected pixels. `map` gives each selected pixel's
 * destination. Selected pixels are lifted (left transparent) and the
 * non-transparent ones are dropped at their destinations.
 */
function transformSelected(
  cel: Uint8Array,
  mask: Uint8Array,
  w: number,
  h: number,
  wrap: boolean,
  map: (x: number, y: number) => [number, number],
): TransformResult {
  const out = cel.slice();
  const newMask = new Uint8Array(w * h);
  const moves: Array<[number, number]> = [];
  let clipped = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const x = p % w;
    const y = (p - x) / w;
    const [nx, ny] = map(x, y);
    const q = place(w, h, nx, ny, wrap);
    out[p] = 0;
    if (q < 0) {
      if (cel[p] !== 0) clipped++;
      continue;
    }
    newMask[q] = 1;
    moves.push([q, cel[p]!]);
  }
  for (const [q, v] of moves) if (v !== 0) out[q] = v;
  return { cel: out, mask: newMask, clipped };
}

export function moveSelected(cel: Uint8Array, mask: Uint8Array, w: number, h: number, dx: number, dy: number, wrap: boolean): TransformResult {
  return transformSelected(cel, mask, w, h, wrap, (x, y) => [x + dx, y + dy]);
}

export function flipSelected(cel: Uint8Array, mask: Uint8Array, w: number, h: number, axis: "horizontal" | "vertical"): TransformResult {
  const b = maskBounds(mask, w, h);
  if (!b) return { cel: cel.slice(), mask: mask.slice(), clipped: 0 };
  return transformSelected(cel, mask, w, h, false, (x, y) =>
    axis === "horizontal" ? [b.x + b.w - 1 - (x - b.x), y] : [x, b.y + b.h - 1 - (y - b.y)],
  );
}

/** Rotates the selection clockwise by 90° × times around the center of its bounds. */
export function rotateSelected(cel: Uint8Array, mask: Uint8Array, w: number, h: number, times: number, wrap: boolean): TransformResult {
  const b = maskBounds(mask, w, h);
  const t = ((times % 4) + 4) % 4;
  if (!b || t === 0) return { cel: cel.slice(), mask: mask.slice(), clipped: 0 };
  const odd = t % 2 === 1;
  const rw = odd ? b.h : b.w;
  const rh = odd ? b.w : b.h;
  const ox = b.x + Math.floor((b.w - rw) / 2);
  const oy = b.y + Math.floor((b.h - rh) / 2);
  return transformSelected(cel, mask, w, h, wrap, (x, y) => {
    const u = x - b.x;
    const v = y - b.y;
    let nu: number;
    let nv: number;
    if (t === 1) [nu, nv] = [b.h - 1 - v, u];
    else if (t === 2) [nu, nv] = [b.w - 1 - u, b.h - 1 - v];
    else [nu, nv] = [v, b.w - 1 - u];
    return [ox + nu, oy + nv];
  });
}

/** Shifts a whole cel. With wrap, pixels leaving one edge enter the opposite edge. */
export function offsetCel(cel: Uint8Array, w: number, h: number, dx: number, dy: number, wrap: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = place(w, h, x + dx, y + dy, wrap);
      if (q >= 0) out[q] = cel[y * w + x]!;
    }
  }
  return out;
}

/** Square-image dihedral transforms used by tileset generation. */
export const DIHEDRAL = ["identity", "flipH", "flipV", "rot180", "rot90", "rot270", "transpose", "antitranspose"] as const;
export type Dihedral = (typeof DIHEDRAL)[number];

/** Where (x, y) lands under a transform of an (n+1)×(n+1) square. rot90 is clockwise. */
export function transformPoint(x: number, y: number, n: number, t: Dihedral): [number, number] {
  switch (t) {
    case "identity": return [x, y];
    case "flipH": return [n - x, y];
    case "flipV": return [x, n - y];
    case "rot90": return [n - y, x];
    case "rot180": return [n - x, n - y];
    case "rot270": return [y, n - x];
    case "transpose": return [y, x];
    default: return [n - y, n - x];
  }
}

export function transformSquare(src: Uint8Array, size: number, t: Dihedral): Uint8Array {
  const out = new Uint8Array(size * size);
  const n = size - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [nx, ny] = transformPoint(x, y, n, t);
      out[ny * size + nx] = src[y * size + x]!;
    }
  }
  return out;
}
