/**
 * Spec §15 acceptance scenario, driven only through MCP tools, run twice in
 * separate projects to prove byte-identical output.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodePng } from "../src/png.js";
import { buildCharacter, cornerTile } from "./fixtures.js";
import { startHarness } from "./helpers.js";
import type { Harness } from "./helpers.js";

async function scenario(h: Harness): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  // 16-color palette with ramps
  await h.ok("load_palette", { name: "pico8", source: "builtin:pico8" });
  for (const [name, indices] of Object.entries({ fire: [3, 9, 10, 11], grass: [4, 12], skin: [5, 16], ice: [2, 13, 8] })) {
    await h.ok("define_ramp", { paletteId: "pico8", name, indices });
  }
  await h.ok("render_palette", { id: "pico8" });

  // 5-frame fireball spritesheet with an additive glow layer
  const fb = (await h.ok("create_document", { name: "fireball", kind: "effect", width: 32, height: 32 })).data.docId;
  await h.ok("add_layer", { docId: fb, name: "glow", blend: "additive" });
  for (let f = 0; f < 5; f++) {
    if (f > 0) await h.ok("add_frame", { docId: fb, durationMs: 80 });
    const r = 5 + f * 2;
    await h.ok("draw_ellipse", { docId: fb, layerId: "layer_1", frame: f, cx: 15.5, cy: 15.5, rx: r, ry: r - (f % 2), c: 9, filled: true });
    await h.ok("radial_gradient", { docId: fb, layerId: "layer_1", frame: f, cx: 15.5, cy: 15.5, radius: r + 1, rampName: "fire", dither: "bayer4", onlyOpaque: true });
    await h.ok("draw_ellipse", { docId: fb, layerId: "glow", frame: f, cx: 15.5, cy: 15.5, rx: 2, ry: 2, c: 2, filled: true });
  }
  await h.ok("set_frame_duration", { docId: fb, frame: 0, ms: 80 });
  await h.ok("tag_frames", { docId: fb, tag: "loop", from: 0, to: 4 });
  await h.ok("render_frames", { docId: fb });
  await h.ok("render_onion", { docId: fb, frame: 2 });
  results.fireball = (await h.ok("export_spritesheet", { docId: fb, layout: "row" })).data;
  await h.ok("export_gif", { docId: fb });

  // 32x32 character, 6 parts, 4 directions, idle and walk poses
  const hero = await buildCharacter(h);
  await h.ok("render_assembled", { docId: hero });
  await h.ok("render_assembled", { docId: hero, pose: "walk_*", direction: "right" });
  results.hero = (await h.ok("export_character", { docId: hero })).data;
  results.heroValidation = (await h.ok("validate_document", { docId: hero })).data;

  // 16x16 grass-over-dirt corner15 transition set, overlay mode
  const set = (await h.ok("create_transition_set", { name: "grass_dirt", tileSize: 16, terrains: { lower: "dirt", upper: "grass" }, overlay: true })).data.docId;
  for (const m of [15, 3, 1, 7]) await h.ok("draw_grid", { docId: set, layerId: "tiles", frame: m, x: 0, y: 0, legend: { g: 12, o: 4, l: 11 }, rows: cornerTile(m, 16) });
  await h.ok("generate_autotile", { docId: set, sources: [15, 3, 1, 7] });
  results.transitionCheck = (await h.ok("check_transition_set", { docId: set })).data;
  results.terrain = (await h.ok("render_terrain_preview", { docId: set })).data;
  results.seams15 = (await h.ok("check_seams", { docId: set, frame: 15 })).data;
  results.tileset = (await h.ok("export_tileset", { docId: set })).data;

  // 8 matching 16x16 icons
  const names = ["sword", "shield", "potion", "key", "coin", "gem", "bow", "scroll"];
  const icons = (await h.ok("create_icon_set", { name: "items", size: 16, count: 8, names })).data.docId;
  for (let f = 0; f < 8; f++) {
    await h.ok("draw_ellipse", { docId: icons, frame: f, cx: 7, cy: 7, rx: 2 + (f % 3), ry: 3 + (f % 2), c: 9 + f, filled: true });
    await h.ok("shade_with_ramp", { docId: icons, frame: f, rampName: f % 2 ? "fire" : "ice" });
  }
  await h.ok("apply_icon_style", { docId: icons, outline: 1, shadow: { color: 2, dx: 1, dy: 1 } });
  await h.ok("render_in_context", { docIds: [fb, hero, set, icons] });
  results.icons = (await h.ok("export_icon_atlas", { docId: icons })).data;
  results.iconValidation = (await h.ok("validate_document", { docId: icons })).data;
  return results;
}

function listFiles(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p)];
  }).sort();
}

describe("acceptance scenario (spec §15)", () => {
  it("produces every asset, valid and byte-identical across runs", async () => {
    const a = await startHarness();
    const b = await startHarness();
    try {
      const ra = await scenario(a);
      await scenario(b);

      expect((ra.transitionCheck as { ok: boolean }).ok).toBe(true);
      expect((ra.transitionCheck as { seamWarnings: unknown[] }).seamWarnings).toEqual([]);
      expect((ra.terrain as { usedMasks: number[] }).usedMasks).toEqual([...Array(16).keys()]);
      expect((ra.terrain as { missingTiles: number[] }).missingTiles).toEqual([]);
      expect((ra.seams15 as { verdict: string }).verdict).toBe("seamless");
      expect((ra.hero as { parts: number }).parts).toBe(24);
      expect((ra.heroValidation as { errors: unknown[] }).errors).toEqual([]);
      expect((ra.iconValidation as { warnings: Array<{ check: string }> }).warnings.filter((w) => w.check === "icon-safe-area")).toEqual([]);

      const outA = path.join(a.root, "assets");
      const outB = path.join(b.root, "assets");
      const files = listFiles(outA);
      expect(files).toEqual(listFiles(outB));
      expect(files).toEqual(expect.arrayContaining([
        "fireball.png", "fireball_glow.png", "fireball.json", "hero.png", "hero.json", "grass_dirt.png", "grass_dirt.json",
        "items.png", "items.json", ".pixelmcp/previews/fireball.gif",
      ]));
      expect(files.every((f) => /\.(png|json|gif)$/.test(f))).toBe(true);
      for (const f of files) expect(fs.readFileSync(path.join(outA, f)).equals(fs.readFileSync(path.join(outB, f))), `${f} differs between runs`).toBe(true);

      for (const f of files.filter((p) => p.endsWith(".png"))) {
        const png = decodePng(fs.readFileSync(path.join(outA, f)));
        expect(png.colorType, f).toBe(3);
        expect(png.palette![0]!.a, f).toBe(0);
        expect(png.palette!.slice(1).every((e) => e.a === 255), `${f} has partial alpha`).toBe(true);
        expect(png.chunkTypes.filter((c) => c === "tRNS").length).toBe(1);
      }

      for (const f of files.filter((p) => p.endsWith(".json"))) {
        const meta = JSON.parse(fs.readFileSync(path.join(outA, f), "utf8"));
        const png = decodePng(fs.readFileSync(path.join(outA, meta.image)));
        const W = meta.size.w;
        const H = meta.size.h;
        expect([png.width, png.height]).toEqual([W, H]);
        for (const fr of meta.frames) {
          // Frame rects lie inside the image.
          expect(fr.rect.x >= 0 && fr.rect.y >= 0 && fr.rect.x + fr.rect.w <= W && fr.rect.y + fr.rect.h <= H).toBe(true);
          // 1px extrusion ring duplicates the frame's edge pixels into the padding.
          if (meta.layout.extrude >= 1) {
            const at = (x: number, y: number) => png.indices![y * W + x];
            const { x, y, w, h } = fr.rect;
            for (let i = -1; i <= w; i++) {
              const sx = Math.min(w - 1, Math.max(0, i));
              expect(at(x + i, y - 1)).toBe(at(x + sx, y));
              expect(at(x + i, y + h)).toBe(at(x + sx, y + h - 1));
            }
            for (let j = 0; j < h; j++) {
              expect(at(x - 1, y + j)).toBe(at(x, y + j));
              expect(at(x + w, y + j)).toBe(at(x + w - 1, y + j));
            }
          }
        }
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
});
