import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAsepriteJson } from "../src/import/slicing.js";
import { parseAseprite } from "../src/import/aseprite.js";
import { compositeIndexed } from "../src/document.js";
import { decodePng, encodeIndexedPng } from "../src/png.js";
import { writeAseprite } from "./ase-writer.js";
import type { WFile } from "./ase-writer.js";
import { buildCharacter, cornerTile } from "./fixtures.js";
import { PICO8, startHarness } from "./helpers.js";
import type { Harness } from "./helpers.js";

const require = createRequire(import.meta.url);
const AseParser = require("ase-parser");

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
  await h.ok("load_palette", { name: "pico8", source: "builtin:pico8" });
});
afterEach(async () => {
  await h.close();
});

const read = (rel: string) => fs.readFileSync(path.join(h.root, rel));
const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Writes an RGBA PNG with pngjs (an independent encoder) from a pixel function. */
function writeRgbaPng(rel: string, w: number, hgt: number, pixel: (x: number, y: number) => [number, number, number, number]): void {
  const png = new PNG({ width: w, height: hgt });
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) png.data.set(pixel(x, y), (y * w + x) * 4);
  fs.mkdirSync(path.dirname(path.join(h.root, rel)), { recursive: true });
  fs.writeFileSync(path.join(h.root, rel), PNG.sync.write(png));
}

/** Snapshot of files, re-run of an action, and byte comparison. */
async function expectRoundTrip(files: string[], reExport: () => Promise<unknown>): Promise<void> {
  const before = files.map((f) => read(f));
  await reExport();
  files.forEach((f, i) => expect(read(f).equals(before[i]!), `${f} changed after round trip`).toBe(true));
}

