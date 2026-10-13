import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brushStamp,
  curvePoints,
  pixelPerfect,
  polygonPoints,
  polylinePoints,
  removeLCorners,
  strokePoints,
} from "../src/raster.js";
import type { Point } from "../src/raster.js";
import { startHarness } from "./helpers.js";
import type { Harness } from "./helpers.js";

function render(points: Point[], w: number, h: number): string[] {
  const rows = Array.from({ length: h }, () => new Array<string>(w).fill("."));
  for (const [x, y] of points) rows[y]![x] = "#";
  return rows.map((r) => r.join(""));
}

/** Each step moves to an 8-neighbor and no pixel is an L corner between its neighbors. */
function expectCleanPath(path: Point[]) {
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]!;
    const [bx, by] = path[i]!;
    expect(Math.max(Math.abs(bx - ax), Math.abs(by - ay))).toBe(1);
  }
  for (let i = 2; i < path.length; i++) {
    const [ax, ay] = path[i - 2]!;
    const [cx, cy] = path[i]!;
    expect(Math.abs(cx - ax) === 1 && Math.abs(cy - ay) === 1 && Math.abs(path[i - 1]![0] - ax) + Math.abs(path[i - 1]![1] - ay) === 1).toBe(false);
  }
}

describe("organic raster primitives", () => {
  it("pixelPerfect drops L corners and duplicates, keeps diagonals", () => {
    const stair: Point[] = [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [3, 2]];
    expect(pixelPerfect(stair)).toEqual([[0, 0], [1, 1], [2, 2], [3, 2]]);
    const diag: Point[] = [[0, 0], [1, 1], [2, 2]];
    expect(pixelPerfect(diag)).toEqual(diag);
    expect(pixelPerfect([[0, 0], [0, 0], [1, 0]])).toEqual([[0, 0], [1, 0]]);
  });

  it("polylines are gap-free and pixel-perfect at the joints", () => {
    const path = polylinePoints([[0, 0], [4, 0], [4, 4], [8, 6]], false);
    expectCleanPath(path);
    expect(path[0]).toEqual([0, 0]);
    expect(path[path.length - 1]).toEqual([8, 6]);
    expect(path).not.toContainEqual([4, 0]); // the corner is cut
    expect(polylinePoints([[0, 0], [4, 0], [4, 4]], false, false)).toContainEqual([4, 0]);
  });

  it("curves pass through every control point without gaps or L corners", () => {
    const ctrl: Point[] = [[1, 14], [5, 4], [12, 2], [18, 9], [24, 3]];
    const path = curvePoints(ctrl, false);
    expectCleanPath(path);
    for (const p of [ctrl[0]!, ctrl[ctrl.length - 1]!]) expect(path).toContainEqual(p);
    for (const [x, y] of ctrl) {
      const near = path.some(([px, py]) => Math.max(Math.abs(px - x), Math.abs(py - y)) <= 1);
      expect(near).toBe(true);
    }
  });

  it("fills polygons at pixel centers including their outline", () => {
    const { outline, fill } = polygonPoints([[0, 0], [4, 0], [4, 3], [0, 3]], true);
    expect(render([...fill, ...outline], 5, 4)).toEqual(["#####", "#####", "#####", "#####"]);
    const tri = polygonPoints([[2, 0], [4, 4], [0, 4]], true);
    expect(render([...tri.fill, ...tri.outline], 5, 5)).toEqual(["..#..", "..##.", ".###.", ".####", "#####"]);
  });

  it("builds brush stamps and tapered strokes", () => {
    expect(brushStamp(1)).toEqual([[0, 0]]);
    expect(render(brushStamp(3, "circle").map(([x, y]) => [x + 1, y + 1]), 3, 3)).toEqual([".#.", "###", ".#."]);
    expect(brushStamp(3, "square")).toHaveLength(9);
    expect(brushStamp(5, "diamond")).toHaveLength(13);
    const path = polylinePoints([[2, 10], [2, 0]], false);
    const stroke = strokePoints(path, 5, 1);
    const widthAt = (y: number) => stroke.filter((p) => p[1] === y).length;
    expect(widthAt(10)).toBeGreaterThan(widthAt(1));
    expect(widthAt(0)).toBe(1);
  });

  it("removes L corners from existing lines but leaves fills alone", () => {
    const w = 6, h = 4;
    const cel = new Uint8Array(w * h);
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [3, 2]]) cel[y * w + x] = 5;
    expect(removeLCorners(cel, w, h, null, false)).toBe(2);
    expect(cel[1]).toBe(0);
    expect(cel[1 * w + 2]).toBe(0);
    const block = new Uint8Array(16).fill(3);
    expect(removeLCorners(block, 4, 4, null, false)).toBe(0);
    // a dark line over a fill: the corner takes the fill color, not transparency
    const over = new Uint8Array(9).fill(7);
    over[0] = 1; over[1] = 1; over[4] = 1; over[5] = 1;
    // row0: 1 1 7 / row1: 7 1 1 → corner (1,0) between (0,0) and (1,1)
    expect(removeLCorners(over, 3, 3, null, false)).toBe(1);
    expect(over[1]).toBe(7);
  });
});

