/**
 * Corner15 template and the dual grid (spec §8.1).
 *
 * mask = TL*1 + TR*2 + BR*4 + BL*8, each corner 1 if it is the upper terrain.
 * A transition-set document has 16 frames and frame index === mask; frame 0
 * (all lower) is empty in overlay mode or holds the base tile otherwise.
 */
import type { RGB } from "../color.js";
import { DIHEDRAL, transformPoint, transformSquare } from "../selection.js";
import type { Dihedral } from "../selection.js";
import { analyzeSeams } from "./seams.js";
import type { SeamPair } from "./seams.js";

export const TL = 1;
export const TR = 2;
export const BR = 4;
export const BL = 8;
export const CORNER_ORDER = ["TL", "TR", "BR", "BL"] as const;
const CORNERS: Array<[number, number, number, string]> = [
  [0, 0, TL, "TL"],
  [1, 0, TR, "TR"],
  [1, 1, BR, "BR"],
  [0, 1, BL, "BL"],
];

export function maskName(mask: number): string {
  if (mask === 0) return "none";
  if (mask === 15) return "all";
  return CORNERS.filter(([, , bit]) => mask & bit).map(([, , , n]) => n).join("+");
}

export function maskClass(mask: number): "empty" | "outer" | "edge" | "inner" | "diagonal" | "full" {
  if (mask === 0) return "empty";
  if (mask === 15) return "full";
  if (mask === 5 || mask === 10) return "diagonal";
  const bits = [1, 2, 4, 8].filter((b) => mask & b).length;
  return bits === 1 ? "outer" : bits === 2 ? "edge" : "inner";
}

export function frameLabel(mask: number): string {
  return `mask ${mask} ${maskName(mask)}`;
}

/** The mask of a tile after an image transform (consistent with transformSquare). */
export function transformMask(mask: number, t: Dihedral): number {
  let out = 0;
  for (const [x, y, bit] of CORNERS) {
    if (!(mask & bit)) continue;
    const [nx, ny] = transformPoint(x, y, 1, t);
    out |= CORNERS.find(([cx, cy]) => cx === nx && cy === ny)![2];
  }
  return out;
}

export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: Side[] = ["top", "right", "bottom", "left"];

/** Corner values at the two ends of a side, in reading order (left→right, top→bottom). */
export function sidePair(mask: number, side: Side): [number, number] {
  const b = (bit: number) => (mask & bit ? 1 : 0);
  switch (side) {
    case "top": return [b(TL), b(TR)];
    case "bottom": return [b(BL), b(BR)];
    case "left": return [b(TL), b(BL)];
    default: return [b(TR), b(BR)];
  }
}

export function edgePixels(tile: Uint8Array, size: number, side: Side): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] =
      side === "top" ? tile[i]! : side === "bottom" ? tile[(size - 1) * size + i]! : side === "left" ? tile[i * size]! : tile[i * size + size - 1]!;
  }
  return out;
}

export function edgePoint(size: number, side: Side, i: number): { x: number; y: number } {
  return side === "top" ? { x: i, y: 0 } : side === "bottom" ? { x: i, y: size - 1 } : side === "left" ? { x: 0, y: i } : { x: size - 1, y: i };
}

export interface EdgeMismatch {
  side: Side;
  /** e.g. "TR=1,BR=0" */
  corners: string;
  tile: number;
  reference: number;
  /** Positions along the edge (0 = left/top end) that differ from the reference tile. */
  positions: number[];
}

export interface TransitionCheck {
  ok: boolean;
  missing: number[];
  mismatches: EdgeMismatch[];
  /** Seams that may be visible where reference tiles repeat (heuristic). */
  seamWarnings: Array<{ tile: number; axis: "horizontal" | "vertical"; flagged: SeamPair[] }>;
  /** Overlay mode: frame 0 must stay empty. */
  baseNotEmpty: boolean;
}

const SIDE_CORNER_NAMES: Record<Side, [string, string]> = {
  top: ["TL", "TR"],
  bottom: ["BL", "BR"],
  left: ["TL", "BL"],
  right: ["TR", "BR"],
};

/**
 * Edge-matching rule: along any tile edge the pixels are determined only by
 * the corners at its ends, so all tiles whose edge on the same side has the
 * same corner pair must have identical pixels on that edge. Tiles that repeat
 * next to themselves (3 and 12 horizontally, 9 and 6 vertically, 15 both ways)
 * are additionally checked for high-contrast seams.
 */
