import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodePng } from "../src/png.js";
import { startHarness } from "./helpers.js";
import type { Harness } from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  await h.ok("load_palette", { name: "pico8", source: "builtin:pico8" });
  await h.ok("define_ramp", { paletteId: "pico8", name: "fire", indices: [3, 9, 10, 11] });
});

afterEach(async () => {
  await h.close();
});

/** A 30×30, 5-frame fireball whose radius grows each frame. */
async function makeFireball(): Promise<string> {
  const doc = await h.ok("create_document", { name: "fireball", kind: "effect", width: 30, height: 30 });
  const id = doc.data.docId as string;
  for (let f = 0; f < 5; f++) {
    if (f > 0) await h.ok("add_frame", { docId: id, durationMs: 80 });
    await h.ok("draw_ellipse", { docId: id, frame: f, cx: 15, cy: 15, rx: 6 + f * 2, ry: 6 + f * 2, c: 9, filled: true });
    await h.ok("radial_gradient", { docId: id, frame: f, cx: 15, cy: 15, radius: 6 + f * 2, rampName: "fire", onlyOpaque: true });
  }
  await h.ok("set_frame_duration", { docId: id, frame: 0, ms: 80 });
  await h.ok("tag_frames", { docId: id, tag: "loop", from: 0, to: 4 });
  return id;
}

describe("frames and tags", () => {
  it("adds, duplicates, moves and removes frames, keeping pixels attached", async () => {
    await h.ok("create_document", { name: "anim", kind: "sprite", width: 4, height: 1 });
    await h.ok("set_pixels", { docId: "doc_1", pixels: [{ x: 0, y: 0, c: 1 }] });
    await h.ok("add_frame", { docId: "doc_1", copyFrom: 0, durationMs: 50 });
    await h.ok("set_pixels", { docId: "doc_1", frame: 1, pixels: [{ x: 1, y: 0, c: 8 }] });
    await h.ok("duplicate_frame", { docId: "doc_1", frame: 1 });
    await h.ok("set_pixels", { docId: "doc_1", frame: 2, pixels: [{ x: 2, y: 0, c: 12 }] });
    const row = async (f: number) => (await h.ok("read_grid", { docId: "doc_1", frame: f })).data.rows[0];
    expect([await row(0), await row(1), await row(2)]).toEqual(["1___", "18__", "18c_"]);
    await h.ok("move_frame", { docId: "doc_1", from: 2, to: 0 });
    expect([await row(0), await row(1), await row(2)]).toEqual(["18c_", "1___", "18__"]);
    await h.ok("remove_frame", { docId: "doc_1", frame: 1 });
    const info = await h.ok("get_document_info", { docId: "doc_1" });
    expect(info.data.frames.map((f: { durationMs: number }) => f.durationMs)).toEqual([50, 50]);
    expect([await row(0), await row(1)]).toEqual(["18c_", "18__"]);
  });

  it("tags ranges with directions and reviews motion", async () => {
    const id = await makeFireball();
    await h.ok("tag_frames", { docId: id, tag: "start", from: 0, to: 1, direction: "pingpong" });
    const info = await h.ok("get_document_info", { docId: id });
    expect(info.data.tags).toEqual([
      { name: "start", from: 0, to: 1, direction: "pingpong" },
      { name: "loop", from: 2, to: 4, direction: "forward" },
    ]);
    const sheet = await h.ok("render_frames", { docId: id });
    expect(sheet.data.frames).toBe(5);
    expect(sheet.data.totalMs).toBe(400);
    expect(sheet.images.length).toBe(1);
    const onion = await h.ok("render_onion", { docId: id, frame: 2, before: 2, after: 1 });
    expect(onion.images.length).toBe(1);
    const tagged = await h.ok("render_frames", { docId: id, tag: "start" });
    expect(tagged.data.frames).toBe(2);
    const v = await h.ok("validate_document", { docId: id });
    expect(v.data.ok).toBe(true);
  });
});

