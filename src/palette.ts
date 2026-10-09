import { luminance, parseHexColor, rgbKey, rgbToOklab, toHex, oklabDistance } from "./color.js";
import type { Oklab, RGB } from "./color.js";
import type { Palette } from "./types.js";
import { fail } from "./util/errors.js";

/** Index 0 is reserved for transparency, so a palette holds at most 255 colors. */
export const MAX_PALETTE_COLORS = 255;

export const BUILTIN_PALETTES: Record<string, string[]> = {
  pico8: [
    "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
    "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
  ],
};

export interface ParsedPaletteText {
  colors: string[];
  format: "gpl" | "hex";
  name?: string;
}

/**
 * Parses the text of a GIMP `.gpl` file, a Lospec `.hex` file (one rrggbb per
 * line), or any whitespace/comma separated list of hex colors.
 */
export function parsePaletteText(text: string): ParsedPaletteText {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (/^GIMP Palette/i.test(trimmed)) {
    const colors: string[] = [];
    let name: string | undefined;
    for (const raw of trimmed.split(/\r?\n/).slice(1)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const nameMatch = /^Name:\s*(.*)$/i.exec(line);
      if (nameMatch) {
        name = nameMatch[1]!.trim();
        continue;
      }
      if (/^Columns:/i.test(line)) continue;
      const m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(\s|$)/.exec(line);
      if (!m) fail(`Unrecognized line in GIMP palette: "${line}"`);
      const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v));
      if ([r, g, b].some((v) => v! > 255)) fail(`Color component out of range in GIMP palette line "${line}"`);
      colors.push(toHex({ r: r!, g: g!, b: b! }));
    }
    return { colors, format: "gpl", name };
  }
  const tokens = trimmed
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !t.startsWith("//"));
  return { colors: tokens.map((t) => toHex(parseHexColor(t))), format: "hex" };
}

/** Builds a palette from opaque colors; index 0 (transparent) is inserted automatically. */
export function createPalette(id: string, name: string, colors: string[], ramps: Record<string, number[]> = {}): Palette {
  if (colors.length === 0) fail("A palette needs at least one color.");
  if (colors.length > MAX_PALETTE_COLORS) {
    fail(`Palette has ${colors.length} colors; the maximum is ${MAX_PALETTE_COLORS} (index 0 is reserved for transparency).`);
  }
  return { id, name, colors: ["#000000", ...colors.map((c) => toHex(parseHexColor(c)))], ramps };
}

export function paletteRgb(p: Palette): RGB[] {
  return p.colors.map((c) => parseHexColor(c));
}

export function colorCount(p: Palette): number {
  return p.colors.length - 1;
}

export function checkColorIndex(p: Palette, index: number, what = "color"): void {
  if (!Number.isInteger(index) || index < 0 || index >= p.colors.length) {
    fail(`${what} ${index} is not a valid index for palette "${p.id}" (valid: 0–${p.colors.length - 1}, 0 = transparent).`);
  }
}

export function getRamp(p: Palette, name: string): number[] {
  const ramp = p.ramps[name];
  if (!ramp) {
    const names = Object.keys(p.ramps);
    fail(`Palette "${p.id}" has no ramp "${name}". Ramps: ${names.length ? names.join(", ") : "(none — use define_ramp)"}.`);
  }
  return ramp;
}

/** Index of the palette's brightest color (used for guide layers). */
export function brightestIndex(p: Palette): number {
  let best = 1;
  let bestL = -1;
  for (let i = 1; i < p.colors.length; i++) {
    const l = luminance(parseHexColor(p.colors[i]!));
    if (l > bestL) {
      bestL = l;
      best = i;
    }
  }
  return best;
}

/** Ramp-ordering problems (ramps must go dark → light), for warnings. */
export function rampWarnings(p: Palette, indices: number[]): string[] {
  const warnings: string[] = [];
  const lum = indices.map((i) => luminance(parseHexColor(p.colors[i]!)));
  for (let i = 1; i < lum.length; i++) {
    if (lum[i]! < lum[i - 1]!) {
      warnings.push(`Ramp step ${i} (index ${indices[i]}) is darker than step ${i - 1} (index ${indices[i - 1]}); ramps should go dark → light.`);
    }
  }
  return warnings;
}

/**
 * For a color index, the next darker color in whichever ramp contains it
 * (used by selective outlines). Undefined if no ramp contains it or it is
 * already the darkest step.
 */
export function darkerInRamp(p: Palette, index: number): number | undefined {
  for (const name of Object.keys(p.ramps).sort()) {
    const ramp = p.ramps[name]!;
    const pos = ramp.indexOf(index);
    if (pos > 0) return ramp[pos - 1];
  }
  return undefined;
}

/** Maps RGB colors onto palette indices (exact or nearest in OKLab). Index 0 is never returned. */
export class PaletteMatcher {
  private readonly exactMap = new Map<number, number>();
  private readonly lab: Oklab[];
  private readonly nearestCache = new Map<number, number>();

  constructor(readonly palette: Palette) {
    const rgb = paletteRgb(palette);
    this.lab = rgb.map((c) => rgbToOklab(c));
    for (let i = rgb.length - 1; i >= 1; i--) {
      const c = rgb[i]!;
      this.exactMap.set(rgbKey(c.r, c.g, c.b), i); // lowest index wins for duplicates
    }
  }

  exact(r: number, g: number, b: number): number | undefined {
    return this.exactMap.get(rgbKey(r, g, b));
  }

  nearest(r: number, g: number, b: number): number {
    const key = rgbKey(r, g, b);
    const cached = this.nearestCache.get(key);
    if (cached !== undefined) return cached;
    const exact = this.exactMap.get(key);
    if (exact !== undefined) return exact;
    const lab = rgbToOklab({ r, g, b });
    let best = 1;
    let bestDist = Infinity;
    for (let i = 1; i < this.lab.length; i++) {
      const d = oklabDistance(lab, this.lab[i]!);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    this.nearestCache.set(key, best);
    return best;
  }
}