export function checkCorner15(tiles: Uint8Array[], size: number, overlay: boolean, palette: RGB[]): TransitionCheck {
  const has = (m: number) => tiles[m]!.some((v) => v !== 0);
  const missing = [];
  for (let m = 1; m <= 15; m++) if (!has(m)) missing.push(m);
  const baseNotEmpty = overlay && has(0);
  const included = [...Array(16).keys()].filter((m) => m !== 0 || overlay || has(0));
  const mismatches: EdgeMismatch[] = [];
  for (const side of SIDES) {
    const groups = new Map<string, number[]>();
    for (const m of included) {
      if (m !== 0 && !has(m)) continue;
      const pair = sidePair(m, side);
      const key = pair.join("");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    for (const [key, members] of groups) {
      // Reference: the full tile for (1,1), the base tile for (0,0) when included, else the lowest mask.
      const preferred = key === "11" ? 15 : key === "00" && members.includes(0) ? 0 : members[0]!;
      const reference = members.includes(preferred) ? preferred : members[0]!;
      const refEdge = edgePixels(tiles[reference]!, size, side);
      for (const m of members) {
        if (m === reference) continue;
        const edge = edgePixels(tiles[m]!, size, side);
        const positions: number[] = [];
        for (let i = 0; i < size; i++) if (edge[i] !== refEdge[i]) positions.push(i);
        if (positions.length) {
          const [c1, c2] = SIDE_CORNER_NAMES[side];
          mismatches.push({ side, corners: `${c1}=${key[0]},${c2}=${key[1]}`, tile: m, reference, positions });
        }
      }
    }
  }
  const seamWarnings: TransitionCheck["seamWarnings"] = [];
  const selfTiling: Array<[number, "horizontal" | "vertical"]> = [
    [3, "horizontal"], [12, "horizontal"], [9, "vertical"], [6, "vertical"], [15, "horizontal"], [15, "vertical"],
  ];
  for (const [m, axis] of selfTiling) {
    if (!has(m)) continue;
    const report = analyzeSeams(tiles[m]!, size, size, palette)[axis];
    if (report.flagged.length) seamWarnings.push({ tile: m, axis, flagged: report.flagged });
  }
  return { ok: missing.length === 0 && mismatches.length === 0, missing, mismatches, seamWarnings, baseNotEmpty };
}

// ---------------------------------------------------------------------------
// Generation

export interface GeneratedTile {
  mask: number;
  from: number | number[];
  transform: Dihedral | "compose";
}

/**
 * Fills empty masks from hand-drawn sources with lossless flips/rotations
 * (preferring flips), and composes diagonals (5, 10) from two outer corners
 * when no diagonal source exists.
 */
export function generateCorner15(
  tiles: Uint8Array[],
  size: number,
  sources: number[],
  overlay: boolean,
  targets: Set<number>,
): GeneratedTile[] {
  const generated: GeneratedTile[] = [];
  const available = [...sources];
  const tryDerive = (m: number): boolean => {
    for (const t of DIHEDRAL) {
      for (const s of available) {
        if (transformMask(s, t) === m) {
          tiles[m] = transformSquare(tiles[s]!, size, t);
          generated.push({ mask: m, from: s, transform: t });
          return true;
        }
      }
    }
    return false;
  };
  const order = [15, 3, 12, 9, 6, 1, 2, 4, 8, 7, 11, 13, 14, 5, 10];
  for (const m of order) {
    if (!targets.has(m)) continue;
    if (m === 5 || m === 10) {
      if (available.some((s) => s === 5 || s === 10) && tryDerive(m)) {
        available.push(m);
        continue;
      }
      const [a, b] = m === 5 ? [1, 4] : [2, 8];
      const ta = tiles[a]!;
      const tb = tiles[b]!;
      if (!ta.some((v) => v) || !tb.some((v) => v)) continue;
      const out = new Uint8Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const p = y * size + x;
          if (overlay) out[p] = ta[p] || tb[p]!;
          else {
            const firstSide = m === 5 ? x + y <= size - 1 : x >= y;
            out[p] = firstSide ? ta[p]! : tb[p]!;
          }
        }
      }
      tiles[m] = out;
      generated.push({ mask: m, from: [a, b], transform: "compose" });
      continue;
    }
    if (tryDerive(m)) available.push(m);
  }
  return generated;
}

// ---------------------------------------------------------------------------
// Dual grid

/**
 * Built-in test map: isolated cells, a 2×2 block, a ring (inner corners),
 * diagonal touches and 1-cell strips — every corner combination appears.
 */
export const TEST_MAP = [
  "..............",
  ".#..##..###...",
  "....##..#.#...",
  "........###...",
  ".#.#..........",
  "..#...#.......",
  ".#.#..#..####.",
  "......#.......",
  "..............",
];

/** Masks of the (W+1)×(H+1) visual tiles for a W×H cell map (true = upper terrain; outside = lower). */
export function dualGridMasks(cells: boolean[][]): number[][] {
  const H = cells.length;
  const W = cells[0]?.length ?? 0;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H ? cells[y]![x]! : false);
  const out: number[][] = [];
  for (let j = 0; j <= H; j++) {
    const row: number[] = [];
    for (let i = 0; i <= W; i++) {
      row.push((at(i - 1, j - 1) ? TL : 0) | (at(i, j - 1) ? TR : 0) | (at(i, j) ? BR : 0) | (at(i - 1, j) ? BL : 0));
    }
    out.push(row);
  }
  return out;
}

/** Parses map rows into upper/lower cells. Unknown characters are reported. */
export function parseTerrainMap(map: string[], legend: Record<string, "upper" | "lower">): { cells: boolean[][]; unknown: string[] } {
  const width = Math.max(...map.map((r) => [...r].length));
  const unknown = new Set<string>();
  const cells = map.map((row) => {
    const chars = [...row];
    return Array.from({ length: width }, (_, i) => {
      const ch = chars[i] ?? ".";
      const v = legend[ch];
      if (v === undefined) unknown.add(ch);
      return v === "upper";
    });
  });
  return { cells, unknown: [...unknown] };
}

export function defaultTerrainLegend(terrains?: { lower: string; upper: string }): Record<string, "upper" | "lower"> {
  const legend: Record<string, "upper" | "lower"> = { "#": "upper", "1": "upper", X: "upper", x: "upper", ".": "lower", "0": "lower", " ": "lower", _: "lower" };
  if (terrains) {
    const lo = terrains.lower[0];
    const up = terrains.upper[0];
    if (lo && up && lo.toLowerCase() !== up.toLowerCase()) {
      legend[lo.toLowerCase()] = "lower";
      legend[lo.toUpperCase()] = "lower";
      legend[up.toLowerCase()] = "upper";
      legend[up.toUpperCase()] = "upper";
    }
  }
  return legend;
}