describe("spritesheet export", () => {
  it("lays out a row with padding and extrusion", async () => {
    const id = await makeFireball();
    const out = await h.ok("export_spritesheet", { docId: id, layout: "row" });
    expect(out.data.size).toEqual({ w: 162, h: 34 });
    const meta = JSON.parse(fs.readFileSync(path.join(h.root, "assets/fireball.json"), "utf8"));
    expect(meta.frames).toHaveLength(5);
    const f0 = meta.frames[0];
    expect(f0).toEqual({
      name: "fireball_0",
      rect: { x: 2, y: 2, w: 30, h: 30 },
      durationMs: 80,
      pivotPx: { x: 15, y: 15 },
    });
    expect(meta.frames[4].rect).toEqual({ x: 130, y: 2, w: 30, h: 30 });
    expect(meta.tags).toEqual([{ name: "loop", from: 0, to: 4, direction: "forward" }]);

    // Extrusion: the 1px ring around frame 4 (radius 14 touches the frame edge) duplicates its edge pixels.
    const png = decodePng(fs.readFileSync(path.join(h.root, "assets/fireball.png")));
    const W = png.width;
    const at = (x: number, y: number) => png.indices![y * W + x]!;
    const r = meta.frames[4].rect;
    for (let y = r.y; y < r.y + r.h; y++) {
      expect(at(r.x - 1, y)).toBe(at(r.x, y));
      expect(at(r.x + r.w, y)).toBe(at(r.x + r.w - 1, y));
    }
    for (let x = r.x; x < r.x + r.w; x++) expect(at(x, r.y - 1)).toBe(at(x, r.y));
    // Padding between frames beyond the extrusion stays transparent.
    expect(at(0, 0)).toBe(0);

    const again = fs.readFileSync(path.join(h.root, "assets/fireball.png"));
    await h.ok("export_spritesheet", { docId: id, layout: "row" });
    expect(fs.readFileSync(path.join(h.root, "assets/fireball.png")).equals(again)).toBe(true);
  });

  it("supports grid and packed layouts", async () => {
    const id = await makeFireball();
    const grid = await h.ok("export_spritesheet", { docId: id, layout: "grid", name: "fb_grid", padding: 4, extrude: 2 });
    expect(grid.data.size).toEqual({ w: 4 + 3 * 34, h: 4 + 2 * 34 });
    const packed = await h.ok("export_spritesheet", { docId: id, layout: "packed", name: "fb_packed" });
    const meta = JSON.parse(fs.readFileSync(path.join(h.root, "assets/fb_packed.json"), "utf8"));
    const f0 = meta.frames[0];
    expect(f0.rect.w).toBe(13); // radius 6 → 13px wide
    expect(f0.offsetPx).toEqual({ x: 9, y: 9 });
    expect(f0.pivotPx).toEqual({ x: 6, y: 6 });
    expect(packed.data.size.w * packed.data.size.h).toBeLessThan(162 * 34);
    const bad = await h.call("export_spritesheet", { docId: id, padding: 1, extrude: 1 });
    expect(bad.isError).toBe(true);
  });

  it("exports additive layers to a separate glow image with the same layout", async () => {
    const id = await makeFireball();
    await h.ok("add_layer", { docId: id, name: "glow", blend: "additive" });
    for (let f = 0; f < 5; f++) await h.ok("draw_ellipse", { docId: id, layerId: "glow", frame: f, cx: 15, cy: 15, rx: 3, ry: 3, c: 2, filled: true });
    const out = await h.ok("export_spritesheet", { docId: id, tag: "loop" });
    expect(out.data.hasGlow).toBe(true);
    expect(out.data.files).toContain("assets/fireball_glow.png");
    const main = decodePng(fs.readFileSync(path.join(h.root, "assets/fireball.png")));
    const glow = decodePng(fs.readFileSync(path.join(h.root, "assets/fireball_glow.png")));
    expect([glow.width, glow.height]).toEqual([main.width, main.height]);
    const center = 17 * main.width + 17; // frame 0 center in the atlas
    expect(glow.indices![center]).toBe(2);
    expect(main.indices![center]).not.toBe(2);
    const meta = JSON.parse(fs.readFileSync(path.join(h.root, "assets/fireball.json"), "utf8"));
    expect(meta.glow).toBe("fireball_glow.png");
  });

  it("writes a GIF for human review", async () => {
    const id = await makeFireball();
    const out = await h.ok("export_gif", { docId: id, scale: 2 });
    expect(fs.readFileSync(out.data.path).subarray(0, 6).toString()).toBe("GIF89a");
    expect(out.data.size).toEqual({ w: 60, h: 60 });
    expect(out.data.relativePath).toBe("assets/.pixelmcp/previews/fireball.gif");
  });
});