describe("lossless round trips (export → import metadata → export)", () => {
  it("single PNG and spritesheets (row, grid, packed, tag, glow)", async () => {
    const doc = await h.ok("create_document", { name: "orb", kind: "effect", width: 12, height: 10 });
    const id = doc.data.docId;
    for (let f = 0; f < 4; f++) {
      if (f) await h.ok("add_frame", { docId: id, durationMs: 60 + f * 10 });
      await h.ok("draw_ellipse", { docId: id, frame: f, cx: 5 + f % 2, cy: 5, rx: 2 + f, ry: 2, c: 9 + f, filled: true });
    }
    await h.ok("set_pivot", { docId: id, x: 6, y: 9 });
    await h.ok("tag_frames", { docId: id, tag: "spin", from: 1, to: 3, direction: "pingpong" });
    await h.ok("add_layer", { docId: id, name: "glow", blend: "additive" });
    await h.ok("set_pixels", { docId: id, layerId: "glow", frame: 2, pixels: [{ x: 0, y: 0, c: 2 }, { x: 11, y: 9, c: 3 }] });

    await h.ok("export_png", { docId: id, frame: 1, name: "orb_single" });
    const single = await h.ok("import_png", { path: "assets/orb_single.png" });
    expect(single.data.slicing).toEqual({ mode: "metadata", layout: "png" });
    await expectRoundTrip(["assets/orb_single.png", "assets/orb_single.json"], () => h.ok("export_png", { docId: single.data.docId }));

    for (const [layout, name, extra] of [
      ["row", "orb_row", {}],
      ["grid", "orb_grid", { columns: 3, padding: 4, extrude: 2 }],
      ["packed", "orb_packed", {}],
      ["row", "orb_spin", { tag: "spin" }],
    ] as const) {
      await h.ok("export_spritesheet", { docId: id, layout, name, ...extra });
      const files = [`assets/${name}.png`, `assets/${name}.json`, `assets/${name}_glow.png`];
      const imported = await h.ok("import_png", { path: `assets/${name}.png` });
      expect(imported.data.layers).toEqual(["layer_1", "glow"]);
      await expectRoundTrip(files, () => h.ok("export_spritesheet", { docId: imported.data.docId }));
      await expectRoundTrip(files, () => h.ok("export_to_source", { docId: imported.data.docId }));
    }
    const spin = await h.ok("import_png", { path: "assets/orb_spin.png" });
    const info = await h.ok("get_document_info", { docId: spin.data.docId });
    expect(info.data.tags).toEqual([{ name: "spin", from: 0, to: 2, direction: "pingpong" }]);
    expect(info.data.frames.map((f: { durationMs: number }) => f.durationMs)).toEqual([70, 80, 90]);
  });

  it("embedded metadata, tilesets, icons and characters", async () => {
    await h.ok("configure_project", { metadataMode: "both" });
    const set = await h.ok("create_transition_set", { name: "grass", tileSize: 8, terrains: { lower: "dirt", upper: "grass" } });
    for (const m of [15, 3, 1, 7]) await h.ok("draw_grid", { docId: set.data.docId, layerId: "tiles", frame: m, x: 0, y: 0, legend: { g: 12, o: 4, l: 11 }, rows: cornerTile(m, 8) });
    await h.ok("generate_autotile", { docId: set.data.docId });
    await h.ok("export_tileset", { docId: set.data.docId });
    const tiles = await h.ok("import_png", { path: "assets/grass.png" });
    const tinfo = await h.ok("get_document_info", { docId: tiles.data.docId });
    expect(tinfo.data.tileset).toMatchObject({ template: "corner15", overlay: true, tileSize: 8 });
    expect(tinfo.data.layers.map((l: { id: string }) => l.id)).toEqual(["tiles", "guide"]);
    expect((await h.ok("check_transition_set", { docId: tiles.data.docId })).data.ok).toBe(true);
    await expectRoundTrip(["assets/grass.png", "assets/grass.json"], () => h.ok("export_tileset", { docId: tiles.data.docId }));

    const icons = await h.ok("create_icon_set", { name: "icons", size: 8, count: 3, names: ["a", "b", "c"] });
    for (let f = 0; f < 3; f++) await h.ok("draw_rect", { docId: icons.data.docId, frame: f, x: 2, y: 2, w: 3, h: 3 + (f % 2), c: 8 + f, filled: true });
    await h.ok("apply_icon_style", { docId: icons.data.docId, outline: 1 });
    await h.ok("export_icon_atlas", { docId: icons.data.docId });
    const icons2 = await h.ok("import_png", { path: "assets/icons.png" });
    await expectRoundTrip(["assets/icons.png", "assets/icons.json"], () => h.ok("export_icon_atlas", { docId: icons2.data.docId }));

    const hero = await buildCharacter(h);
    await h.ok("export_character", { docId: hero });
    const hero2 = await h.ok("import_png", { path: "assets/hero.png" });
    const hinfo = await h.ok("get_document_info", { docId: hero2.data.docId });
    expect(hinfo.data.rig.directions).toEqual(["down", "up", "left", "right"]);
    expect(hinfo.data.rig.poses.length).toBe(6);
    expect(hinfo.data.layers.map((l: { id: string }) => l.id)).toEqual(["foot_l", "foot_r", "body", "hand_l", "hand_r", "head"]);
    await expectRoundTrip(["assets/hero.png", "assets/hero.json"], () => h.ok("export_character", { docId: hero2.data.docId }));
    // Embedded metadata alone is enough to re-import.
    fs.unlinkSync(path.join(h.root, "assets/hero.json"));
    const embedded = await h.ok("import_png", { path: "assets/hero.png" });
    expect(embedded.data.metadata).toBe("embedded");
  });
});

