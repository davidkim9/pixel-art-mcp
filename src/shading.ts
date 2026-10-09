/** Shading & effect helpers (spec §6.6). All functions are pure over index buffers. */

export type DitherPattern = "none" | "checker" | "bayer2" | "bayer4" | "bayer8";
export const LIGHT_DIRECTIONS = [
  "top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right",
] as const;
export type LightDirection = (typeof LIGHT_DIRECTIONS)[number];

const N4: Array<[number, number]> = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const N8: Array<[number, number]> = [...N4, [-1, -1], [1, -1], [-1, 1], [1, 1]];

function neighbor(w: number, h: number, x: number, y: number, dx: number, dy: number, wrap: boolean): number {
  let nx = x + dx;
  let ny = y + dy;
  if (wrap) {
    nx = (nx + w) % w;
    ny = (ny + h) % h;
  } else if (nx < 0 || ny < 0 || nx >= w || ny >= h) return -1;
  return ny * w + nx;
}

export interface OutlineOptions {
  mode: "outside" | "inside";
  connectivity: 4 | 8;
  wrap: boolean;
}

/**
 * Outline positions with the color each should get. `colorFor` receives the
 * adjacent fill colors (outside mode) or the pixel's own color (inside mode).
 */
export function outlineWrites(
  cel: Uint8Array,
  w: number,
  h: number,
  opts: OutlineOptions,
  colorFor: (fillColors: number[]) => number,
): Map<number, number> {
  const writes = new Map<number, number>();
  const dirs = opts.connectivity === 8 ? N8 : N4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const v = cel[p]!;
      if (opts.mode === "outside") {
        if (v !== 0) continue;
        const fills: number[] = [];
        for (const [dx, dy] of dirs) {
          const q = neighbor(w, h, x, y, dx, dy, opts.wrap);
          if (q >= 0 && cel[q] !== 0) fills.push(cel[q]!);
        }
        if (fills.length) writes.set(p, colorFor(fills));
      } else {
        if (v === 0) continue;
        const onEdge = dirs.some(([dx, dy]) => {
          const q = neighbor(w, h, x, y, dx, dy, opts.wrap);
          return q < 0 || cel[q] === 0;
        });
        if (onEdge) writes.set(p, colorFor([v]));
      }
    }
  }
  return writes;
}

/** Most frequent value (ties: first seen). */
export function mostCommon(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0]!;
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** Shadow pixels: every opaque pixel shifted by (dx, dy). */
export function shadowCel(cel: Uint8Array, w: number, h: number, dx: number, dy: number, color: number, wrap: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cel[y * w + x] === 0) continue;
      const q = neighbor(w, h, x, y, dx, dy, wrap);
      if (q >= 0) out[q] = color;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ordered dithering

function bayerMatrix(n: number): number[][] {
  if (n === 1) return [[0]];
  const m = bayerMatrix(n / 2);
  const size = n / 2;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 4 * m[y]![x]!;
      out[y]![x] = v;
      out[y]![x + size] = v + 2;
      out[y + size]![x] = v + 3;
      out[y + size]![x + size] = v + 1;
    }
  }
  return out;
}

const BAYER: Record<number, number[][]> = { 2: bayerMatrix(2), 4: bayerMatrix(4), 8: bayerMatrix(8) };

/** Threshold in (0, 1) for ordered dithering at (x, y). */
export function ditherThreshold(pattern: DitherPattern, x: number, y: number): number {
  switch (pattern) {
    case "none": return 0.5;
    case "checker": return (x + y) & 1 ? 0.75 : 0.25;
    default: {
      const n = pattern === "bayer2" ? 2 : pattern === "bayer4" ? 4 : 8;
      const m = BAYER[n]!;
      const mx = ((x % n) + n) % n;
      const my = ((y % n) + n) % n;
      return (m[my]![mx]! + 0.5) / (n * n);
    }
  }
}

/** Picks a ramp entry for a continuous position s in [0, ramp.length - 1]. */
export function quantizeToRamp(ramp: number[], s: number, pattern: DitherPattern, x: number, y: number): number {
  const max = ramp.length - 1;
  const clamped = Math.min(max, Math.max(0, s));
  if (pattern === "none") return ramp[Math.round(clamped)]!;
  const lo = Math.floor(clamped);
  const f = clamped - lo;
  const idx = Math.min(max, lo + (f > ditherThreshold(pattern, x, y) ? 1 : 0));
  return ramp[idx]!;
}