describe("shading helpers", () => {
  it("outlines outside, inside and selectively", async () => {
    await h.ok("create_document", { name: "o", kind: "sprite", width: 5, height: 5 });
    await h.ok("draw_rect", { docId: "doc_1", x: 1, y: 1, w: 3, h: 3, c: 10, filled: true });
    await h.ok("auto_outline", { docId: "doc_1", c: 1 });
    let rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows).toEqual(["_111_", "1aaa1", "1aaa1", "1aaa1", "_111_"]);
    await h.ok("undo", { docId: "doc_1" });
    await h.ok("auto_outline", { docId: "doc_1", c: 1, connectivity: 8 });
    rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows[0]).toBe("11111");
    await h.ok("undo", { docId: "doc_1" });
    await h.ok("auto_outline", { docId: "doc_1", c: 1, mode: "inside" });
    rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows).toEqual(["_____", "_111_", "_1a1_", "_111_", "_____"]);
    await h.ok("undo", { docId: "doc_1" });
    await h.ok("auto_outline", { docId: "doc_1", c: 1, selective: true });
    rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows[0]).toBe("_999_"); // 10 → next darker in the fire ramp is 9
  });

  it("drops a shadow on a regenerated layer below", async () => {
    await h.ok("create_document", { name: "s", kind: "sprite", width: 4, height: 4 });
    await h.ok("set_pixels", { docId: "doc_1", pixels: [{ x: 1, y: 1, c: 8 }] });
    const r = await h.ok("drop_shadow", { docId: "doc_1", layerId: "layer_1", c: 1 });
    expect(r.data.shadowLayerId).toBe("layer_1_shadow");
    await h.ok("drop_shadow", { docId: "doc_1", layerId: "layer_1", c: 1, dx: 2, dy: 0 });
    const info = await h.ok("get_document_info", { docId: "doc_1" });
    expect(info.data.layers.map((l: { id: string }) => l.id)).toEqual(["layer_1_shadow", "layer_1"]);
    const shadow = (await h.ok("read_grid", { docId: "doc_1", layerId: "layer_1_shadow" })).data.rows;
    expect(shadow).toEqual(["____", "___1", "____", "____"]);
  });

  it("paints radial gradients and dithers", async () => {
    await h.ok("create_document", { name: "g", kind: "effect", width: 9, height: 9 });
    await h.ok("radial_gradient", { docId: "doc_1", cx: 4, cy: 4, radius: 4, rampName: "fire" });
    let rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows[4]![4]).toBe("b"); // center = lightest (11)
    expect(rows[4]![0]).toBe("3"); // rim = darkest (3)
    expect(rows[0]![0]).toBe("_"); // outside the radius
    await h.ok("create_document", { name: "d", kind: "sprite", width: 4, height: 2 });
    await h.ok("dither_region", { docId: "doc_2", c1: 1, c2: 8, pattern: "checker", ratio: 0.5 });
    rows = (await h.ok("read_grid", { docId: "doc_2" })).data.rows;
    expect(rows).toEqual(["8181", "1818"]);
    await h.ok("radial_gradient", { docId: "doc_1", cx: 4, cy: 4, radius: 4, rampName: "fire", dither: "bayer4" });
    const orphans = await h.ok("find_orphan_pixels", { docId: "doc_1" });
    expect(orphans.data.total).toBe(0);
  });

  it("shades a shape lit from the top-left", async () => {
    await h.ok("create_document", { name: "ball", kind: "sprite", width: 16, height: 16 });
    await h.ok("draw_ellipse", { docId: "doc_1", cx: 7.5, cy: 7.5, rx: 7.5, ry: 7.5, c: 9, filled: true });
    await h.ok("shade_with_ramp", { docId: "doc_1", rampName: "fire", lightDir: "top-left" });
    const rows: string[] = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    const where = (ch: string) => {
      const pts: Array<[number, number]> = [];
      rows.forEach((r, y) => [...r].forEach((c, x) => c === ch && pts.push([x, y])));
      return pts;
    };
    const mean = (pts: Array<[number, number]>) => pts.reduce((s, [x, y]) => s + x + y, 0) / pts.length;
    const lightest = where("b");
    const darkest = where("3");
    const base = where("a");
    expect(lightest.length).toBeGreaterThan(0);
    expect(darkest.length).toBeGreaterThan(0);
    expect(mean(lightest)).toBeLessThan(13); // highlight sits toward the top-left (x + y small)
    expect(mean(darkest)).toBeGreaterThan(17); // shadow toward the bottom-right
    expect(base.length).toBeGreaterThan(lightest.length); // base tone dominates the highlight
    expect(rows[8]![8]).toBe("a"); // center: base step
  });

  it("finds isolated pixels", async () => {
    await h.ok("create_document", { name: "n", kind: "sprite", width: 6, height: 6 });
    await h.ok("set_pixels", { docId: "doc_1", pixels: [{ x: 0, y: 0, c: 1 }, { x: 3, y: 3, c: 1 }, { x: 4, y: 3, c: 1 }] });
    const r = await h.ok("find_orphan_pixels", { docId: "doc_1" });
    expect(r.data.total).toBe(1);
    expect(r.data.frames[0].pixels).toEqual([{ x: 0, y: 0, c: 1 }]);
    const v = await h.ok("validate_document", { docId: "doc_1" });
    expect(v.data.warnings.map((w: { check: string }) => w.check)).toContain("orphan-pixels");
  });
});
