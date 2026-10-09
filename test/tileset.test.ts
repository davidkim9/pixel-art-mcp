import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodePng } from "../src/png.js";
import { DIHEDRAL, transformSquare } from "../src/selection.js";
import { BLOB47_MASKS, BLOB_MASK_TO_FRAME, BLOB_TEST_MAP, blobMaskAt, reduceBlobMask } from "../src/tileset/blob47.js";
import { BL, BR, TEST_MAP, TL, TR, dualGridMasks, parseTerrainMap, defaultTerrainLegend, transformMask } from "../src/tileset/corner15.js";
import { cornerTile } from "./fixtures.js";
import { startHarness } from "./helpers.js";
import type { Harness } from "./helpers.js";

const LEGEND = { g: 12, o: 4, l: 11 };

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
  await h.ok("load_palette", { name: "pico8", source: "builtin:pico8" });
});
afterEach(async () => {
  await h.close();
});

describe("corner masks", () => {
  it("transforms masks consistently with image transforms", () => {
    const size = 4;
    for (let mask = 0; mask < 16; mask++) {
      const img = new Uint8Array(size * size);
      if (mask & TL) img[0] = 1;
      if (mask & TR) img[size - 1] = 1;
      if (mask & BR) img[size * size - 1] = 1;
      if (mask & BL) img[(size - 1) * size] = 1;
      for (const t of DIHEDRAL) {
        const out = transformSquare(img, size, t);
        const got = (out[0] ? TL : 0) | (out[size - 1] ? TR : 0) | (out[size * size - 1] ? BR : 0) | (out[(size - 1) * size] ? BL : 0);
        expect(transformMask(mask, t)).toBe(got);
      }
    }
  });

  it("built-in test map contains every corner combination", () => {
    const { cells } = parseTerrainMap(TEST_MAP, defaultTerrainLegend());
    const masks = new Set(dualGridMasks(cells).flat());
    expect([...masks].sort((a, b) => a - b)).toEqual([...Array(16).keys()]);
    expect(dualGridMasks(cells).length).toBe(cells.length + 1);
  });

  it("has 47 blob masks and a complete lookup table", () => {
    expect(BLOB47_MASKS.length).toBe(47);
    for (let m = 0; m < 256; m++) {
      expect(reduceBlobMask(reduceBlobMask(m))).toBe(reduceBlobMask(m));
      expect(BLOB47_MASKS[BLOB_MASK_TO_FRAME[m]!]).toBe(reduceBlobMask(m));
    }
    const { cells } = parseTerrainMap(BLOB_TEST_MAP, defaultTerrainLegend());
    const used = new Set<number>();
    cells.forEach((row, y) => row.forEach((c, x) => c && used.add(blobMaskAt(cells, x, y))));
    expect(used.size).toBe(47);
  });
});

