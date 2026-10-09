import { BL, BR, TL, TR } from "../src/tileset/corner15.js";
import type { Harness } from "./helpers.js";

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


/** Builds a 32×32 six-part character with down/up/right drawn and left mirrored from right. */
export async function buildCharacter(h: Harness, name = "hero"): Promise<string> {
  const r = await h.ok("create_document", { name, kind: "character", width: 32, height: 32 });
  const id = r.data.docId as string;
  const rect = (layerId: string, frame: number, x: number, y: number, w: number, hgt: number, c: number) =>
    h.ok("draw_rect", { docId: id, layerId, frame, x, y, w, h: hgt, c, filled: true });
  for (const frame of [0, 1, 3]) {
    // down = 0, up = 1, right = 3
    const side = frame === 3;
    await rect("body", frame, side ? 13 : 11, 14, side ? 7 : 10, 11, frame === 1 ? 2 : 13);
    await h.ok("draw_ellipse", { docId: id, layerId: "head", frame, cx: 15.5, cy: 9.5, rx: 5.5, ry: 5.5, c: frame === 1 ? 5 : 16, filled: true });
    await rect("hand_l", frame, side ? 18 : 20, 17, 3, 4, 16);
    await rect("hand_r", frame, side ? 12 : 9, 17, 3, 4, side ? 15 : 16);
    await rect("foot_l", frame, side ? 17 : 16, 24, 4, 4, 5);
    await rect("foot_r", frame, side ? 13 : 12, 24, 4, 4, side ? 6 : 5);
  }
  await h.ok("define_rig_part", { docId: id, layerId: "body", pivot: { x: 16, y: 24 } });
  await h.ok("define_rig_part", { docId: id, layerId: "head", pivot: { x: 16, y: 15 }, parent: "body", attachPoint: { x: 16, y: 15 } });
  await h.ok("define_rig_part", { docId: id, layerId: "hand_l", pivot: { x: 21, y: 17 }, parent: "body", attachPoint: { x: 21, y: 18 } });
  await h.ok("define_rig_part", { docId: id, layerId: "hand_r", pivot: { x: 11, y: 17 }, parent: "body", attachPoint: { x: 11, y: 18 } });
  await h.ok("define_rig_part", { docId: id, layerId: "foot_l", pivot: { x: 18, y: 24 }, parent: "body", attachPoint: { x: 18, y: 25 } });
  await h.ok("define_rig_part", { docId: id, layerId: "foot_r", pivot: { x: 14, y: 24 }, parent: "body", attachPoint: { x: 14, y: 25 } });
  for (const [part, x] of [["hand_l", 19], ["hand_r", 13], ["foot_l", 19], ["foot_r", 15]] as const) {
    await h.ok("define_rig_part", { docId: id, layerId: part, pivot: { x, y: 18 }, attachPoint: { x, y: part.startsWith("hand") ? 18 : 25 }, direction: "right" });
  }
  await h.ok("mirror_rig", { docId: id, fromDirection: "right", toDirection: "left" });
  await h.ok("define_pose", { docId: id, pose: { name: "idle_0", parts: {} } });
  await h.ok("define_pose", { docId: id, pose: { name: "idle_1", parts: { body: { dx: 0, dy: 1 }, foot_l: { dx: 0, dy: -1 }, foot_r: { dx: 0, dy: -1 } } } });
  const walk: Array<Record<string, { dx: number; dy: number }>> = [
    { foot_l: { dx: 1, dy: 0 }, foot_r: { dx: -1, dy: 0 }, hand_l: { dx: -1, dy: 0 }, hand_r: { dx: 1, dy: 0 } },
    { body: { dx: 0, dy: -1 }, foot_l: { dx: 0, dy: 1 }, foot_r: { dx: 0, dy: 1 } },
    { foot_l: { dx: -1, dy: 0 }, foot_r: { dx: 1, dy: 0 }, hand_l: { dx: 1, dy: 0 }, hand_r: { dx: -1, dy: 0 } },
    { body: { dx: 0, dy: -1 }, foot_l: { dx: 0, dy: 1 }, foot_r: { dx: 0, dy: 1 } },
  ];
  for (let i = 0; i < walk.length; i++) await h.ok("define_pose", { docId: id, pose: { name: `walk_${i}`, parts: walk[i] } });
  return id;
}