describe("organic drawing tools", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
    await h.ok("load_palette", { name: "pico8", source: "builtin:pico8" });
    await h.ok("create_document", { name: "org", kind: "sprite", width: 12, height: 12 });
  });
  afterEach(async () => {
    await h.close();
  });
  const grid = async () => (await h.ok("read_grid", { docId: "doc_1" })).data.rows as string[];

  it("draw_path draws pixel-perfect polylines, curves and tapered strokes", async () => {
    await h.ok("draw_path", { docId: "doc_1", points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }], c: 8 });
    expect((await grid()).slice(0, 4).map((r) => r.slice(0, 5))).toEqual(["888__", "___8_", "___8_", "___8_"]);
    const curve = await h.ok("draw_path", { docId: "doc_1", points: [{ x: 1, y: 11 }, { x: 5, y: 6 }, { x: 10, y: 8 }], curve: true, width: 3, widthEnd: 1, c: 12 });
    expect(curve.data.changed).toBeGreaterThan(curve.data.pathLength);
    const bad = await h.call("draw_path", { docId: "doc_1", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], c: 99 });
    expect(bad.isError).toBe(true);
  });

  it("draw_polygon fills with an outline color and mirrors under symmetry", async () => {
    await h.ok("set_symmetry", { docId: "doc_1", mode: "horizontal" });
    await h.ok("draw_polygon", { docId: "doc_1", points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }], filled: true, c: 12, outline: 8 });
    const rows = await grid();
    expect(rows[1]).toBe("8cc8____8cc8");
    expect(rows[0]).toBe("8888____8888");
  });

  it("spray is reproducible by seed and respects within", async () => {
    await h.ok("draw_rect", { docId: "doc_1", x: 3, y: 3, w: 6, h: 6, c: 4, filled: true });
    const a = await h.ok("spray", { docId: "doc_1", x: 6, y: 6, radius: 6, density: 0.6, colors: [8, 12], within: "opaque", seed: 42 });
    expect(a.data.seed).toBe(42);
    const first = await grid();
    for (const [y, row] of first.entries()) for (const [x, ch] of [...row].entries()) {
      if (x < 3 || x > 8 || y < 3 || y > 8) expect(ch).toBe("_");
    }
    expect(first.join("")).toMatch(/[8c]/);
    await h.ok("undo", { docId: "doc_1" });
    await h.ok("spray", { docId: "doc_1", x: 6, y: 6, radius: 6, density: 0.6, colors: [8, 12], within: "opaque", seed: 42 });
    expect(await grid()).toEqual(first);

    await h.ok("spray", { docId: "doc_1", x: 6, y: 6, radius: 6, density: 0.8, stamp: { rows: [".g.", "ggg"], legend: { g: 11 } }, within: "transparent", seed: 1 });
    const after = await grid();
    for (let y = 3; y <= 8; y++) expect(after[y]!.slice(3, 9)).not.toMatch(/b/);
    expect(after.join("")).toMatch(/b/);
    const none = await h.call("spray", { docId: "doc_1", x: 1, y: 1, radius: 2 });
    expect(none.isError).toBe(true);
  });

  it("set_pixels pixelPerfect and the pixel_perfect cleanup tool remove L corners", async () => {
    const stroke = [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]].map(([x, y]) => ({ x, y, c: 8 }));
    await h.ok("set_pixels", { docId: "doc_1", pixels: stroke, pixelPerfect: true });
    expect((await grid()).slice(0, 3).map((r) => r.slice(0, 3))).toEqual(["8__", "_8_", "__8"]);
    await h.ok("clear", { docId: "doc_1" });
    await h.ok("draw_grid", { docId: "doc_1", x: 0, y: 0, legend: { a: 8, f: 12 }, rows: ["aa.....", ".aa....", "..aa...", "....fff", "....fff"] });
    const r = await h.ok("pixel_perfect", { docId: "doc_1" });
    expect(r.data.removed).toBe(2);
    expect((await grid()).slice(0, 5).map((row) => row.slice(0, 7))).toEqual(["8______", "_8_____", "__88___", "____ccc", "____ccc"]);
  });
});
