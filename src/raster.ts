import type { Document, SymmetryState } from "./types.js";

export function isWrapEnabled(doc: Document): boolean {
  return doc.tileset ? doc.tileset.wrapDrawing : doc.wrap === true;
}

export interface PaintResult {
  /** Pixels whose value actually changed. */
  changed: number;
  /** Requested pixels that fell outside the canvas (wrap off). */
  outOfBounds: number;
}

/**
 * Collects pixel writes, then applies them with symmetry and wrap-around.
 * Mirrored copies are applied first so explicitly requested pixels win.
 */
export class Painter {
  private readonly writes = new Map<number, number>();
  private outOfBounds = 0;
  private readonly w: number;
  private readonly h: number;

  constructor(
    private readonly cel: Uint8Array,
    width: number,
    height: number,
    private readonly opts: { wrap: boolean; symmetry?: SymmetryState | null },
  ) {
    this.w = width;
    this.h = height;
  }

  private position(x: number, y: number): number {
    if (this.opts.wrap) {
      x = ((x % this.w) + this.w) % this.w;
      y = ((y % this.h) + this.h) % this.h;
    } else if (x < 0 || y < 0 || x >= this.w || y >= this.h) {
      return -1;
    }
    return y * this.w + x;
  }

  plot(x: number, y: number, color: number): void {
    const p = this.position(x, y);
    if (p < 0) {
      this.outOfBounds++;
      return;
    }
    this.writes.set(p, color);
  }

  get pending(): number {
    return this.writes.size;
  }

  private mirrors(p: number): number[] {
    const sym = this.opts.symmetry;
    if (!sym || sym.mode === "none") return [];
    const x = p % this.w;
    const y = Math.floor(p / this.w);
    const mx = Math.round(2 * sym.axisX - x - 1);
    const my = Math.round(2 * sym.axisY - y - 1);
    const out: Array<[number, number]> = [];
    if (sym.mode === "horizontal" || sym.mode === "both") out.push([mx, y]);
    if (sym.mode === "vertical" || sym.mode === "both") out.push([x, my]);
    if (sym.mode === "both") out.push([mx, my]);
    return out.map(([a, b]) => this.position(a, b)).filter((q) => q >= 0 && q !== p);
  }

  commit(): PaintResult {
    const final = new Map<number, number>();
    for (const [p, c] of this.writes) for (const m of this.mirrors(p)) final.set(m, c);
    for (const [p, c] of this.writes) final.set(p, c);
    let changed = 0;
    for (const [p, c] of final) {
      if (this.cel[p] !== c) {
        this.cel[p] = c;
        changed++;
      }
    }
    const result = { changed, outOfBounds: this.outOfBounds };
    this.writes.clear();
    this.outOfBounds = 0;
    return result;
  }
}

/** Mirror positions of a point under the document's symmetry (used to mirror fill seeds). */
export function mirrorPoints(sym: SymmetryState | undefined, x: number, y: number): Array<[number, number]> {
  if (!sym || sym.mode === "none") return [];
  const mx = Math.round(2 * sym.axisX - x - 1);
  const my = Math.round(2 * sym.axisY - y - 1);
  const out: Array<[number, number]> = [];
  if (sym.mode === "horizontal" || sym.mode === "both") out.push([mx, y]);
  if (sym.mode === "vertical" || sym.mode === "both") out.push([x, my]);
  if (sym.mode === "both") out.push([mx, my]);
  return out;
}

/**
 * Bresenham line (8-connected, never produces doubled "L" corners). Endpoints
 * are normalized so A→B and B→A produce the same pixels.
 */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  if (x0 > x1 || (x0 === x1 && y0 > y1)) [x0, y0, x1, y1] = [x1, y1, x0, y0];
  const pts: Array<[number, number]> = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return pts;
}

export function rectPoints(x: number, y: number, w: number, h: number, filled: boolean): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (filled || yy === y || yy === y + h - 1 || xx === x || xx === x + w - 1) pts.push([xx, yy]);
    }
  }
  return pts;
}

/**
 * Pixel-perfect ellipse inscribed in the inclusive box (x0,y0)-(x1,y1)
 * (Alois Zingl, "A Rasterizing Algorithm for Drawing Curves"). Handles both
 * odd and even sizes; filled ellipses are filled row by row.
 */
