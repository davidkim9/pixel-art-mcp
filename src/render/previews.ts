import { luminance, parseHexColor } from "../color.js";
import type { RGB } from "../color.js";
import type { Palette } from "../types.js";
import { AffineBuffer, drawAffine } from "./compose.js";
import type { Background } from "./compose.js";
import { textHeight, textWidth } from "./font.js";
import { RgbaImage, fitText } from "./image.js";
import type { Color } from "./image.js";

/** Longest side of a preview image; larger previews are scaled down automatically. */
export const MAX_PREVIEW_DIM = 1600;
const PAGE_BG: Color = [236, 236, 236];
const INK: Color = [40, 40, 40];
const HIGHLIGHT: Color = [255, 0, 200];

export function clampScale(requested: number, w: number, h: number, extra = 0): number {
  let s = Math.max(1, Math.floor(requested));
  while (s > 1 && Math.max(w, h) * s + extra > MAX_PREVIEW_DIM) s--;
  return s;
}

/** A scale that makes the longest side about `target` pixels (1–16). */
export function autoScale(w: number, h: number, target = 512): number {
  return Math.min(16, Math.max(1, Math.floor(target / Math.max(w, h))));
}

export interface Highlight {
  x: number;
  y: number;
}

export interface CanvasViewOptions {
  scale: number;
  grid: boolean;
  /** Stronger grid lines every N pixels (0 = none). */
  majorEvery?: number;
  rulers?: boolean;
  highlights?: Highlight[];
  background?: Background;
}

function drawGrid(img: RgbaImage, ox: number, oy: number, w: number, h: number, scale: number, major: number): void {
  const black: Color = [0, 0, 0];
  for (let x = 0; x <= w; x++) {
    const strong = major > 0 && x % major === 0;
    const px = ox + Math.min(x * scale, w * scale - 1);
    for (let y = 0; y < h * scale; y++) img.blend(px, oy + y, black, strong ? 0.5 : 0.18);
  }
  for (let y = 0; y <= h; y++) {
    const strong = major > 0 && y % major === 0;
    const py = oy + Math.min(y * scale, h * scale - 1);
    for (let x = 0; x < w * scale; x++) {
      if (x % scale === 0) continue; // already darkened by the vertical line
      img.blend(ox + x, py, black, strong ? 0.5 : 0.18);
    }
  }
}

function rulerStep(scale: number, labelWidth: number): number {
  for (const step of [1, 2, 4, 8, 16, 32, 64, 128, 256]) if (step * scale >= labelWidth + 3) return step;
  return 512;
}

/** Renders a composite with optional pixel grid, coordinate rulers and highlighted pixels. */
export function renderCanvasView(buf: AffineBuffer, opts: CanvasViewOptions): RgbaImage {
  const { scale } = opts;
  const ls = scale >= 6 ? 2 : 1;
  const rulers = opts.rulers === true;
  const left = rulers ? textWidth(String(buf.height - 1), ls) + 4 : 0;
  const top = rulers ? textHeight(ls) + 4 : 0;
  const img = new RgbaImage(buf.width * scale + left, buf.height * scale + top, PAGE_BG);
  drawAffine(img, buf, left, top, scale, opts.background ?? "checker");
  if (opts.grid && scale >= 4) drawGrid(img, left, top, buf.width, buf.height, scale, opts.majorEvery ?? 0);
  if (rulers) {
    const stepX = rulerStep(scale, textWidth(String(buf.width - 1), ls));
    for (let x = 0; x < buf.width; x += stepX) img.text(left + x * scale + 1, 2, String(x), INK, ls);
    const stepY = Math.max(1, Math.ceil((textHeight(ls) + 2) / scale));
    const niceY = [1, 2, 4, 8, 16, 32, 64, 128, 256].find((s) => s >= stepY) ?? 512;
    for (let y = 0; y < buf.height; y += niceY) {
      const label = String(y);
      img.text(left - 2 - textWidth(label, ls), top + y * scale + 1, label, INK, ls);
    }
  }
  for (const hl of opts.highlights ?? []) {
    const t = scale >= 6 ? 2 : 1;
    if (scale >= 3) img.strokeRect(left + hl.x * scale, top + hl.y * scale, scale, scale, HIGHLIGHT, t);
    else img.fillRect(left + hl.x * scale, top + hl.y * scale, scale, scale, HIGHLIGHT);
  }
  return img;
}

export interface SheetCell {
  buf: AffineBuffer;
  title: string;
  subtitle?: string;
  highlights?: Highlight[];
}

