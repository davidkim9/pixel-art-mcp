import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const NAMES = ["sword", "shield", "potion", "key", "coin", "gem", "bow", "scroll"];

async function makeIcons(): Promise<string> {
  const r = await h.ok("create_icon_set", { name: "items", size: 16, count: 8, names: NAMES });
  expect(r.data.safeArea).toEqual({ x: 1, y: 1, w: 14, h: 14 });
  expect(r.data.layers).toEqual(["icon", "guide"]);
  const id = r.data.docId as string;
  for (let f = 0; f < 8; f++) {
    await h.ok("draw_ellipse", { docId: id, frame: f, cx: 7, cy: 7, rx: 3 + (f % 3), ry: 4, c: 9 + (f % 6), filled: true });
  }
  return id;
}

describe("icons", () => {
  it("applies a consistent, regenerable outline and shadow", async () => {
    const id = await makeIcons();
    const first = await h.ok("apply_icon_style", { docId: id, outline: 1, shadow: { color: 2, dx: 1, dy: 1 } });
    expect(first.data.layers).toEqual(["style_shadow", "style_outline", "icon", "guide"]);
    expect(first.data.outlinePixels).toBeGreaterThan(0);
    const again = await h.ok("apply_icon_style", { docId: id });
    expect(again.data.outlinePixels).toBe(first.data.outlinePixels);
    expect(again.data.shadowPixels).toBe(first.data.shadowPixels);
    const rows = (await h.ok("read_grid", { docId: id, frame: 0, y: 7, h: 1 })).data.rows;
    // ellipse rx=3 around x=7: fill 4..10, outline at 3 and 11, shadow at 12
    expect(rows[0]).toBe("___1999999912___");
    const noShadow = await h.ok("apply_icon_style", { docId: id, outline: { color: 1, connectivity: 8 }, shadow: null });
    expect(noShadow.data.layers).toEqual(["style_outline", "icon", "guide"]);
    const v = await h.ok("validate_document", { docId: id });
    expect(v.data.warnings.filter((w: { check: string }) => w.check === "icon-safe-area")).toEqual([]);
  });

  it("warns about content outside the safe area", async () => {
    const id = await makeIcons();
    await h.ok("set_pixels", { docId: id, frame: 3, layerId: "icon", pixels: [{ x: 0, y: 0, c: 8 }] });
    const v = await h.ok("validate_document", { docId: id });
    const w = v.data.warnings.find((x: { check: string }) => x.check === "icon-safe-area");
    expect(w.details).toEqual([{ frame: 3, pixels: 1 }]);
  });

  it("exports an atlas mapping names to frames", async () => {
    const id = await makeIcons();
    await h.ok("apply_icon_style", { docId: id, outline: 1, shadow: 2 });
    const out = await h.ok("export_icon_atlas", { docId: id });
    expect(out.data.icons).toEqual(Object.fromEntries(NAMES.map((n, i) => [n, i])));
    expect(out.data.size).toEqual({ w: 56, h: 56 });
    const meta = JSON.parse(fs.readFileSync(path.join(h.root, "assets/items.json"), "utf8"));
    expect(meta.frames.map((f: { name: string }) => f.name)).toEqual(NAMES);
    expect(meta.frames[4].rect).toEqual({ x: 20, y: 20, w: 16, h: 16 });
    expect(meta.icon).toEqual({ size: 16, margin: 1 });
    const renamed = await h.ok("export_icon_atlas", { docId: id, names: ["a", "b"], columns: 8, name: "items_row" });
    expect(Object.keys(renamed.data.icons).slice(0, 3)).toEqual(["a", "b", "potion"]);
    expect(renamed.data.size).toEqual({ w: 2 + 8 * 18, h: 20 });
    const dup = await h.call("export_icon_atlas", { docId: id, names: ["x", "x"] });
    expect(dup.isError).toBe(true);
  });
});
