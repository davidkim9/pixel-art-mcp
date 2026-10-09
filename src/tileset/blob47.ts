/**
 * Blob47 template: cell-centered tiles chosen by the 8 neighbours.
 * mask bits: N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128. A diagonal bit
 * only counts when both adjacent edge bits are set, leaving 47 distinct tiles.
 */

export const N = 1;
export const NE = 2;
export const E = 4;
export const SE = 8;
export const S = 16;
export const SW = 32;
export const W = 64;
export const NW = 128;
export const NEIGHBOR_ORDER = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export function reduceBlobMask(mask: number): number {
  let m = mask & 255;
  if (!(m & N && m & E)) m &= ~NE;
  if (!(m & S && m & E)) m &= ~SE;
  if (!(m & S && m & W)) m &= ~SW;
  if (!(m & N && m & W)) m &= ~NW;
  return m;
}

/** The 47 reduced masks in ascending order; frame i of a blob47 set holds BLOB47_MASKS[i]. */
export const BLOB47_MASKS: number[] = [...new Set(Array.from({ length: 256 }, (_, m) => reduceBlobMask(m)))].sort((a, b) => a - b);

/** Raw 8-bit neighbour mask → frame index (256 entries). */
export const BLOB_MASK_TO_FRAME: number[] = Array.from({ length: 256 }, (_, m) => BLOB47_MASKS.indexOf(reduceBlobMask(m)));

export function blobMaskName(mask: number): string {
  if (mask === 0) return "isolated";
  if (mask === 255) return "full";
  return NEIGHBOR_ORDER.filter((_, i) => mask & (1 << i)).join("+");
}

export function blobFrameLabel(mask: number): string {
  return `blob ${mask} ${blobMaskName(mask)}`;
}

export type QuadrantVariant = "outer" | "vertical" | "horizontal" | "inner" | "fill";

/** Source tiles that each provide one quadrant variant in all four quadrants. */
export const BLOB_SOURCES: Record<QuadrantVariant, number> = {
  outer: 0,
  vertical: N | S,
  horizontal: E | W,
  inner: N | E | S | W,
  fill: 255,
};

type Quadrant = "TL" | "TR" | "BL" | "BR";

function variant(mask: number, q: Quadrant): QuadrantVariant {
  const [v, hz, d] = q === "TL" ? [N, W, NW] : q === "TR" ? [N, E, NE] : q === "BL" ? [S, W, SW] : [S, E, SE];
  const hasV = (mask & v) !== 0;
  const hasH = (mask & hz) !== 0;
  if (!hasV && !hasH) return "outer";
  if (hasV && !hasH) return "vertical";
  if (!hasV && hasH) return "horizontal";
  return mask & d ? "fill" : "inner";
}

/**
 * Builds a tile from quadrants of the five source tiles (RPG-Maker style), so
 * lighting stays consistent (nothing is rotated).
 */
export function composeBlobTile(mask: number, sources: Record<QuadrantVariant, Uint8Array>, size: number): Uint8Array {
  const out = new Uint8Array(size * size);
  const half = Math.floor(size / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const q: Quadrant = y < half ? (x < half ? "TL" : "TR") : x < half ? "BL" : "BR";
      out[y * size + x] = sources[variant(mask, q)][y * size + x]!;
    }
  }
  return out;
}

/** World-cell neighbour mask for a cell map (outside = lower terrain). */
export function blobMaskAt(cells: boolean[][], x: number, y: number): number {
  const at = (cx: number, cy: number) => cy >= 0 && cy < cells.length && cx >= 0 && cx < (cells[cy]?.length ?? 0) && cells[cy]![cx]!;
  const dirs: Array<[number, number, number]> = [
    [0, -1, N], [1, -1, NE], [1, 0, E], [1, 1, SE], [0, 1, S], [-1, 1, SW], [-1, 0, W], [-1, -1, NW],
  ];
  let m = 0;
  for (const [dx, dy, bit] of dirs) if (at(x + dx, y + dy)) m |= bit;
  return reduceBlobMask(m);
}

/**
 * Built-in blob47 test map: every one of the 47 configurations appears as the
 * center of its own 3×3 block (blocks separated by one empty cell).
 */
export const BLOB_TEST_MAP: string[] = (() => {
  const perRow = 8;
  const rows = Math.ceil(BLOB47_MASKS.length / perRow);
  const grid = Array.from({ length: 1 + rows * 4 }, () => new Array<string>(1 + perRow * 4).fill("."));
  const offsets: Array<[number, number, number]> = [
    [0, -1, N], [1, -1, NE], [1, 0, E], [1, 1, SE], [0, 1, S], [-1, 1, SW], [-1, 0, W], [-1, -1, NW],
  ];
  BLOB47_MASKS.forEach((mask, i) => {
    const cx = 2 + (i % perRow) * 4;
    const cy = 2 + Math.floor(i / perRow) * 4;
    grid[cy]![cx] = "#";
    for (const [dx, dy, bit] of offsets) if (mask & bit) grid[cy + dy]![cx + dx] = "#";
  });
  return grid.map((r) => r.join(""));
})();