describe("corner15 transition sets", () => {
  async function makeSet(): Promise<string> {
    const r = await h.ok("create_transition_set", { name: "grass_dirt", tileSize: 16, terrains: { lower: "dirt", upper: "grass" } });
    const id = r.data.docId as string;
    expect(r.data.frames).toBe(16);
    expect(r.data.layers).toEqual(["tiles", "guide"]);
    for (const m of [15, 3, 1, 7]) {
      await h.ok("draw_grid", { docId: id, layerId: "tiles", frame: m, x: 0, y: 0, legend: LEGEND, rows: cornerTile(m, 16) });
    }
    return id;
  }

  it("generates, checks, previews and exports a set that satisfies the edge rule", async () => {
    const id = await makeSet();
    const before = await h.ok("check_transition_set", { docId: id });
    expect(before.data.ok).toBe(false);
    expect(before.data.missing).toEqual([2, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]);

    const gen = await h.ok("generate_autotile", { docId: id, sources: [15, 3, 1, 7] });
    expect(gen.data.stillMissing).toEqual([]);
    const composed = gen.data.generated.filter((g: { transform: string }) => g.transform === "compose").map((g: { mask: number }) => g.mask);
    expect(composed.sort()).toEqual([10, 5]);
    // Generated tiles equal the quadrant model exactly.
    for (let m = 1; m < 16; m++) {
      const rows = (await h.ok("read_grid", { docId: id, layerId: "tiles", frame: m, legend: LEGEND })).data.rows;
      expect(rows).toEqual(cornerTile(m, 16));
    }

    const check = await h.ok("check_transition_set", { docId: id });
    expect(check.data).toMatchObject({ ok: true, missing: [], mismatchCount: 0, baseNotEmpty: false });
    expect(check.images.length).toBe(1);
    expect((await h.ok("validate_document", { docId: id })).data.errors).toEqual([]);

    const terrain = await h.ok("render_terrain_preview", { docId: id });
    expect(terrain.data.usedMasks).toEqual([...Array(16).keys()]);
    expect(terrain.data.missingTiles).toEqual([]);
    expect(terrain.data.builtInMap).toBe(true);
    const custom = await h.ok("render_terrain_preview", { docId: id, map: ["gd", "dg"] });
    expect(custom.data.cells).toEqual({ w: 2, h: 2 });

    const out = await h.ok("export_tileset", { docId: id });
    expect(out.data.size).toEqual({ w: 74, h: 74 });
    const meta = JSON.parse(fs.readFileSync(path.join(h.root, "assets/grass_dirt.json"), "utf8"));
    expect(meta.frames).toHaveLength(16);
    meta.frames.forEach((f: { mask: number; rect: { x: number; y: number } }, i: number) => {
      expect(f.mask).toBe(i);
      expect(f.rect).toMatchObject({ x: 2 + (i % 4) * 18, y: 2 + Math.floor(i / 4) * 18 });
    });
    expect(meta.tileset).toMatchObject({ template: "corner15", cornerOrder: ["TL", "TR", "BR", "BL"], frameIndexIsMask: true, overlay: true });
    const png = decodePng(fs.readFileSync(path.join(h.root, "assets/grass_dirt.png")));
    // Slot 0 is empty (overlay mode) and the guide layer is not exported.
    for (let y = 2; y < 18; y++) for (let x = 2; x < 18; x++) expect(png.indices![y * 74 + x]).toBe(0);
    // Extrusion around the full tile (slot 15).
    const r15 = meta.frames[15].rect;
    expect(png.indices![(r15.y - 1) * 74 + r15.x]).toBe(png.indices![r15.y * 74 + r15.x]);
  });

  it("reports edge mismatches and blocks export", async () => {
    const id = await makeSet();
    await h.ok("generate_autotile", { docId: id });
    await h.ok("set_pixels", { docId: id, layerId: "tiles", frame: 3, pixels: [{ x: 15, y: 2, c: 8 }] });
    const check = await h.ok("check_transition_set", { docId: id });
    expect(check.data.ok).toBe(false);
    expect(check.data.mismatches).toContainEqual({ side: "right", corners: "TR=1,BR=0", tile: 3, reference: 2, positions: [2] });
    const out = await h.call("export_tileset", { docId: id });
    expect(out.isError).toBe(true);
    expect(out.data.error).toMatch(/edge-matching/);
  });

  it("renders over a base tile", async () => {
    const id = await makeSet();
    await h.ok("generate_autotile", { docId: id });
    const base = await h.ok("create_document", { name: "dirt", kind: "tileset", width: 16, height: 16 });
    await h.ok("draw_rect", { docId: base.data.docId, x: 0, y: 0, w: 16, h: 16, c: 5, filled: true });
    const r = await h.ok("render_terrain_preview", { docId: id, map: ["dgd"], base: { docId: base.data.docId } });
    expect(r.images.length).toBe(1);
  });
});

