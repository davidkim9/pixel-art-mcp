import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodePng } from "../src/png.js";
import { PICO8, pngjsDecode, startHarness } from "./helpers.js";
import type { Harness } from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  await h.ok("load_palette", { name: "pico8", source: "builtin:pico8" });
});

afterEach(async () => {
  await h.close();
});

describe("project & palette", () => {
  it("lists the tools and loads palettes from several sources", async () => {
    const tools = await h.client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const n of ["draw_grid", "read_grid", "render_preview", "export_png", "load_palette", "validate_document"]) expect(names).toContain(n);

    const gpl = await h.ok("load_palette", { name: "Tiny", source: "GIMP Palette\nName: Tiny\n0 0 0 black\n255 255 255 white\n" });
    expect(gpl.data).toMatchObject({ paletteId: "tiny", colors: 2, isDefault: false });
    const list = await h.ok("list_palettes");
    expect(list.data.defaultPaletteId).toBe("pico8");
    const p = await h.ok("get_palette", { id: "pico8" });
    expect(p.data.colors["1"]).toBe(PICO8[0]);
    expect(p.data.colors["0"]).toBe("transparent");

    fs.writeFileSync(path.join(h.root, "pal.hex"), "ff0000\n00ff00\n");
    const fromFile = await h.ok("load_palette", { name: "File Pal", source: "pal.hex" });
    expect(fromFile.data.colors).toBe(2);
    const outside = await h.call("load_palette", { name: "x", source: "/etc/hosts.hex" });
    expect(outside.isError).toBe(true);
  });

  it("defines ramps and renders the palette", async () => {
    const ramp = await h.ok("define_ramp", { paletteId: "pico8", name: "fire", indices: [3, 9, 10, 11] });
    expect(ramp.data.warnings).toEqual([]);
    const bad = await h.ok("define_ramp", { paletteId: "pico8", name: "backwards", indices: [8, 1] });
    expect(bad.data.warnings.length).toBe(1);
    const img = await h.ok("render_palette", { id: "pico8" });
    expect(img.images.length).toBe(1);
    expect(pngjsDecode(img.images[0]!).width).toBeGreaterThan(100);
  });
});

