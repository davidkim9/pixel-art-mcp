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