export function ellipsePoints(x0: number, y0: number, x1: number, y1: number, filled: boolean): Array<[number, number]> {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const outline = new Set<number>();
  const rows = new Map<number, [number, number]>();
  const plot = (x: number, y: number) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return;
    outline.add((y - minY) * (maxX - minX + 1) + (x - minX));
    const r = rows.get(y);
    if (!r) rows.set(y, [x, x]);
    else {
      if (x < r[0]) r[0] = x;
      if (x > r[1]) r[1] = x;
    }
  };

  let a = maxX - minX;
  const b = maxY - minY;
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  let ex0 = minX;
  let ex1 = maxX;
  let ey0 = minY + ((b + 1) >> 1);
  let ey1 = ey0 - b1;
  a = 8 * a * a;
  b1 = 8 * b * b;
  do {
    plot(ex1, ey0);
    plot(ex0, ey0);
    plot(ex0, ey1);
    plot(ex1, ey1);
    const e2 = 2 * err;
    if (e2 <= dy) {
      ey0++;
      ey1--;
      dy += a;
      err += dy;
    }
    if (e2 >= dx || 2 * err > dy) {
      ex0++;
      ex1--;
      dx += b1;
      err += dx;
    }
  } while (ex0 <= ex1);
  while (ey0 - ey1 <= b) {
    plot(ex0 - 1, ey0);
    plot(ex1 + 1, ey0++);
    plot(ex0 - 1, ey1);
    plot(ex1 + 1, ey1--);
  }

  const pts: Array<[number, number]> = [];
  const width = maxX - minX + 1;
  if (filled) {
    for (const y of [...rows.keys()].sort((p, q) => p - q)) {
      const [from, to] = rows.get(y)!;
      for (let x = from; x <= to; x++) pts.push([x, y]);
    }
  } else {
    for (const key of [...outline].sort((p, q) => p - q)) pts.push([minX + (key % width), minY + Math.floor(key / width)]);
  }
  return pts;
}

/**
 * Contiguous region of the same index around (x, y), 4-connected. With wrap,
 * the region continues across canvas edges. Returns pixel offsets.
 */
export function floodRegion(cel: Uint8Array, w: number, h: number, x: number, y: number, wrap: boolean): number[] {
  if (x < 0 || y < 0 || x >= w || y >= h) return [];
  const target = cel[y * w + x]!;
  const seen = new Uint8Array(w * h);
  const out: number[] = [];
  const stack = [y * w + x];
  seen[y * w + x] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    const px = p % w;
    const py = (p - px) / w;
    const neighbors: Array<[number, number]> = [
      [px - 1, py],
      [px + 1, py],
      [px, py - 1],
      [px, py + 1],
    ];
    for (let [nx, ny] of neighbors) {
      if (wrap) {
        nx = (nx + w) % w;
        ny = (ny + h) % h;
      } else if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (!seen[q] && cel[q] === target) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return out.sort((p, q) => p - q);
}

// ---------------------------------------------------------------------------
// Paths, curves, polygons and brushes

export type Point = [number, number];
export type BrushShape = "circle" | "square" | "diamond";

/** Like linePoints, but ordered from (x0,y0) to (x1,y1). */
export function orderedLine(x0: number, y0: number, x1: number, y1: number): Point[] {
  const pts = linePoints(x0, y0, x1, y1);
  return pts[0]![0] === x0 && pts[0]![1] === y0 ? pts : pts.reverse();
}

/**
 * Aseprite's "pixel perfect" filter for an ordered stroke: drops consecutive
 * duplicates and every L-corner pixel (one orthogonally adjacent to both its
 * neighbors while those neighbors touch diagonally). Closed paths are also
 * checked across the start/end joint.
 */
export function pixelPerfect(path: Point[], closed = false): Point[] {
  const isL = (a: Point, b: Point, c: Point) =>
    (a[0] === b[0] || a[1] === b[1]) && (c[0] === b[0] || c[1] === b[1]) && a[0] !== c[0] && a[1] !== c[1];
  const out: Point[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    if (out.length >= 2 && isL(out[out.length - 2]!, last!, p)) out.pop();
    out.push(p);
  }
  if (closed && out.length > 3) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
    if (out.length > 3 && isL(out[out.length - 2]!, out[out.length - 1]!, out[0]!)) out.pop();
    if (out.length > 3 && isL(out[out.length - 1]!, out[0]!, out[1]!)) out.shift();
  }
  return out;
}

/** Joins a sequence of pixel positions into a gap-free ordered path. */
function connect(samples: Point[]): Point[] {
  const out: Point[] = [];
  for (const s of samples) {
    const last = out[out.length - 1];
    if (!last) out.push(s);
    else if (last[0] !== s[0] || last[1] !== s[1]) out.push(...orderedLine(last[0], last[1], s[0], s[1]).slice(1));
  }
  return out;
}

/** Straight segments through every point (rounded to pixels), pixel-perfect unless disabled. */
export function polylinePoints(points: Point[], closed: boolean, perfect = true): Point[] {
  const pts = points.map(([x, y]) => [Math.round(x), Math.round(y)] as Point);
  if (closed && pts.length > 2) pts.push(pts[0]!);
  const path = connect(pts);
  return perfect ? pixelPerfect(path, closed) : path;
}

/**
 * Cardinal (Catmull-Rom at tension 0) spline passing through every control
 * point, rasterized as a gap-free 1px path. tension 1 gives straight segments.
 */