describe("PNG import", () => {
  it("fails in exact mode with every off-palette color listed and imports nothing", async () => {
    writeRgbaPng("art/truecolor.png", 4, 2, (x, y) => (x === 0 ? [255, 0, 77, 255] : y === 0 ? [10, 20, 30, 255] : x === 3 ? [200, 200, 1, 255] : [0, 0, 0, 0]));
    const docsBefore = (await h.ok("list_documents")).data.documents.length;
    const r = await h.call("import_png", { path: "art/truecolor.png" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/2 color\(s\) are not in palette "pico8"/);
    const off = r.data.details.colorMapping.offPalette;
    expect(off).toEqual([
      { color: "#0a141e", count: 3, samples: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }] },
      { color: "#c8c801", count: 1, samples: [{ x: 3, y: 1 }] },
    ]);
    expect((await h.ok("list_documents")).data.documents.length).toBe(docsBefore);

    const near = await h.ok("import_png", { path: "art/truecolor.png", colorMode: "nearest" });
    expect(near.data.colorMapping.substitutions.map((s: { from: string }) => s.from)).toEqual(["#0a141e", "#c8c801"]);
    const extract = await h.ok("import_png", { path: "art/truecolor.png", colorMode: "extract", name: "tc" });
    expect(extract.data.paletteCreated).toEqual({ id: "tc", colors: 3 });
  });

  it("thresholds partial alpha and detects integer upscaling", async () => {
    // 4x upscaled 3x2 image with a half-transparent pixel
    const base = [[[255, 0, 77, 255], [0, 0, 0, 0], [41, 173, 255, 200]], [[41, 173, 255, 255], [255, 0, 77, 100], [0, 0, 0, 0]]];
    writeRgbaPng("art/up4.png", 12, 8, (x, y) => base[Math.floor(y / 4)]![Math.floor(x / 4)] as [number, number, number, number]);
    const r = await h.ok("import_png", { path: "art/up4.png" });
    expect(r.data.detectedScale).toBe(4);
    expect(r.data.size).toEqual({ w: 3, h: 2 });
    expect(r.data.alphaThresholded).toBe(32); // two partial pixels × 16
    const rows = (await h.ok("read_grid", { docId: r.data.docId })).data.rows;
    expect(rows).toEqual(["9_d", "d__"]);
    const forced = await h.ok("import_png", { path: "art/up4.png", scale: 1 });
    expect(forced.data.size).toEqual({ w: 12, h: 8 });
    // export_to_source writes the 4x image back.
    await h.ok("draw_line", { docId: r.data.docId, x0: 1, y0: 0, x1: 1, y1: 0, c: 12 });
    await h.ok("export_to_source", { docId: r.data.docId });
    const back = decodePng(read("art/up4.png"));
    expect([back.width, back.height]).toEqual([12, 8]);
    expect(back.palette![back.indices![0 * 12 + 5]!]).toMatchObject({ r: 0, g: 228, b: 54 }); // doc pixel (1,0) → 4x block at x 4..7, y 0..3
  });

  it("slices grids, auto-detected grids and Aseprite JSON sheets", async () => {
    const pal = PICO8.map(rgb);
    // 3 frames of 6x5 with margin 1 and spacing 2: x = 1, 9, 17; plus an empty 4th cell (x = 25)
    writeRgbaPng("art/sheet.png", 32, 7, (x, y) => {
      const inCell = (x - 1) % 8 < 6 && x >= 1 && y >= 1 && y < 6;
      const cell = Math.floor((x - 1) / 8);
      return inCell && cell < 3 ? ([...pal[8 + cell]!, 255] as [number, number, number, number]) : [0, 0, 0, 0];
    });
    const grid = await h.ok("import_png", { path: "art/sheet.png", slicing: { frameWidth: 6, frameHeight: 5, margin: 1, spacing: 2 }, scale: 1 });
    expect(grid.data.frames).toBe(3);
    expect(grid.data.warnings.join()).toMatch(/Dropped 1 trailing empty cell/);
    const auto = await h.ok("import_png", { path: "art/sheet.png", slicing: "auto", scale: 1 });
    expect(auto.data.slicing).toMatchObject({ mode: "auto", confident: true, proposal: { frameWidth: 6, frameHeight: 5, margin: 1, spacing: 2 } });
    expect(auto.data.frames).toBe(3);
    // Ambiguous: 8x8 blocks centered in 16x16 cells fit "8x8 frames, margin 4, spacing 8" and "16x16 frames" equally well.
    writeRgbaPng("art/ambiguous.png", 32, 16, (x, y) => (x % 16 >= 4 && x % 16 < 12 && y >= 4 && y < 12 ? [255, 0, 77, 255] : [0, 0, 0, 0]));
    const amb = await h.call("import_png", { path: "art/ambiguous.png", slicing: "auto", scale: 1 });
    expect(amb.isError).toBe(true);
    expect(amb.data.details.slicing.confident).toBe(false);
    expect([amb.data.details.slicing.proposal, ...amb.data.details.slicing.alternatives]).toEqual([
      { frameWidth: 8, frameHeight: 8, margin: 4, spacing: 8 },
      { frameWidth: 16, frameHeight: 16 },
    ]);
    // Centered content with unequal margins has one consistent reading: 16x8 cells.
    writeRgbaPng("art/cells.png", 32, 8, (x, y) => (x % 16 >= 4 && x % 16 < 12 && y >= 2 && y < 6 ? [255, 0, 77, 255] : [0, 0, 0, 0]));
    const cells = await h.ok("import_png", { path: "art/cells.png", slicing: "auto", scale: 1 });
    expect(cells.data.slicing.proposal).toEqual({ frameWidth: 16, frameHeight: 8 });
    expect(cells.data.frames).toBe(2);

    // Aseprite JSON (hash format, trimmed frames)
    const sheet = encodeIndexedPng({ width: 8, height: 4, indices: Uint8Array.from({ length: 32 }, (_, i) => ((i % 8) < 3 ? 9 : (i % 8) >= 4 && (i % 8) < 6 ? 12 : 0)), palette: pal.map(([r, g, b]) => ({ r: r!, g: g!, b: b! })) });
    fs.writeFileSync(path.join(h.root, "art/ase_sheet.png"), sheet);
    fs.writeFileSync(
      path.join(h.root, "art/ase_sheet.json"),
      JSON.stringify({
        frames: {
          "walk 0.aseprite": { frame: { x: 0, y: 0, w: 3, h: 4 }, rotated: false, trimmed: true, spriteSourceSize: { x: 1, y: 0, w: 3, h: 4 }, sourceSize: { w: 6, h: 4 }, duration: 120 },
          "walk 1.aseprite": { frame: { x: 4, y: 0, w: 2, h: 4 }, rotated: false, trimmed: true, spriteSourceSize: { x: 3, y: 0, w: 2, h: 4 }, sourceSize: { w: 6, h: 4 }, duration: 90 },
        },
        meta: { frameTags: [{ name: "walk", from: 0, to: 1, direction: "pingpong" }], image: "ase_sheet.png" },
      }),
    );
    expect(parseAsepriteJson(fs.readFileSync(path.join(h.root, "art/ase_sheet.json"), "utf8")).frames.length).toBe(2);
    const aj = await h.ok("import_png", { path: "art/ase_sheet.png", slicing: { asepriteJson: "art/ase_sheet.json" } });
    expect(aj.data).toMatchObject({ size: { w: 6, h: 4 }, frames: 2, tags: ["walk"] });
    const f1 = (await h.ok("read_grid", { docId: aj.data.docId, frame: 1, h: 1 })).data.rows[0];
    expect(f1).toBe("___dd_"); // PNG index 12 (#29adff) is index 13 in the project palette
    // export_to_source puts frames back into their original rects.
    const before = read("art/ase_sheet.png");
    await h.ok("export_to_source", { docId: aj.data.docId });
    const opaqueRgba = (b: Buffer) => [...decodePng(b).rgba].map((v, i, a) => (a[i - (i % 4) + 3] === 0 ? 0 : v));
    expect(opaqueRgba(read("art/ase_sheet.png"))).toEqual(opaqueRgba(before)); // same colors, re-encoded with the project palette
  });

  it("export_to_source refuses when the source changed, unless forced", async () => {
    await h.ok("create_document", { name: "coin", kind: "sprite", width: 8, height: 8 });
    await h.ok("draw_rect", { docId: "doc_1", x: 2, y: 2, w: 4, h: 4, c: 10, filled: true });
    await h.ok("export_png", { docId: "doc_1" });
    const imp = await h.ok("import_png", { path: "assets/coin.png" });
    await h.ok("draw_line", { docId: imp.data.docId, x0: 2, y0: 2, x1: 5, y1: 2, c: 8 });
    const written = await h.ok("export_to_source", { docId: imp.data.docId });
    expect(written.data.files).toEqual(["assets/coin.png", "assets/coin.json"]);
    expect(decodePng(read("assets/coin.png")).indices![2 * 8 + 3]).toBe(8);
    await h.ok("export_to_source", { docId: imp.data.docId }); // hash updated after our own write
    fs.appendFileSync(path.join(h.root, "assets/coin.png"), Buffer.from([0]));
    const refused = await h.call("export_to_source", { docId: imp.data.docId });
    expect(refused.isError).toBe(true);
    expect(refused.data.error).toMatch(/changed since it was imported/);
    await h.ok("export_to_source", { docId: imp.data.docId, force: true });
  });

  it("inspects files", async () => {
    await h.ok("create_document", { name: "coin", kind: "sprite", width: 8, height: 8 });
    await h.ok("draw_rect", { docId: "doc_1", x: 2, y: 2, w: 4, h: 4, c: 10, filled: true });
    await h.ok("export_png", { docId: "doc_1" });
    const info = await h.ok("inspect_file", { path: "assets/coin.png" });
    expect(info.data).toMatchObject({ format: "png", width: 8, height: 8, colorMode: "indexed", opaqueColors: 1, mcpMetadata: { where: "sidecar", kind: "sprite", frames: 1 } });
    expect(info.data.againstPalette).toEqual({ paletteId: "pico8", offPaletteColors: 0 });
  });
});

