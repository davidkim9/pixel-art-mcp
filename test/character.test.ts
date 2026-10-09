import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { swapLeftRight } from "../src/character.js";
import { decodePng } from "../src/png.js";
import { buildCharacter } from "./fixtures.js";
import { startHarness } from "./helpers.js";
import type { Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
  await h.ok("load_palette", { name: "pico8", source: "builtin:pico8" });
});
afterEach(async () => {
  await h.close();
});

describe("characters", () => {
  it("creates one layer per part and one frame per direction", async () => {
    const r = await h.ok("create_document", { name: "c", kind: "character", width: 32, height: 32 });
    expect(r.data.layers).toEqual(["foot_l", "foot_r", "body", "hand_l", "hand_r", "head"]);
    expect(r.data.frames).toBe(4);
    const info = await h.ok("get_document_info", { docId: r.data.docId });
    expect(info.data.rig.directions).toEqual(["down", "up", "left", "right"]);
    expect(info.data.rig.drawOrder.right).toEqual(["hand_l", "foot_l", "body", "foot_r", "head", "hand_r"]);
    expect(info.data.rig.parts.find((p: { layerId: string }) => p.layerId === "head").parent).toBe("body");
    expect(info.data.frames.map((f: { label: string }) => f.label)).toEqual(["down", "up", "left", "right"]);
    expect(swapLeftRight("arm_l_upper")).toBe("arm_r_upper");
    expect(swapLeftRight("body")).toBe("body");
  });

  it("mirrors a direction: flipped parts, swapped layers, mirrored pivots and draw order", async () => {
    const id = await buildCharacter(h);
    const info = await h.ok("get_document_info", { docId: id });
    const rig = info.data.rig;
    expect(rig.mirrors).toEqual({ left: "right" });
    expect(rig.drawOrder.left).toEqual(["hand_r", "foot_r", "body", "foot_l", "head", "hand_l"]);
    const handR = rig.parts.find((p: { layerId: string }) => p.layerId === "hand_r");
    expect(handR.byDirection.left).toEqual({ pivot: { x: 13, y: 18 }, attachPoint: { x: 13, y: 18 } }); // 32 - 19
    // hand_l drawn at x=18..20 facing right → hand_r at x=11..13 facing left
    const rows = (await h.ok("read_grid", { docId: id, layerId: "hand_r", frame: 2, y: 17, h: 1 })).data.rows;
    expect(rows[0]).toBe("___________ggg__________________"); // index 16 reads back as "g"
  });

  it("assembles poses with hierarchical offsets and reports gaps", async () => {
    const id = await buildCharacter(h);
    const all = await h.ok("render_assembled", { docId: id });
    expect(all.data.renders.map((r: { direction: string }) => r.direction)).toEqual(["down", "up", "left", "right"]);
    expect(all.data.renders.every((r: { gaps: unknown[] }) => r.gaps.length === 0)).toBe(true);
    const walk = await h.ok("render_assembled", { docId: id, pose: "walk_*", direction: "right", showPivots: true });
    expect(walk.data.renders.map((r: { pose: string }) => r.pose)).toEqual(["walk_0", "walk_1", "walk_2", "walk_3"]);
    // Head follows the body (dy -1 in walk_1).
    const single = await h.ok("render_assembled", { docId: id, pose: "walk_1", direction: "down" });
    expect(single.images.length).toBe(1);
    const bad = await h.ok("define_pose", { docId: id, pose: { name: "broken", parts: { hand_l: { dx: 6, dy: 0 } } } });
    expect(bad.data.warnings.some((w: string) => w.includes('"hand_l" no longer overlaps "body"'))).toBe(true);
    const v = await h.ok("validate_document", { docId: id });
    expect(v.data.warnings.some((w: { check: string; message: string }) => w.check === "rig-overlap" && w.message.includes("pose broken"))).toBe(true);
  });

  it("exports an atlas with part frames and a character block", async () => {
    const id = await buildCharacter(h);
    const out = await h.ok("export_character", { docId: id });
    expect(out.data.parts).toBe(24);
    const meta = JSON.parse(fs.readFileSync(path.join(h.root, "assets/hero.json"), "utf8"));
    const headDown = meta.frames.find((f: { name: string }) => f.name === "head_down");
    expect(headDown).toMatchObject({ part: "head", direction: "down", offsetPx: { x: 10, y: 4 }, rect: { w: 12, h: 12 }, pivotPx: { x: 6, y: 11 } });
    expect(headDown.center).toEqual({ x: 0.5, y: 1 / 12 });
    expect(meta.character.directions).toEqual(["down", "up", "left", "right"]);
    expect(meta.character.poses.map((p: { name: string }) => p.name)).toContain("walk_3");
    expect(meta.character.originPx).toEqual({ x: 16, y: 32 });
    expect(meta.layout).toEqual({ type: "character", mode: "atlas", padding: 2, extrude: 1 });
    const png = decodePng(fs.readFileSync(path.join(h.root, "assets/hero.png")));
    expect(png.width).toBe(meta.size.w);
    const manifest = fs.readFileSync(path.join(h.root, "assets/assets.generated.ts"), "utf8");
    expect(manifest).toContain('"character": {');
  });

  it("exports one PNG per part and direction in parts mode", async () => {
    const id = await buildCharacter(h);
    const out = await h.ok("export_character", { docId: id, mode: "parts", name: "hero_parts" });
    expect(out.data.files).toContain("assets/hero_parts_head_down.png");
    expect(out.data.files).toContain("assets/hero_parts.json");
    const meta = JSON.parse(fs.readFileSync(path.join(h.root, "assets/hero_parts.json"), "utf8"));
    expect(meta.image).toBeUndefined();
    expect(meta.frames[0].image).toMatch(/^hero_parts_.*\.png$/);
    const manifest = fs.readFileSync(path.join(h.root, "assets/assets.generated.ts"), "utf8");
    expect(manifest).toContain('"url": "assets/hero_parts_head_down.png"');
  });
});
