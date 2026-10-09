import type { Point } from "../types.js";
import { check } from "../util/errors.js";

export interface Size {
  w: number;
  h: number;
}

export interface AtlasLayout {
  width: number;
  height: number;
  positions: Point[];
}

/** One row, `padding` pixels around and between frames. */
export function layoutRow(sizes: Size[], padding: number): AtlasLayout {
  let x = padding;
  const positions: Point[] = [];
  for (const s of sizes) {
    positions.push({ x, y: padding });
    x += s.w + padding;
  }
  const maxH = Math.max(1, ...sizes.map((s) => s.h));
  return { width: Math.max(x, 1), height: maxH + padding * 2, positions };
}

/** Uniform grid of cells (cell = largest frame), row-major. */
export function layoutGrid(sizes: Size[], padding: number, columns?: number, margin = padding): AtlasLayout {
  const n = sizes.length;
  const cols = Math.max(1, Math.min(n, columns ?? Math.ceil(Math.sqrt(n))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const cw = Math.max(1, ...sizes.map((s) => s.w));
  const ch = Math.max(1, ...sizes.map((s) => s.h));
  const positions = sizes.map((_, i) => ({
    x: margin + (i % cols) * (cw + padding),
    y: margin + Math.floor(i / cols) * (ch + padding),
  }));
  return {
    width: margin * 2 + cols * cw + (cols - 1) * padding,
    height: margin * 2 + rows * ch + (rows - 1) * padding,
    positions,
  };
}

/**
 * Deterministic shelf packing: frames sorted by height (then width, then
 * index), shelves filled left to right up to a roughly square width.
 */
export function layoutPacked(sizes: Size[], padding: number): AtlasLayout {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b]!.h - sizes[a]!.h || sizes[b]!.w - sizes[a]!.w || a - b);
  const area = sizes.reduce((sum, s) => sum + (s.w + padding) * (s.h + padding), 0);
  const maxW = Math.max(1, ...sizes.map((s) => s.w));
  const targetW = Math.max(maxW + padding * 2, Math.ceil(Math.sqrt(area)) + padding);
  const positions: Point[] = new Array(sizes.length);
  let x = padding;
  let y = padding;
  let shelfH = 0;
  let width = 1;
  for (const i of order) {
    const s = sizes[i]!;
    if (x > padding && x + s.w + padding > targetW) {
      y += shelfH + padding;
      x = padding;
      shelfH = 0;
    }
    positions[i] = { x, y };
    x += s.w + padding;
    width = Math.max(width, x);
    shelfH = Math.max(shelfH, s.h);
  }
  return { width, height: Math.max(1, y + shelfH + padding), positions };
}

export function checkPaddingExtrude(padding: number, extrude: number): void {
  check(Number.isInteger(padding) && padding >= 0, "padding must be a non-negative integer");
  check(Number.isInteger(extrude) && extrude >= 0, "extrude must be a non-negative integer");
  check(extrude * 2 <= padding, `extrude (${extrude}) needs padding of at least ${extrude * 2} (got ${padding}) so extruded edges don't overlap`);
}

/**
 * Builds an indexed atlas. Each frame's edge pixels are duplicated `extrude`
 * pixels outward into the padding (prevents texture bleeding).
 */
export function buildAtlas(
  frames: Array<{ pixels: Uint8Array; w: number; h: number }>,
  layout: AtlasLayout,
  extrude: number,
): Uint8Array {
  const W = layout.width;
  const out = new Uint8Array(layout.width * layout.height);
  const put = (x: number, y: number, v: number) => {
    if (x >= 0 && y >= 0 && x < layout.width && y < layout.height) out[y * W + x] = v;
  };
  frames.forEach((f, i) => {
    const { x: ox, y: oy } = layout.positions[i]!;
    if (f.w === 0 || f.h === 0) return;
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) put(ox + x, oy + y, f.pixels[y * f.w + x]!);
    for (let e = 1; e <= extrude; e++) {
      for (let y = 0; y < f.h; y++) {
        put(ox - e, oy + y, f.pixels[y * f.w]!);
        put(ox + f.w - 1 + e, oy + y, f.pixels[y * f.w + f.w - 1]!);
      }
    }
    for (let e = 1; e <= extrude; e++) {
      for (let x = -extrude; x < f.w + extrude; x++) {
        const sx = Math.min(f.w - 1, Math.max(0, x));
        put(ox + x, oy - e, f.pixels[sx]!);
        put(ox + x, oy + f.h - 1 + e, f.pixels[(f.h - 1) * f.w + sx]!);
      }
    }
  });
  return out;
}

/** Crops a w×h index buffer. */
export function crop(pixels: Uint8Array, w: number, r: { x: number; y: number; w: number; h: number }): Uint8Array {
  const out = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) out.set(pixels.subarray((r.y + y) * w + r.x, (r.y + y) * w + r.x + r.w), y * r.w);
  return out;
}