export interface RadialGradientOptions {
  cx: number;
  cy: number;
  radius: number;
  ramp: number[];
  dither: DitherPattern;
  /** Only recolor pixels that are already non-transparent. */
  onlyOpaque: boolean;
  /** Dark center, light rim (default: light center). */
  invert: boolean;
}

export function radialGradientWrites(cel: Uint8Array, w: number, h: number, o: RadialGradientOptions): Map<number, number> {
  const writes = new Map<number, number>();
  const max = o.ramp.length - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (o.onlyOpaque && cel[p] === 0) continue;
      const d = Math.hypot(x - o.cx, y - o.cy);
      if (d > o.radius) continue;
      const t = o.radius === 0 ? 0 : d / o.radius;
      const v = o.invert ? t : 1 - t;
      writes.set(p, quantizeToRamp(o.ramp, v * max, o.dither, x, y));
    }
  }
  return writes;
}

export function ditherWrites(
  cel: Uint8Array,
  w: number,
  h: number,
  mask: Uint8Array | null,
  c1: number,
  c2: number,
  pattern: Exclude<DitherPattern, "none">,
  ratio: number,
  onlyOpaque: boolean,
): Map<number, number> {
  const writes = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (mask && !mask[p]) continue;
      if (onlyOpaque && cel[p] === 0) continue;
      writes.set(p, ditherThreshold(pattern, x, y) < ratio ? c2 : c1);
    }
  }
  return writes;
}

// ---------------------------------------------------------------------------
// Directional shading

const LIGHT_VECTORS: Record<LightDirection, [number, number]> = {
  "top-left": [-1, -1],
  top: [0, -1],
  "top-right": [1, -1],
  left: [-1, 0],
  right: [1, 0],
  "bottom-left": [-1, 1],
  bottom: [0, 1],
  "bottom-right": [1, 1],
};

/**
 * Basic directional shading: the shape is treated as a dome (height from the
 * distance to its edge, flattening after `rim` pixels), lit by a light from
 * `light` at 45° elevation, and the Lambert term is quantized to the ramp.
 * Flat interiors land on a middle ramp step, edges facing the light on the
 * lightest step and edges facing away on the darkest.
 */
export function shadeWrites(
  shape: Uint8Array,
  w: number,
  h: number,
  ramp: number[],
  light: LightDirection,
  rim?: number,
): Map<number, number> {
  const writes = new Map<number, number>();
  const dist = new Float64Array(w * h);
  const queue: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!shape[p]) continue;
      const edge = N4.some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx < 0 || ny < 0 || nx >= w || ny >= h || !shape[ny * w + nx];
      });
      if (edge) {
        dist[p] = 1;
        queue.push(p);
      }
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    const x = p % w;
    const y = (p - x) / w;
    for (const [dx, dy] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (shape[q] && dist[q] === 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  let dmax = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i]! > dmax) dmax = dist[i]!;
  if (dmax === 0) return writes;
  const r = Math.max(1, rim ?? Math.min(dmax, 8));
  const height = new Float64Array(w * h);
  for (let i = 0; i < dist.length; i++) {
    if (!shape[i]) continue;
    const t = 1 - Math.min(dist[i]!, r) / r;
    height[i] = r * Math.sqrt(Math.max(0, 1 - t * t));
  }
  const hAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : height[y * w + x]!);
  const [lx, ly] = LIGHT_VECTORS[light];
  const lz = 1;
  const llen = Math.hypot(lx, ly, lz);
  const k = ramp.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!shape[p]) continue;
      const nx = (hAt(x - 1, y) - hAt(x + 1, y)) / 2;
      const ny = (hAt(x, y - 1) - hAt(x, y + 1)) / 2;
      const nlen = Math.hypot(nx, ny, 1);
      const lambert = Math.max(0, (nx * lx + ny * ly + lz) / (nlen * llen));
      const intensity = 0.2 + 0.8 * lambert;
      writes.set(p, ramp[Math.min(k - 1, Math.floor(intensity * k))]!);
    }
  }
  return writes;
}

/** Opaque pixels with no opaque pixel among their 8 neighbors. */
export function findOrphans(cel: Uint8Array, w: number, h: number, wrap: boolean): Array<{ x: number; y: number; c: number }> {
  const out: Array<{ x: number; y: number; c: number }> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = cel[y * w + x]!;
      if (v === 0) continue;
      const lonely = N8.every(([dx, dy]) => {
        const q = neighbor(w, h, x, y, dx, dy, wrap);
        return q < 0 || q === y * w + x || cel[q] === 0;
      });
      if (lonely) out.push({ x, y, c: v });
    }
  }
  return out;
}