export function curvePoints(points: Point[], closed: boolean, tension = 0, perfect = true): Point[] {
  const n = points.length;
  if (n < 3) return polylinePoints(points, closed, perfect);
  const get = (i: number): Point => (closed ? points[((i % n) + n) % n]! : points[Math.max(0, Math.min(n - 1, i))]!);
  const k = (1 - tension) / 2;
  const samples: Point[] = [];
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const m1 = [k * (p2[0] - p0[0]), k * (p2[1] - p0[1])];
    const m2 = [k * (p3[0] - p1[0]), k * (p3[1] - p1[1])];
    const steps = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * 4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      samples.push([
        Math.round(h00 * p1[0] + h10 * m1[0]! + h01 * p2[0] + h11 * m2[0]!),
        Math.round(h00 * p1[1] + h10 * m1[1]! + h01 * p2[1] + h11 * m2[1]!),
      ]);
    }
  }
  const path = connect(samples);
  return perfect ? pixelPerfect(path, closed) : path;
}

/** Even-odd test of a pixel center against a polygon whose vertices are pixel centers. */
function insidePolygon(poly: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Polygon outline (closed 1px path), plus its interior when filled. */
export function polygonPoints(points: Point[], filled: boolean, curve = false, tension = 0): { outline: Point[]; fill: Point[] } {
  // Straight polygons keep their vertices exactly (no pixel-perfect corner cutting); curved ones are strokes.
  const outline = curve ? curvePoints(points, true, tension) : polylinePoints(points, true, false);
  if (!filled) return { outline, fill: [] };
  const poly = curve ? outline : points;
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const fill: Point[] = [];
  for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++) if (insidePolygon(poly, x, y)) fill.push([x, y]);
  }
  return { outline, fill };
}

/** Pixel offsets of a brush tip of the given diameter, centered on (0, 0). */
export function brushStamp(diameter: number, shape: BrushShape = "circle"): Point[] {
  const d = Math.max(1, Math.round(diameter));
  const o = Math.floor((d - 1) / 2);
  if (shape === "circle") return ellipsePoints(0, 0, d - 1, d - 1, true).map(([x, y]) => [x - o, y - o]);
  const pts: Point[] = [];
  const c = (d - 1) / 2;
  for (let y = 0; y < d; y++) {
    for (let x = 0; x < d; x++) {
      if (shape === "square" || Math.abs(x - c) + Math.abs(y - c) <= c + 0.5) pts.push([x - o, y - o]);
    }
  }
  return pts;
}

/**
 * Stamps a brush along an ordered path, interpolating the diameter from
 * widthStart to widthEnd by arc length (tapered strokes). A 1px stroke is the
 * path itself.
 */
export function strokePoints(path: Point[], widthStart: number, widthEnd: number, shape: BrushShape = "circle"): Point[] {
  if (Math.round(widthStart) <= 1 && Math.round(widthEnd) <= 1) return path;
  const lengths = [0];
  for (let i = 1; i < path.length; i++) {
    lengths.push(lengths[i - 1]! + Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]));
  }
  const total = lengths[lengths.length - 1]! || 1;
  const stamps = new Map<number, Point[]>();
  const seen = new Set<string>();
  const out: Point[] = [];
  path.forEach(([px, py], i) => {
    const d = Math.max(1, Math.round(widthStart + (widthEnd - widthStart) * (lengths[i]! / total)));
    if (!stamps.has(d)) stamps.set(d, brushStamp(d, shape));
    for (const [dx, dy] of stamps.get(d)!) {
      const key = `${px + dx},${py + dy}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push([px + dx, py + dy]);
      }
    }
  });
  return out;
}

/** Small seeded PRNG (mulberry32) returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Removes L-corner pixels from 1px lines already on a layer. A pixel goes when
 * two same-color orthogonal neighbors on perpendicular sides hold it, the
 * diagonal between those arms differs, and the outside of the corner (the two
 * opposite orthogonals and the opposite diagonal) is one background color,
 * which the pixel takes. Lines stay 8-connected and filled areas are untouched.
 * Processed in scan order on the live layer, like a freehand stroke.
 */
export function removeLCorners(cel: Uint8Array, w: number, h: number, mask: Uint8Array | null, wrap: boolean, only?: number): number {
  /** Pixel value, or -1 off the canvas (wrap off), which matches any background. */
  const at = (x: number, y: number): number => {
    if (wrap) return cel[(((y % h) + h) % h) * w + (((x % w) + w) % w)]!;
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : cel[y * w + x]!;
  };
  let removed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const c = cel[p]!;
      if (c === 0 || (only !== undefined && c !== only) || (mask && !mask[p])) continue;
      corner: for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          if (at(x + sx, y) !== c || at(x, y + sy) !== c || at(x + sx, y + sy) === c) continue;
          const outside = [at(x - sx, y - sy), at(x - sx, y), at(x, y - sy)].filter((v) => v >= 0);
          const bg = outside[0];
          if (bg !== undefined && bg !== c && outside.every((v) => v === bg)) {
            cel[p] = bg;
            removed++;
            break corner;
          }
        }
      }
    }
  }
  return removed;
}