// ---------------------------------------------------------------------------
// Aseprite

const PAL17: WFile["palette"] = [[0, 0, 0, 255], ...PICO8.map((c) => rgb(c) as [number, number, number])];

/** Indexed fixture with groups, hidden layer, linked cel, tags, varying durations and a pivot slice (normal blend, full opacity). */
function goblinFixture(): WFile {
  const px = (w: number, hgt: number, fn: (x: number, y: number) => number) => Array.from({ length: w * hgt }, (_, i) => fn(i % w, Math.floor(i / w)));
  return {
    width: 12,
    height: 10,
    depth: 8,
    transparentIndex: 0,
    palette: PAL17,
    layers: [
      { name: "body" },
      { name: "arm", type: 1 },
      { name: "upper", childLevel: 1 },
      { name: "lower", childLevel: 1 },
      { name: "ghost", visible: false },
    ],
    frames: [
      { duration: 100, cels: [
        { layer: 0, x: 2, y: 2, w: 4, h: 5, pixels: px(4, 5, (x, y) => (x + y) % 3 === 0 ? 0 : 13) },
        { layer: 2, x: 6, y: 3, w: 2, h: 2, pixels: px(2, 2, () => 16) },
        { layer: 3, x: 7, y: 5, w: 3, h: 1, pixels: [16, 0, 9] },
        { layer: 4, x: 0, y: 0, w: 2, h: 2, pixels: [8, 8, 8, 8] },
      ] },
      { duration: 150, cels: [
        { layer: 0, link: 0 },
        { layer: 2, x: 6, y: 2, w: 2, h: 2, pixels: px(2, 2, () => 16), raw: true },
      ] },
      { duration: 80, cels: [
        { layer: 0, x: 3, y: 2, w: 4, h: 5, pixels: px(4, 5, () => 12) },
        { layer: 3, x: -1, y: 8, w: 3, h: 3, pixels: px(3, 3, () => 11) },
      ] },
    ],
    tags: [
      { from: 0, to: 1, dir: 0, name: "idle" },
      { from: 2, to: 2, dir: 2, name: "attack" },
    ],
    slices: [{ name: "pivot", keys: [{ frame: 0, x: 2, y: 2, w: 8, h: 8, pivot: { x: 4, y: 7 } }] }],
  };
}

