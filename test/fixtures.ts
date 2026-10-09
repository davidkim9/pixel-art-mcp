import { BL, BR, TL, TR } from "../src/tileset/corner15.js";

/**
 * Corner15 tile rows from the quadrant model: a quadrant is grass ("g") if its
 * corner is upper terrain, with a dark outline ("o") on grass pixels that touch
 * lower terrain inside the tile. Satisfies the edge-matching rule by construction.
 */
export function cornerTile(mask: number, size: number): string[] {
  const half = size / 2;
  const upper = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    const bit = y < half ? (x < half ? TL : TR) : x < half ? BL : BR;
    return (mask & bit) !== 0;
  };
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = "";
    for (let x = 0; x < size; x++) {
      if (!upper(x, y)) {
        row += "_";
        continue;
      }
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => upper(x + dx!, y + dy!) === false);
      // Texture symmetric under flips/rotations, so derived tiles match the model.
      const a = Math.min(x, size - 1 - x);
      const b = Math.min(y, size - 1 - y);
      row += edge ? "o" : (a + b) % 5 === 0 ? "l" : "g";
    }
    rows.push(row);
  }
  return rows;
}