describe("drawing", () => {
  it("draws with draw_grid and reads it back with read_grid", async () => {
    const doc = await h.ok("create_document", { name: "hero", kind: "sprite", width: 16, height: 16 });
    expect(doc.data.docId).toBe("doc_1");
    expect(doc.data.warnings).toEqual([]);
    const drawn = await h.ok("draw_grid", {
      docId: "doc_1",
      x: 4,
      y: 2,
      legend: { o: 1, s: 13, h: 15 },
      rows: ["_ooo_", "osssh", "osssh", "_ooo_"],
      preview: true,
    });
    expect(drawn.data.changed).toBe(16);
    expect(drawn.images.length).toBe(1);
    const read = await h.ok("read_grid", { docId: "doc_1", x: 4, y: 2, w: 5, h: 4 });
    const { rows, legend } = read.data;
    expect(legend).toEqual({ "1": 1, d: 13, f: 15 });
    expect(rows).toEqual(["_111_", "1dddf", "1dddf", "_111_"]);
    // Feeding read_grid output back into draw_grid changes nothing.
    const again = await h.ok("draw_grid", { docId: "doc_1", x: 4, y: 2, legend, rows });
    expect(again.data.changed).toBe(0);
    // "." leaves pixels unchanged
    const dots = await h.ok("draw_grid", { docId: "doc_1", x: 4, y: 2, legend: { x: 8 }, rows: [".....", ".x...", ".....", "....."] });
    expect(dots.data.changed).toBe(1);
    const bad = await h.call("draw_grid", { docId: "doc_1", x: 0, y: 0, legend: {}, rows: ["ab"] });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toMatch(/not in legend/);
  });

  it("draws primitives, fills, replaces and clears", async () => {
    await h.ok("create_document", { name: "prims", kind: "sprite", width: 8, height: 8 });
    await h.ok("draw_rect", { docId: "doc_1", x: 0, y: 0, w: 8, h: 8, c: 1 });
    await h.ok("flood_fill", { docId: "doc_1", x: 3, y: 3, c: 12 });
    await h.ok("draw_line", { docId: "doc_1", x0: 1, y0: 1, x1: 6, y1: 6, c: 8 });
    let rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows[0]).toBe("11111111");
    expect(rows[1]).toBe("18ccccc1");
    expect(rows[6]).toBe("1ccccc81");
    const replaced = await h.ok("replace_color", { docId: "doc_1", from: 12, to: 11, region: { x: 0, y: 0, w: 4, h: 8 } });
    expect(replaced.data.changed).toBeGreaterThan(0);
    await h.ok("clear", { docId: "doc_1", region: { x: 0, y: 0, w: 8, h: 1 } });
    rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows[0]).toBe("________");
    await h.ok("draw_ellipse", { docId: "doc_1", cx: 3.5, cy: 3.5, rx: 3.5, ry: 3.5, c: 9, filled: true });
    rows = (await h.ok("read_grid", { docId: "doc_1", x: 0, y: 0, w: 8, h: 1 })).data.rows;
    expect(rows[0]).toBe("__9999__");
  });

  it("mirrors drawing with symmetry and wraps in wrap mode", async () => {
    await h.ok("create_document", { name: "sym", kind: "sprite", width: 8, height: 4 });
    await h.ok("set_symmetry", { docId: "doc_1", mode: "horizontal" });
    await h.ok("set_pixels", { docId: "doc_1", pixels: [{ x: 0, y: 0, c: 8 }, { x: 2, y: 1, c: 9 }] });
    const rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows[0]).toBe("8______8");
    expect(rows[1]).toBe("__9__9__");
    await h.ok("set_symmetry", { docId: "doc_1", mode: "none" });
    await h.ok("set_pixels", { docId: "doc_1", pixels: [{ x: 1, y: 3, c: 1 }] });
    expect((await h.ok("read_grid", { docId: "doc_1" })).data.rows[3]).toBe("_1______");
  });

  it("refuses locked layers and undoes changes", async () => {
    await h.ok("create_document", { name: "undo", kind: "sprite", width: 8, height: 8 });
    await h.ok("draw_rect", { docId: "doc_1", x: 0, y: 0, w: 2, h: 2, c: 8, filled: true });
    await h.ok("draw_rect", { docId: "doc_1", x: 0, y: 0, w: 8, h: 8, c: 12, filled: true });
    await h.ok("undo", { docId: "doc_1" });
    const rows = (await h.ok("read_grid", { docId: "doc_1", w: 3, h: 3 })).data.rows;
    expect(rows).toEqual(["88_", "88_", "___"]);
    await h.ok("set_layer_properties", { docId: "doc_1", layerId: "layer_1", locked: true });
    const locked = await h.call("draw_line", { docId: "doc_1", x0: 0, y0: 0, x1: 3, y1: 0, c: 1 });
    expect(locked.isError).toBe(true);
    expect(locked.data.error).toMatch(/locked/);
  });

  it("manages layers and composes them in read_grid", async () => {
    await h.ok("create_document", { name: "layers", kind: "sprite", width: 4, height: 1 });
    await h.ok("set_pixels", { docId: "doc_1", layerId: "layer_1", pixels: [{ x: 0, y: 0, c: 1 }, { x: 1, y: 0, c: 1 }] });
    const added = await h.ok("add_layer", { docId: "doc_1", name: "Top" });
    expect(added.data.layerId).toBe("top");
    await h.ok("set_pixels", { docId: "doc_1", layerId: "top", pixels: [{ x: 1, y: 0, c: 8 }] });
    expect((await h.ok("read_grid", { docId: "doc_1" })).data.rows).toEqual(["18__"]);
    await h.ok("reorder_layer", { docId: "doc_1", layerId: "top", newIndex: 0 });
    expect((await h.ok("read_grid", { docId: "doc_1" })).data.rows).toEqual(["11__"]);
    await h.ok("set_layer_visibility", { docId: "doc_1", layerId: "layer_1", visible: false });
    expect((await h.ok("read_grid", { docId: "doc_1" })).data.rows).toEqual(["_8__"]);
    const dup = await h.ok("duplicate_layer", { docId: "doc_1", layerId: "top" });
    expect(dup.data.layerId).toBe("top_copy");
    await h.ok("remove_layer", { docId: "doc_1", layerId: "top_copy" });
    const info = await h.ok("get_document_info", { docId: "doc_1" });
    expect(info.data.layers.map((l: { id: string }) => l.id)).toEqual(["top", "layer_1"]);
    const missing = await h.call("draw_line", { docId: "doc_1", x0: 0, y0: 0, x1: 1, y1: 0, c: 1 });
    expect(missing.data.error).toMatch(/pass layerId/);
  });

  it("selects, copies, pastes, flips, rotates and offsets", async () => {
    await h.ok("create_document", { name: "sel", kind: "sprite", width: 6, height: 4 });
    await h.ok("draw_grid", { docId: "doc_1", x: 0, y: 0, legend: { a: 8, b: 12 }, rows: ["ab", "bb"] });
    await h.ok("select_rect", { docId: "doc_1", x: 0, y: 0, w: 2, h: 2 });
    await h.ok("copy_selection", { docId: "doc_1" });
    await h.ok("paste", { docId: "doc_1", x: 4, y: 2 });
    await h.ok("flip_selection", { docId: "doc_1", axis: "horizontal" });
    let rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows).toEqual(["8c____", "cc____", "____c8", "____cc"]);
    await h.ok("deselect", { docId: "doc_1" });
    await h.ok("select_by_color", { docId: "doc_1", contiguous: false, index: 8 });
    const moved = await h.ok("move_selection", { docId: "doc_1", dx: 0, dy: 1 });
    expect(moved.data.selection.pixels).toBe(2);
    await h.ok("deselect", { docId: "doc_1" });
    await h.ok("offset_layer", { docId: "doc_1", dx: 1, dy: 0, wrap: true });
    rows = (await h.ok("read_grid", { docId: "doc_1" })).data.rows;
    expect(rows).toEqual(["__c___", "_8c___", "_____c", "8____c"]);
  });
});

