import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCel } from "../src/document.js";
import { parseAseprite } from "../src/import/aseprite.js";
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

async function buildDoc(): Promise<string> {
  const { data } = await h.ok("create_document", { name: "blob", kind: "sprite", width: 8, height: 8 });
  const docId = data.docId as string;
  const glow = await h.ok("add_layer", { docId, name: "glow", blend: "additive" });
  const guide = await h.ok("add_layer", { docId, name: "guide" });
  await h.ok("add_frame", { docId, durationMs: 150 });
  await h.ok("set_pixels", { docId, layerId: "layer_1", frame: 0, pixels: [{ x: 2, y: 3, c: 8 }, { x: 5, y: 6, c: 12 }] });
  await h.ok("set_pixels", { docId, layerId: "layer_1", frame: 1, pixels: [{ x: 0, y: 0, c: 7 }] });
  await h.ok("set_pixels", { docId, layerId: glow.data.layerId, frame: 1, pixels: [{ x: 7, y: 7, c: 10 }] });
  await h.ok("set_pixels", { docId, layerId: guide.data.layerId, frame: 0, pixels: [{ x: 4, y: 4, c: 1 }] });
  await h.ok("set_layer_properties", { docId, layerId: guide.data.layerId, guide: true, locked: true });
  await h.ok("tag_frames", { docId, tag: "pulse", from: 0, to: 1, direction: "pingpong" });
  await h.ok("set_pivot", { docId, x: 4, y: 7 });
  return docId;
}

describe("export_aseprite", () => {
  it("writes a file the independent ase-parser reads", async () => {
    const docId = await buildDoc();
    const r = await h.ok("export_aseprite", { docId });
    expect(r.data.file).toBe("assets/blob.aseprite");
    const buf = fs.readFileSync(path.join(h.root, r.data.file));

    const ref = new AseParser(buf, "blob.aseprite");
    ref.parse();
    expect([ref.width, ref.height, ref.colorDepth, ref.numFrames]).toEqual([8, 8, 8, 2]);
    expect(ref.layers.map((l: { name: string }) => l.name)).toEqual(["Layer 1", "glow", "guide"]);
    expect(ref.frames.map((f: { frameDuration: number }) => f.frameDuration)).toEqual([100, 150]);
    expect(ref.tags[0]).toMatchObject({ name: "pulse", from: 0, to: 1, animDirection: "Ping-pong" });
    expect(ref.palette.colors[9]).toMatchObject({ red: 0xff, green: 0x00, blue: 0x4d, alpha: 255 });

    const mine = parseAseprite(buf);
    expect(mine.palette[0]!.a).toBe(0);
    expect(mine.layers.map((l) => [l.blendMode, l.visible, l.reference])).toEqual([[0, true, false], [16, true, false], [0, true, true]]);
    expect(mine.layers[2]!.flags & 2).toBe(0); // locked → not editable
    expect(mine.frames[0]!.cels[0]).toMatchObject({ layerIndex: 0, x: 2, y: 3, w: 4, h: 4 });
    expect(mine.slices[0]!.keys[0]!.pivot).toEqual({ x: 4, y: 7 });
  });

  it("round-trips through import_aseprite", async () => {
    const docId = await buildDoc();
    await h.ok("export_aseprite", { docId, name: "out/blob" });
    const r = await h.ok("import_aseprite", { path: "assets/out/blob.aseprite" });
    const a = h.project.getDoc(docId);
    const b = h.project.getDoc(r.data.docId);
    expect(b.layers.map((l) => [l.name, l.blend])).toEqual([["Layer 1", "normal"], ["glow", "additive"]]); // guide (reference) layer is skipped
    expect(b.frames.map((f) => [f.durationMs, f.tag, f.pivot])).toEqual(a.frames.map((f) => [f.durationMs, f.tag, { x: 4, y: 7 }]));
    expect(b.tagDirections).toEqual({ pulse: "pingpong" });
    expect(h.project.paletteFor(b).colors.slice(1, PICO8.length + 1)).toEqual(PICO8);
    for (let f = 0; f < 2; f++) {
      for (const [i, id] of ["Layer 1", "glow"].entries()) {
        const src = getCel(a, a.layers[i]!.id, f) ?? new Uint8Array(64);
        const dst = getCel(b, b.layers.find((l) => l.name === id)!.id, f) ?? new Uint8Array(64);
        expect(Array.from(dst)).toEqual(Array.from(src));
      }
    }
  });
});
