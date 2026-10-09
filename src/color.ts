import { fail } from "./util/errors.js";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Parses "#rgb", "#rrggbb", "rrggbb", "0xrrggbb" or "#rrggbbff". Partial alpha is rejected. */
export function parseHexColor(input: string): RGB {
  let s = input.trim();
  if (s.startsWith("#")) s = s.slice(1);
  else if (/^0x/i.test(s)) s = s.slice(2);
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, (ch) => ch + ch);
  if (/^[0-9a-f]{8}$/i.test(s)) {
    const alpha = s.slice(6).toLowerCase();
    if (alpha !== "ff") fail(`Color "${input}" has alpha ${alpha}; palettes are opaque (index 0 is the only transparent color).`);
    s = s.slice(0, 6);
  }
  if (!/^[0-9a-f]{6}$/i.test(s)) fail(`Invalid color "${input}" (expected #rrggbb).`);
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex(c: RGB): string {
  return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function rgbKey(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

export function keyToRgb(key: number): RGB {
  return { r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255 };
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export type Oklab = [number, number, number];

/** sRGB → OKLab (Björn Ottosson). */
export function rgbToOklab(c: RGB): Oklab {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabDistance(a: Oklab, b: Oklab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Perceptual distance (Euclidean in OKLab). Roughly 0 (same) … 1 (black vs white). */
export function colorDistance(a: RGB, b: RGB): number {
  return oklabDistance(rgbToOklab(a), rgbToOklab(b));
}

/** WCAG relative luminance, 0 … 1. */
export function luminance(c: RGB): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}
