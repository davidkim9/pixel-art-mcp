import type { RGB } from "../color.js";
import { getCel } from "../document.js";
import type { Document, Layer } from "../types.js";
import { RgbaImage } from "./image.js";
import type { Color } from "./image.js";

/**
 * Per-pixel "affine" color: final = a × background + (r, g, b), clamped.
 * Normal layers set a = 0; additive layers add to (r, g, b); guide layers blend
 * faintly. This lets one composite be drawn over any background (checkerboard,
 * solid color) with additive glow handled correctly.
 */
export class AffineBuffer {
  readonly data: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.data[i * 4] = 1;
  }

  /** Opaque overwrite. */
  paint(p: number, c: RGB): void {
    const o = p * 4;
    this.data[o] = 0;
    this.data[o + 1] = c.r;
    this.data[o + 2] = c.g;
    this.data[o + 3] = c.b;
  }

  add(p: number, c: RGB): void {
    const o = p * 4;
    this.data[o + 1] = this.data[o + 1]! + c.r;
    this.data[o + 2] = this.data[o + 2]! + c.g;
    this.data[o + 3] = this.data[o + 3]! + c.b;
  }

  mix(p: number, c: RGB, alpha: number): void {
    const o = p * 4;
    const k = 1 - alpha;
    this.data[o] = this.data[o]! * k;
    this.data[o + 1] = this.data[o + 1]! * k + c.r * alpha;
    this.data[o + 2] = this.data[o + 2]! * k + c.g * alpha;
    this.data[o + 3] = this.data[o + 3]! * k + c.b * alpha;
  }

  isEmpty(p: number): boolean {
    const o = p * 4;
    return this.data[o] === 1 && this.data[o + 1] === 0 && this.data[o + 2] === 0 && this.data[o + 3] === 0;
  }

  resolve(p: number, bg: Color): Color {
    const o = p * 4;
    const a = this.data[o]!;
    return [
      Math.min(255, Math.round(a * bg[0] + this.data[o + 1]!)),
      Math.min(255, Math.round(a * bg[1] + this.data[o + 2]!)),
      Math.min(255, Math.round(a * bg[2] + this.data[o + 3]!)),
    ];
  }
}

export interface ComposeOptions {
  /** Exact layer ids to show (overrides visibility). */
  layers?: string[];
  /** Show guide layers faintly (default true). */
  showGuides?: boolean;
  guideAlpha?: number;
}

export function selectLayers(doc: Document, opts: ComposeOptions): Layer[] {
  if (opts.layers) {
    const wanted = new Set(opts.layers);
    return doc.layers.filter((l) => wanted.has(l.id) || wanted.has(l.name));
  }
  return doc.layers.filter((l) => l.visible && (!l.guide || opts.showGuides !== false));
}

export function composeLayers(
  doc: Document,
  palette: RGB[],
  frame: number,
  layers: Layer[],
  guideAlpha = 0.35,
  into?: AffineBuffer,
): AffineBuffer {
  const buf = into ?? new AffineBuffer(doc.width, doc.height);
  for (const layer of layers) {
    const cel = getCel(doc, layer.id, frame);
    if (!cel) continue;
    for (let p = 0; p < cel.length; p++) {
      const v = cel[p]!;
      if (v === 0) continue;
      const c = palette[v] ?? { r: 255, g: 0, b: 255 };
      if (layer.guide) buf.mix(p, c, guideAlpha);
      else if (layer.blend === "additive") buf.add(p, c);
      else buf.paint(p, c);
    }
  }
  return buf;
}

export function composeFrame(doc: Document, palette: RGB[], frame: number, opts: ComposeOptions = {}): AffineBuffer {
  return composeLayers(doc, palette, frame, selectLayers(doc, opts), opts.guideAlpha);
}

/** Composite of an index buffer (already flattened). */
export function affineFromIndices(indices: Uint8Array, w: number, h: number, palette: RGB[]): AffineBuffer {
  const buf = new AffineBuffer(w, h);
  for (let p = 0; p < indices.length; p++) {
    const v = indices[p]!;
    if (v !== 0) buf.paint(p, palette[v] ?? { r: 255, g: 0, b: 255 });
  }
  return buf;
}

export const CHECKER_LIGHT: Color = [204, 204, 204];
export const CHECKER_DARK: Color = [160, 160, 160];

export type Background = "checker" | Color;

/**
 * Draws a composite scaled by `scale` (nearest neighbor) at (ox, oy). The
 * checkerboard uses squares of half a canvas pixel, so transparency never
 * looks like a flat palette color.
 */
export function drawAffine(img: RgbaImage, buf: AffineBuffer, ox: number, oy: number, scale: number, bg: Background = "checker"): void {
  const cell = Math.max(1, Math.floor(scale / 2));
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      const p = y * buf.width + x;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const ix = ox + x * scale + sx;
          const iy = oy + y * scale + sy;
          let back: Color;
          if (bg === "checker") back = (Math.floor(ix / cell) + Math.floor(iy / cell)) & 1 ? CHECKER_DARK : CHECKER_LIGHT;
          else back = bg;
          img.set(ix, iy, buf.resolve(p, back));
        }
      }
    }
  }
}
