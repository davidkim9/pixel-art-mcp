import { rgbKey, toHex, keyToRgb } from "../color.js";
import { MAX_PALETTE_COLORS, PaletteMatcher } from "../palette.js";
import type { Palette } from "../types.js";

export type ColorMode = "exact" | "nearest" | "extract";

export interface OffPaletteColor {
  color: string;
  count: number;
  /** Up to 5 sample coordinates in the source image (and frame/layer when relevant). */
  samples: Array<{ x: number; y: number; frame?: number; layer?: string }>;
}

export interface Substitution {
  from: string;
  to: number;
  toColor: string;
  count: number;
}

export interface ColorMappingReport {
  mode: ColorMode;
  offPalette: OffPaletteColor[];
  substitutions: Substitution[];
  /** Colors of a palette built by "extract". */
  extracted?: string[];
}

/**
 * Maps RGBA pixels to palette indices and records everything it did:
 * alpha thresholding, off-palette colors (exact), substitutions (nearest),
 * the extracted palette (extract). Nothing is ever changed silently.
 */
export class ColorMapper {
  readonly mode: ColorMode;
  private readonly matcher?: PaletteMatcher;
  private readonly alphaThreshold: number;
  private readonly off = new Map<number, OffPaletteColor>();
  private readonly subs = new Map<number, Substitution>();
  private readonly extracted = new Map<number, number>();
  private readonly coordScale: number;
  alphaThresholded = 0;
  tooManyColors = false;

  constructor(opts: { mode: ColorMode; palette?: Palette; alphaThreshold: number; coordScale?: number }) {
    this.mode = opts.mode;
    this.alphaThreshold = opts.alphaThreshold;
    this.coordScale = opts.coordScale ?? 1;
    if (opts.mode !== "extract") {
      if (!opts.palette) throw new Error("palette required");
      this.matcher = new PaletteMatcher(opts.palette);
    }
  }

  /** Index for one pixel (0 = transparent). Coordinates are only used for reporting. */
  map(r: number, g: number, b: number, a: number, x: number, y: number, frame?: number, layer?: string): number {
    if (a > 0 && a < 255) this.alphaThresholded++;
    if (a < this.alphaThreshold) return 0;
    const key = rgbKey(r, g, b);
    if (this.mode === "extract") {
      let idx = this.extracted.get(key);
      if (idx === undefined) {
        if (this.extracted.size >= MAX_PALETTE_COLORS) {
          this.tooManyColors = true;
          return 0;
        }
        idx = this.extracted.size + 1;
        this.extracted.set(key, idx);
      }
      return idx;
    }
    const exact = this.matcher!.exact(r, g, b);
    if (exact !== undefined) return exact;
    if (this.mode === "exact") {
      let entry = this.off.get(key);
      if (!entry) {
        entry = { color: toHex({ r, g, b }), count: 0, samples: [] };
        this.off.set(key, entry);
      }
      entry.count++;
      if (entry.samples.length < 5) {
        const s: OffPaletteColor["samples"][number] = { x: x * this.coordScale, y: y * this.coordScale };
        if (frame !== undefined) s.frame = frame;
        if (layer !== undefined) s.layer = layer;
        entry.samples.push(s);
      }
      return 0;
    }
    const to = this.matcher!.nearest(r, g, b);
    let sub = this.subs.get(key);
    if (!sub) {
      sub = { from: toHex({ r, g, b }), to, toColor: this.matcher!.palette.colors[to]!, count: 0 };
      this.subs.set(key, sub);
    }
    sub.count++;
    return to;
  }

  get failed(): boolean {
    return (this.mode === "exact" && this.off.size > 0) || this.tooManyColors;
  }

  /** Extracted palette colors in first-appearance order. */
  extractedColors(): string[] {
    return [...this.extracted.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => toHex(keyToRgb(key)));
  }

  report(): ColorMappingReport {
    const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
    const rep: ColorMappingReport = {
      mode: this.mode,
      offPalette: [...this.off.values()].sort(byCount),
      substitutions: [...this.subs.values()].sort(byCount),
    };
    if (this.mode === "extract") rep.extracted = this.extractedColors();
    return rep;
  }
}