describe("previews", () => {
  it("renders previews with grid and rulers", async () => {
    await h.ok("create_document", { name: "p", kind: "sprite", width: 16, height: 16 });
    const r = await h.ok("render_preview", { docId: "doc_1", scale: 8 });
    const img = pngjsDecode(r.images[0]!);
    expect(img.width).toBeGreaterThanOrEqual(128);
    expect(img.width).toBeLessThan(128 + 40);
    const big = await h.ok("create_document", { name: "big", kind: "sprite", width: 512, height: 512 });
    const clamped = await h.ok("render_preview", { docId: big.data.docId, scale: 8 });
    expect(clamped.data.scale).toBeLessThan(8);
  });
});

describe("export", () => {
  it("exports an indexed PNG, sidecar metadata and TS manifest deterministically", async () => {
    await h.ok("create_document", { name: "coin", kind: "sprite", width: 8, height: 8 });
    await h.ok("draw_ellipse", { docId: "doc_1", cx: 3.5, cy: 3.5, rx: 3.5, ry: 3.5, c: 10, filled: true });
    const out = await h.ok("export_png", { docId: "doc_1" });
    expect(out.data.files).toEqual(["assets/coin.png", "assets/coin.json"]);
    expect(out.data.manifest).toBe("assets/assets.generated.ts");
    const pngPath = path.join(h.root, "assets/coin.png");
    const png = fs.readFileSync(pngPath);
    const dec = decodePng(png);
    expect(dec.colorType).toBe(3);
    expect(dec.palette!.length).toBe(17);
    expect(dec.palette![0]!.a).toBe(0);
    expect(dec.palette!.slice(1).every((e) => e.a === 255)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(h.root, "assets/coin.json"), "utf8"));
    expect(meta).toMatchObject({
      version: 1,
      image: "coin.png",
      size: { w: 8, h: 8 },
      pixelsPerUnit: 16,
      frames: [{ name: "coin_0", rect: { x: 0, y: 0, w: 8, h: 8 }, uv: { offsetX: 0, offsetY: 0, repeatX: 1, repeatY: 1 }, pivotPx: { x: 4, y: 4 }, center: { x: 0.5, y: 0.5 } }],
    });
    const manifest = fs.readFileSync(path.join(h.root, "assets/assets.generated.ts"), "utf8");
    expect(manifest).toContain('"coin": {');
    expect(manifest).toContain('"url": "assets/coin.png"');
    expect(manifest).toContain("export type AssetName = keyof typeof assets;");
    await h.ok("export_png", { docId: "doc_1" });
    expect(fs.readFileSync(pngPath).equals(png)).toBe(true);
  });

  it("embeds metadata in a tEXt chunk when configured", async () => {
    await h.ok("configure_project", { metadataMode: "embedded" });
    await h.ok("create_document", { name: "gem", kind: "sprite", width: 8, height: 8 });
    const out = await h.ok("export_png", { docId: "doc_1", name: "items/gem" });
    expect(out.data.files).toEqual(["assets/items/gem.png"]);
    const dec = decodePng(fs.readFileSync(path.join(h.root, "assets/items/gem.png")));
    const meta = JSON.parse(dec.texts.find((t) => t.keyword === "pixelmcp")!.text);
    expect(meta.image).toBe("gem.png");
    const manifest = fs.readFileSync(path.join(h.root, "assets/assets.generated.ts"), "utf8");
    expect(manifest).toContain('"items/gem"');
  });

  it("blocks export on validation errors", async () => {
    await h.ok("create_document", { name: "bad", kind: "sprite", width: 8, height: 8 });
    await h.ok("set_pixels", { docId: "doc_1", pixels: [{ x: 0, y: 0, c: 16 }] });
    await h.ok("load_palette", { name: "pico8", source: ["#000000", "#ffffff"] });
    const v = await h.ok("validate_document", { docId: "doc_1" });
    expect(v.data.ok).toBe(false);
    expect(v.data.errors[0].check).toBe("palette-range");
    const out = await h.call("export_png", { docId: "doc_1" });
    expect(out.isError).toBe(true);
    expect(out.data.error).toMatch(/validation/);
  });

  it("saves and loads the project", async () => {
    await h.ok("create_document", { name: "keep", kind: "sprite", width: 8, height: 8 });
    await h.ok("set_pixels", { docId: "doc_1", pixels: [{ x: 1, y: 1, c: 8 }] });
    await h.ok("save_project");
    await h.ok("delete_document", { docId: "doc_1" });
    expect((await h.ok("list_documents")).data.documents).toEqual([]);
    const loaded = await h.ok("load_project");
    expect(loaded.data.documents).toEqual([{ id: "doc_1", name: "keep", kind: "sprite" }]);
    const rows = (await h.ok("read_grid", { docId: "doc_1", w: 2, h: 2 })).data.rows;
    expect(rows).toEqual(["__", "_8"]);
  });
});
