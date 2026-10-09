import { oklabDistance, rgbToOklab } from "../color.js";
import type { Oklab, RGB } from "../color.js";
import type { Point } from "../types.js";

export interface SeamPair {
  a: Point;
  b: Point;
  reason: "transparency" | "contrast";
  delta: number;
}

export interface AxisReport {
  /** Pixel pairs that touch across the wrap boundary. */
  pairs: number;
  /** Pairs whose colors differ at all. */
  differing: number;
  /** Pairs likely to show a seam: transparency mismatch, or contrast well above the tile's own. */
  flagged: SeamPair[];
  /** Mean perceptual contrast (OKLab) across the seam, opaque pairs only. */
  seamContrast: number;
  /** Mean contrast between neighbouring pixels inside the tile along the same axis. */
  interiorContrast: number;
}

export interface SeamReport {
  horizontal: AxisReport;
  vertical: AxisReport;
  verdict: "seamless" | "minor" | "visible";
}

/** Contrast above which a seam pair is flagged (OKLab distance; adjacent ramp steps are ~0.05–0.15). */
const MIN_FLAG_CONTRAST = 0.12;

function axisReport(pixels: Uint8Array, w: number, h: number, lab: Oklab[], axis: "horizontal" | "vertical"): AxisReport {
  const at = (x: number, y: number) => pixels[y * w + x]!;
  let interiorSum = 0;
  let interiorCount = 0;
  const along = axis === "horizontal" ? h : w;
  const across = axis === "horizontal" ? w : h;
  const get = (i: number, j: number) => (axis === "horizontal" ? at(j, i) : at(i, j));
  const point = (i: number, j: number): Point => (axis === "horizontal" ? { x: j, y: i } : { x: i, y: j });
  for (let i = 0; i < along; i++) {
    for (let j = 0; j + 1 < across; j++) {
      const p = get(i, j);
      const q = get(i, j + 1);
      if (p === 0 || q === 0) continue;
      interiorSum += oklabDistance(lab[p]!, lab[q]!);
      interiorCount++;
    }
  }
  const interior = interiorCount ? interiorSum / interiorCount : 0;
  const threshold = Math.max(MIN_FLAG_CONTRAST, interior * 2.5);
  const flagged: SeamPair[] = [];
  let differing = 0;
  let seamSum = 0;
  let seamCount = 0;
  for (let i = 0; i < along; i++) {
    const p = get(i, across - 1);
    const q = get(i, 0);
    if (p !== q) differing++;
    const a = point(i, across - 1);
    const b = point(i, 0);
    if ((p === 0) !== (q === 0)) {
      flagged.push({ a, b, reason: "transparency", delta: 1 });
      continue;
    }
    if (p === 0) continue;
    const d = oklabDistance(lab[p]!, lab[q]!);
    seamSum += d;
    seamCount++;
    if (d > threshold) flagged.push({ a, b, reason: "contrast", delta: Math.round(d * 1000) / 1000 });
  }
  return {
    pairs: along,
    differing,
    flagged,
    seamContrast: seamCount ? Math.round((seamSum / seamCount) * 1000) / 1000 : 0,
    interiorContrast: Math.round(interior * 1000) / 1000,
  };
}

/**
 * Compares opposite edges of a tile (right↔left, bottom↔top): the pixels that
 * become neighbours when the tile repeats.
 */
export function analyzeSeams(pixels: Uint8Array, w: number, h: number, palette: RGB[]): SeamReport {
  const lab = palette.map((c) => rgbToOklab(c));
  const horizontal = axisReport(pixels, w, h, lab, "horizontal");
  const vertical = axisReport(pixels, w, h, lab, "vertical");
  const flagged = horizontal.flagged.length + vertical.flagged.length;
  const pairs = horizontal.pairs + vertical.pairs;
  const tooContrasty = (a: AxisReport) => a.seamContrast > Math.max(MIN_FLAG_CONTRAST, a.interiorContrast * 1.5);
  const verdict = flagged === 0 ? "seamless" : flagged <= pairs * 0.1 && !tooContrasty(horizontal) && !tooContrasty(vertical) ? "minor" : "visible";
  return { horizontal, vertical, verdict };
}