describe("seams and wrap mode", () => {
  it("flags seams on tiles whose opposite edges clash", async () => {
    await h.ok("create_document", { name: "stone", kind: "tileset", width: 8, height: 8 });
    await h.ok("draw_rect", { docId: "doc_1", x: 0, y: 0, w: 8, h: 8, c: 12, filled: true });
    await h.ok("draw_line", { docId: "doc_1", x0: 0, y0: 0, x1: 0, y1: 7, c: 2 });
    const bad = await h.ok("check_seams", { docId: "doc_1" });
    expect(bad.data.verdict).toBe("visible");
    expect(bad.data.horizontal.flagged.length).toBe(8);
    expect(bad.data.vertical.flagged.length).toBe(0);
    const v = await h.ok("validate_document", { docId: "doc_1" });
    expect(v.data.warnings.map((w: { check: string }) => w.check)).toContain("tile-seams");

    await h.ok("dither_region", { docId: "doc_1", c1: 12, c2: 4, pattern: "checker", ratio: 0.5 });
    const good = await h.ok("check_seams", { docId: "doc_1" });
    expect(good.data.verdict).toBe("seamless");
    expect(good.images.length).toBe(1);
  });

  it("wraps drawing across tile edges when wrap mode is on", async () => {
    await h.ok("create_document", { name: "wrap", kind: "tileset", width: 8, height: 8 });
    await h.ok("set_wrap_mode", { docId: "doc_1", enabled: true });
    await h.ok("draw_line", { docId: "doc_1", x0: 6, y0: 0, x1: 9, y1: 0, c: 8 });
    const rows = (await h.ok("read_grid", { docId: "doc_1", h: 1 })).data.rows;
    expect(rows[0]).toBe("88____88");
    const tiled = await h.ok("render_tiled", { docId: "doc_1", repeat: 3 });
    expect(tiled.images.length).toBe(1);
  });
});

describe("blob47 sets", () => {
  it("generates the 47 tiles from five source tiles", async () => {
    const r = await h.ok("create_transition_set", { name: "blob", tileSize: 8, template: "blob47", terrains: { lower: "water", upper: "sand" } });
    const id = r.data.docId as string;
    expect(r.data.frames).toBe(47);
    // Source tiles: a quadrant shows "edge" where the neighbour is missing.
    const tileFor = (n: boolean, e: boolean, s: boolean, w: boolean, inner: boolean) => {
      const rows: string[] = [];
      for (let y = 0; y < 8; y++) {
        let row = "";
        for (let x = 0; x < 8; x++) {
          const edge = (!n && y === 0) || (!s && y === 7) || (!w && x === 0) || (!e && x === 7) || (inner && (x === 0 || x === 7) && (y === 0 || y === 7));
          row += edge ? "o" : "g";
        }
        rows.push(row);
      }
      return rows;
    };
    const sources: Array<[number, string[]]> = [
      [0, tileFor(false, false, false, false, false)],
      [17, tileFor(true, false, true, false, false)],
      [68, tileFor(false, true, false, true, false)],
      [85, tileFor(true, true, true, true, true)],
      [255, tileFor(true, true, true, true, false)],
    ];
    for (const [mask, rows] of sources) {
      await h.ok("draw_grid", { docId: id, layerId: "tiles", frame: BLOB47_MASKS.indexOf(mask), x: 0, y: 0, legend: LEGEND, rows });
    }
    const gen = await h.ok("generate_autotile", { docId: id });
    expect(gen.data.generated.length).toBe(42);
    const check = await h.ok("check_transition_set", { docId: id });
    expect(check.data.ok).toBe(true);
    const terrain = await h.ok("render_terrain_preview", { docId: id });
    expect(terrain.data.missingTiles).toEqual([]);
    const out = await h.ok("export_tileset", { docId: id });
    expect(out.data.tiles).toBe(47);
    const meta = JSON.parse(fs.readFileSync(path.join(h.root, "assets/blob.json"), "utf8"));
    expect(meta.tileset.maskToFrame).toHaveLength(256);
    expect(meta.frames[46].mask).toBe(255);
  });
});