/** Lays out labelled cells in a grid (contact sheet). */
export function renderSheet(cells: SheetCell[], scale: number, opts: { grid?: boolean; background?: Background; columns?: number } = {}): RgbaImage {
  const gap = 8;
  const ls = 2;
  const lineH = textHeight(ls) + 3;
  const labelH = lineH * 2 + 2;
  const cw = Math.max(...cells.map((c) => c.buf.width)) * scale;
  const ch = Math.max(...cells.map((c) => c.buf.height)) * scale;
  const cellW = Math.max(cw, 40);
  const fitCols = Math.max(1, Math.floor((MAX_PREVIEW_DIM - gap) / (cellW + gap)));
  const cols = Math.min(cells.length, opts.columns ?? fitCols);
  const rows = Math.ceil(cells.length / cols);
  const img = new RgbaImage(gap + cols * (cellW + gap), gap + rows * (labelH + ch + gap), PAGE_BG);
  cells.forEach((cell, i) => {
    const x = gap + (i % cols) * (cellW + gap);
    const y = gap + Math.floor(i / cols) * (labelH + ch + gap);
    img.text(x, y, fitText(cell.title, cellW, ls), INK, ls);
    if (cell.subtitle) img.text(x, y + lineH, fitText(cell.subtitle, cellW, ls), [90, 90, 90], ls);
    const view = renderCanvasView(cell.buf, {
      scale,
      grid: opts.grid ?? false,
      highlights: cell.highlights,
      background: opts.background,
    });
    img.draw(view, x, y + labelH);
  });
  return img;
}

/** Repeats a composite n×n. */
export function tileAffine(buf: AffineBuffer, nx: number, ny: number): AffineBuffer {
  const out = new AffineBuffer(buf.width * nx, buf.height * ny);
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      for (let y = 0; y < buf.height; y++) {
        const src = buf.data.subarray(y * buf.width * 4, (y + 1) * buf.width * 4);
        out.data.set(src, ((ty * buf.height + y) * out.width + tx * buf.width) * 4);
      }
    }
  }
  return out;
}

/** Copies `src` into `dst` at (dx, dy) (cells outside are dropped). */
export function blitAffine(dst: AffineBuffer, src: AffineBuffer, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      for (let k = 0; k < 4; k++) dst.data[d + k] = src.data[s + k]!;
    }
  }
}

function contrastInk(c: RGB): Color {
  return luminance(c) > 0.35 ? [0, 0, 0] : [255, 255, 255];
}

/** Palette swatches labelled with indices, followed by one row per ramp. */
export function renderPaletteImage(p: Palette, swatch = 28): RgbaImage {
  const n = p.colors.length;
  const cols = n <= 16 ? n : n <= 34 ? Math.ceil(n / 2) : 16;
  const gap = 2;
  const pad = 8;
  const ls = swatch >= 24 ? 2 : 1;
  const rows = Math.ceil(n / cols);
  const rampNames = Object.keys(p.ramps);
  const rampLabelW = Math.max(0, ...rampNames.map((r) => textWidth(r.slice(0, 14), 2))) + 8;
  const longestRamp = Math.max(0, ...Object.values(p.ramps).map((r) => r.length));
  const gridW = cols * (swatch + gap);
  const rampW = rampNames.length ? rampLabelW + longestRamp * (swatch + gap) : 0;
  const width = pad * 2 + Math.max(gridW, rampW, textWidth(p.name, 2));
  const titleH = textHeight(2) + 6;
  const rampTitleH = rampNames.length ? textHeight(2) + 10 : 0;
  const height = pad * 2 + titleH + rows * (swatch + gap) + rampTitleH + rampNames.length * (swatch + gap);
  const img = new RgbaImage(width, height, PAGE_BG);
  img.text(pad, pad, p.name, INK, 2);
  const drawSwatch = (x: number, y: number, index: number) => {
    if (index === 0) {
      const cell = Math.max(2, swatch / 4);
      for (let yy = 0; yy < swatch; yy++) {
        for (let xx = 0; xx < swatch; xx++) {
          img.set(x + xx, y + yy, (Math.floor(xx / cell) + Math.floor(yy / cell)) & 1 ? [160, 160, 160] : [204, 204, 204]);
        }
      }
      img.text(x + 2, y + 2, "0", INK, ls);
      return;
    }
    const c = parseHexColor(p.colors[index]!);
    img.fillRect(x, y, swatch, swatch, [c.r, c.g, c.b]);
    img.text(x + 2, y + 2, String(index), contrastInk(c), ls);
  };
  for (let i = 0; i < n; i++) {
    drawSwatch(pad + (i % cols) * (swatch + gap), pad + titleH + Math.floor(i / cols) * (swatch + gap), i);
  }
  if (rampNames.length) {
    let y = pad + titleH + rows * (swatch + gap) + 4;
    img.text(pad, y, "RAMPS (DARK > LIGHT)", INK, 2);
    y += rampTitleH - 4;
    for (const name of rampNames) {
      img.text(pad, y + Math.floor((swatch - textHeight(2)) / 2), name.slice(0, 14), INK, 2);
      p.ramps[name]!.forEach((idx, k) => drawSwatch(pad + rampLabelW + k * (swatch + gap), y, idx));
      y += swatch + gap;
    }
  }
  return img;
}