/** How Aseprite composites visible normal layers at full opacity (reference for the import). */
function referenceComposite(f: WFile, frame: number): Array<number[] | null> {
  const out: Array<number[] | null> = new Array(f.width * f.height).fill(null);
  const visible = (i: number): boolean => {
    const l = f.layers[i]!;
    if (l.visible === false) return false;
    const level = l.childLevel ?? 0;
    for (let j = i - 1; j >= 0; j--) if ((f.layers[j]!.childLevel ?? 0) === level - 1) return visible(j);
    return true;
  };
  f.layers.forEach((l, li) => {
    if ((l.type ?? 0) !== 0 || !visible(li)) return;
    let cel = f.frames[frame]!.cels.find((c) => c.layer === li);
    if (cel?.link !== undefined) cel = f.frames[cel.link]!.cels.find((c) => c.layer === li);
    if (!cel?.pixels) return;
    for (let y = 0; y < cel.h!; y++) for (let x = 0; x < cel.w!; x++) {
      const tx = (cel.x ?? 0) + x;
      const ty = (cel.y ?? 0) + y;
      const v = cel.pixels[y * cel.w! + x]!;
      if (tx < 0 || ty < 0 || tx >= f.width || ty >= f.height || v === (f.transparentIndex ?? 0)) continue;
      out[ty * f.width + tx] = f.palette[v]!.slice(0, 3) as number[];
    }
  });
  return out;
}

function ourComposite(h: Harness, docId: string, frame: number): Array<number[] | null> {
  const doc = h.project.getDoc(docId);
  const pal = h.project.paletteFor(doc).colors;
  return [...compositeIndexed(doc, frame, (l) => l.visible && !l.guide)].map((v) => (v === 0 ? null : rgb(pal[v]!)));
}

describe("Aseprite import", () => {
  it("writes fixtures that the independent ase-parser reads identically", () => {
    const fixture = goblinFixture();
    const buf = writeAseprite(fixture);
    const ref = new AseParser(buf, "goblin.aseprite");
    ref.parse();
    const mine = parseAseprite(buf);
    expect(ref.layers.map((l: { name: string }) => l.name)).toEqual(mine.layers.map((l) => l.name));
    expect(ref.layers.map((l: { layerChildLevel: number }) => l.layerChildLevel)).toEqual(mine.layers.map((l) => l.childLevel));
    expect(ref.frames.map((f: { frameDuration: number }) => f.frameDuration)).toEqual([100, 150, 80]);
    expect(ref.tags.map((t: { name: string; from: number; to: number }) => [t.name, t.from, t.to])).toEqual(mine.tags.map((t) => [t.name, t.from, t.to]));
    expect(ref.slices[0].keys[0].pivot).toEqual(mine.slices[0]!.keys[0]!.pivot);
    const refCel = ref.frames[2].cels.find((c: { layerIndex: number }) => c.layerIndex === 3);
    const myCel = mine.frames[2]!.cels.find((c) => c.layerIndex === 3)!;
    expect([refCel.xpos, refCel.ypos, refCel.w, refCel.h]).toEqual([myCel.x, myCel.y, myCel.w, myCel.h]);
    expect(Buffer.from(refCel.rawCelData).equals(Buffer.from(myCel.pixels!))).toBe(true);
    expect(mine.frames[1]!.cels.find((c) => c.layerIndex === 0)!.pixels).toEqual(mine.frames[0]!.cels.find((c) => c.layerIndex === 0)!.pixels);
    // Legacy chunk counts and old palette chunks parse the same.
    const legacy = parseAseprite(writeAseprite({ ...fixture, legacyChunkCount: true, oldPalette: true, layerUuids: true }));
    expect(legacy.layers.map((l) => l.name)).toEqual(mine.layers.map((l) => l.name));
    expect(legacy.palette).toEqual(mine.palette);
  });

  it("imports layers, frames, durations, tags and pivots pixel-identically to Aseprite's composite", async () => {
    const fixture = goblinFixture();
    fs.mkdirSync(path.join(h.root, "art"), { recursive: true });
    fs.writeFileSync(path.join(h.root, "art/goblin.aseprite"), writeAseprite(fixture));
    const r = await h.ok("import_aseprite", { path: "art/goblin.aseprite" });
    expect(r.data).toMatchObject({
      source: { path: "art/goblin.aseprite", format: "aseprite" },
      size: { w: 12, h: 10 },
      detectedScale: 1,
      frames: 3,
      layers: ["body", "arm_upper", "arm_lower", "ghost"],
      tags: ["idle", "attack"],
      colorMapping: { mode: "exact", offPalette: [], substitutions: [] },
      alphaThresholded: 0,
      hiddenLayers: ["ghost"],
      pivotFromSlice: "pivot",
    });
    const info = await h.ok("get_document_info", { docId: r.data.docId });
    expect(info.data.layers.map((l: { name: string }) => l.name)).toEqual(["body", "arm/upper", "arm/lower", "ghost"]);
    expect(info.data.frames.map((f: { durationMs: number }) => f.durationMs)).toEqual([100, 150, 80]);
    expect(info.data.tags).toEqual([
      { name: "idle", from: 0, to: 1, direction: "forward" },
      { name: "attack", from: 2, to: 2, direction: "pingpong" },
    ]);
    expect(info.data.frames[0].pivot).toEqual({ x: 6, y: 9 });
    for (let f = 0; f < 3; f++) expect(ourComposite(h, r.data.docId, f)).toEqual(referenceComposite(fixture, f));

    const merged = await h.ok("import_aseprite", { path: "art/goblin.aseprite", layerGroups: "merge", includeHidden: false });
    expect(merged.data.layers).toEqual(["body", "arm"]);
    for (let f = 0; f < 3; f++) expect(ourComposite(h, merged.data.docId, f)).toEqual(referenceComposite(fixture, f));
    // load_palette from an .aseprite file keeps indices
    const p = await h.ok("load_palette", { name: "from ase", source: "art/goblin.aseprite" });
    expect(p.data.colors).toBe(16);
    // export_to_source writes PNG + metadata next to the .aseprite file
    const out = await h.ok("export_to_source", { docId: r.data.docId });
    expect(out.data.files).toEqual(["art/goblin.png", "art/goblin.json"]);
    expect(out.data.wroteOverSource).toBe(false);
    const inspect = await h.ok("inspect_file", { path: "art/goblin.aseprite" });
    expect(inspect.data).toMatchObject({ format: "aseprite", colorMode: "indexed", frames: 3, durationsMs: [100, 150, 80] });
    expect(inspect.data.layers[2]).toEqual({ name: "arm/upper", type: "image", visible: true });
  });

  it("maps RGBA and grayscale files, thresholds alpha, warns about blend modes and opacity", async () => {
    const red = [255, 0, 77];
    const blue = [41, 173, 255];
    const fixture: WFile = {
      width: 4,
      height: 2,
      depth: 32,
      palette: PAL17,
      layers: [{ name: "base" }, { name: "glow", blend: 16 }, { name: "shade", blend: 1, opacity: 128 }, { name: "ref", reference: true }],
      frames: [
        { duration: 100, cels: [
          { layer: 0, x: 0, y: 0, w: 4, h: 1, pixels: [...red, 255, ...blue, 255, ...red, 100, ...blue, 20] },
          { layer: 1, x: 0, y: 1, w: 1, h: 1, pixels: [...blue, 255] },
          { layer: 2, x: 1, y: 1, w: 1, h: 1, pixels: [9, 9, 9, 255], opacity: 200 },
        ] },
      ],
    };
    fs.mkdirSync(path.join(h.root, "art"), { recursive: true });
    fs.writeFileSync(path.join(h.root, "art/rgba.aseprite"), writeAseprite(fixture));
    const bad = await h.call("import_aseprite", { path: "art/rgba.aseprite" });
    expect(bad.isError).toBe(true);
    expect(bad.data.details.colorMapping.offPalette).toEqual([{ color: "#090909", count: 1, samples: [{ x: 1, y: 1, frame: 0, layer: "shade" }] }]);
    const r = await h.ok("import_aseprite", { path: "art/rgba.aseprite", colorMode: "nearest" });
    expect(r.data.layers).toEqual(["base", "glow", "shade"]);
    expect(r.data.alphaThresholded).toBe(2);
    const warnings = r.data.warnings.join("\n");
    expect(warnings).toMatch(/Reference layer 'ref' was skipped/);
    expect(warnings).toMatch(/'shade' uses blend mode 'multiply'; flattened to normal/);
    expect(warnings).toMatch(/'shade' had 50% opacity; flattened to 100%/);
    expect(warnings).toMatch(/cels below 100% opacity/);
    const info = await h.ok("get_document_info", { docId: r.data.docId });
    expect(info.data.layers.find((l: { id: string }) => l.id === "glow").blend).toBe("additive");
    expect((await h.ok("read_grid", { docId: r.data.docId, layerId: "base" })).data.rows).toEqual(["9d__", "____"]); // alpha 100 and 20 < 128

    const gray: WFile = { width: 2, height: 1, depth: 16, palette: PAL17, layers: [{ name: "g" }], frames: [{ duration: 100, cels: [{ layer: 0, x: 0, y: 0, w: 2, h: 1, pixels: [194, 255, 0, 0] }] }] };
    fs.writeFileSync(path.join(h.root, "art/gray.aseprite"), writeAseprite(gray));
    const g = await h.ok("import_aseprite", { path: "art/gray.aseprite", colorMode: "nearest" });
    expect(g.data.colorDepth).toBe("grayscale");
    expect((await h.ok("read_grid", { docId: g.data.docId })).data.rows).toEqual(["7_"]);
  });

  it("remaps a non-zero transparent index, renders tilemaps and keeps opaque background pixels", async () => {
    const fixture: WFile = {
      width: 4,
      height: 2,
      depth: 8,
      transparentIndex: 2,
      palette: [[10, 10, 10, 255], [200, 0, 0, 255], [0, 0, 0, 255], [0, 200, 0, 255]],
      layers: [{ name: "bg", background: true }, { name: "tiles", type: 2, tilesetIndex: 0 }],
      tilesets: [{ id: 0, tileW: 1, tileH: 1, count: 3, pixels: [2, 3, 1] }],
      frames: [{ duration: 100, cels: [
        { layer: 0, x: 0, y: 0, w: 4, h: 2, pixels: [0, 1, 2, 3, 2, 2, 2, 2] },
        { layer: 1, x: 0, y: 1, tilemap: { w: 3, h: 1, tiles: [1, 0, 2 | 0x20000000] } },
      ] }],
    };
    fs.mkdirSync(path.join(h.root, "art"), { recursive: true });
    fs.writeFileSync(path.join(h.root, "art/remap.aseprite"), writeAseprite(fixture));
    const r = await h.ok("import_aseprite", { path: "art/remap.aseprite", colorMode: "extract" });
    expect(r.data.transparentIndexRemapped).toEqual({ from: 2, to: 0 });
    expect(r.data.paletteCreated).toEqual({ id: "remap", colors: 4 });
    const pal = (await h.ok("get_palette", { id: "remap" })).data.colors;
    // file index 0 ↔ 2 swapped; background pixels using the transparent index get a new opaque entry (4)
    expect([pal["1"], pal["2"], pal["3"], pal["4"]]).toEqual(["#c80000", "#0a0a0a", "#00c800", "#000000"]);
    expect((await h.ok("read_grid", { docId: r.data.docId, layerId: "bg" })).data.rows).toEqual(["2143", "4444"]);
    expect((await h.ok("read_grid", { docId: r.data.docId, layerId: "tiles" })).data.rows).toEqual(["____", "3_1_"]);
    expect(r.data.warnings.join()).toMatch(/Tilemap layer 'tiles' was imported as rendered pixels/);
  });

  it("imports the real indexed.aseprite sample identically to an independent composite", async () => {
    const src = path.join(path.dirname(require.resolve("ase-parser/package.json")), "indexed.aseprite");
    fs.mkdirSync(path.join(h.root, "art"), { recursive: true });
    fs.copyFileSync(src, path.join(h.root, "art/indexed.aseprite"));
    const r = await h.ok("import_aseprite", { path: "art/indexed.aseprite", colorMode: "extract" });
    expect(r.data.layers).toEqual(["background", "layer_1"]);
    const ref = new AseParser(fs.readFileSync(src), "indexed.aseprite");
    ref.parse();
    const expected: Array<number[] | null> = new Array(ref.width * ref.height).fill(null);
    ref.layers.forEach((layer: { flags: { visible: boolean; background: boolean } }, li: number) => {
      if (!layer.flags.visible) return;
      const cel = ref.frames[0].cels.find((c: { layerIndex: number }) => c.layerIndex === li);
      if (!cel) return;
      for (let y = 0; y < cel.h; y++) for (let x = 0; x < cel.w; x++) {
        const v = cel.rawCelData[y * cel.w + x];
        if (v === ref.paletteIndex && !layer.flags.background) continue;
        const c = ref.palette.colors[v];
        expected[(cel.ypos + y) * ref.width + cel.xpos + x] = [c.red, c.green, c.blue];
      }
    });
    expect(ourComposite(h, r.data.docId, 0)).toEqual(expected);
  });
});
