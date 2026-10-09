import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { colorDistance, parseHexColor, rgbKey } from "../color.js";
import type { RGB } from "../color.js";
import { checkFrame, compositeIndexed, exportLayers, framesForTag } from "../document.js";
import { encodeGif } from "../gif.js";
import { paletteRgb } from "../palette.js";
import type { Project } from "../project.js";
import { assemble } from "../character.js";
import { AffineBuffer, affineFromIndices, composeFrame } from "../render/compose.js";
import type { Background } from "../render/compose.js";
import { autoScale, blitAffine, clampScale, renderCanvasView, renderSheet, tileAffine } from "../render/previews.js";
import type { SheetCell } from "../render/previews.js";
import type { Document } from "../types.js";
import { fail } from "../util/errors.js";
import { sanitizeAssetName } from "../util/ids.js";
import { framePreview, zDocId } from "./helpers.js";
import type { Register } from "./helpers.js";

function frameTitle(doc: Document, i: number): { title: string; subtitle?: string } {
  const f = doc.frames[i]!;
  const sub = [f.tag ? `[${f.tag}]` : "", f.label ?? ""].filter(Boolean).join(" ");
  return { title: `#${i} ${f.durationMs}ms`, subtitle: sub || undefined };
}

/** Composite for GIF/onion use: visible, exportable layers only (no guides). */
export function exportComposite(doc: Document, palette: RGB[], frame: number): AffineBuffer {
  return composeFrame(doc, palette, frame, { showGuides: false });
}

export function registerPreviewTools(register: Register, project: Project): void {
  register({
    name: "render_preview",
    title: "Render preview 🖼",
    description:
      "Upscaled image of one frame (nearest neighbor) with checkerboard transparency, pixel grid and coordinate rulers. " +
      "layers: only show these layer ids. Guide layers are drawn faintly.",
    input: {
      docId: zDocId,
      frame: z.number().int().min(0).optional(),
      scale: z.number().int().min(1).max(32).optional().describe("default 8"),
      grid: z.boolean().optional().describe("default true"),
      layers: z.array(z.string()).optional(),
    },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const frame = args.frame ?? 0;
      checkFrame(doc, frame);
      const scale = clampScale(args.scale ?? 8, doc.width, doc.height, 40);
      return {
        data: { docId: doc.id, frame, scale, size: { w: doc.width, h: doc.height } },
        images: [framePreview(project, doc, frame, { scale, grid: args.grid ?? true, layers: args.layers })],
      };
    },
  });

  register({
    name: "render_frames",
    title: "Render frames 🖼",
    description: "Contact sheet of all frames (or one tag's frames) side by side, labelled with index, duration, tag and label. Use it to review motion.",
    input: { docId: zDocId, tag: z.string().optional(), scale: z.number().int().min(1).max(16).optional(), grid: z.boolean().optional() },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const palette = paletteRgb(project.paletteFor(doc));
      const frames = framesForTag(doc, args.tag);
      const scale = clampScale(args.scale ?? autoScale(doc.width, doc.height, 128), doc.width, doc.height, 0);
      const cells: SheetCell[] = frames.map((i) => ({ buf: composeFrame(doc, palette, i), ...frameTitle(doc, i) }));
      return {
        data: { docId: doc.id, frames: frames.length, scale, totalMs: frames.reduce((s, i) => s + doc.frames[i]!.durationMs, 0) },
        images: [renderSheet(cells, scale, { grid: args.grid ?? false }).toPng()],
      };
    },
  });

  register({
    name: "render_onion",
    title: "Render onion skin 🖼",
    description: "The frame drawn over its neighbours: previous frames tinted red, next frames tinted blue, fading with distance.",
    input: {
      docId: zDocId,
      frame: z.number().int().min(0),
      before: z.number().int().min(0).max(4).optional(),
      after: z.number().int().min(0).max(4).optional(),
      scale: z.number().int().min(1).max(32).optional(),
      loop: z.boolean().optional().describe("wrap around at the ends (looping animations)"),
    },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      checkFrame(doc, args.frame);
      const palette = paletteRgb(project.paletteFor(doc));
      const before = args.before ?? 1;
      const after = args.after ?? 1;
      const n = doc.frames.length;
      const buf = new AffineBuffer(doc.width, doc.height);
      const ghost = (k: number, dist: number, tint: RGB, total: number) => {
        let f = args.frame + k;
        if (args.loop) f = ((f % n) + n) % n;
        if (f < 0 || f >= n || f === args.frame) return;
        const pix = compositeIndexed(doc, f, exportLayers("normal"));
        const alpha = 0.5 * (1 - (dist - 1) / (total + 1));
        for (let p = 0; p < pix.length; p++) {
          if (pix[p] === 0) continue;
          const c = palette[pix[p]!]!;
          buf.mix(p, { r: (c.r + tint.r) / 2, g: (c.g + tint.g) / 2, b: (c.b + tint.b) / 2 }, alpha);
        }
      };
      for (let d = before; d >= 1; d--) ghost(-d, d, { r: 255, g: 40, b: 40 }, before);
      for (let d = after; d >= 1; d--) ghost(d, d, { r: 40, g: 110, b: 255 }, after);
      const current = composeFrame(doc, palette, args.frame, { showGuides: false });
      for (let p = 0; p < doc.width * doc.height; p++) {
        if (current.isEmpty(p)) continue;
        const o = p * 4;
        if (current.data[o] === 0) {
          for (let k = 0; k < 4; k++) buf.data[o + k] = current.data[o + k]!;
        } else {
          buf.data[o + 1] = buf.data[o + 1]! + current.data[o + 1]!;
          buf.data[o + 2] = buf.data[o + 2]! + current.data[o + 2]!;
          buf.data[o + 3] = buf.data[o + 3]! + current.data[o + 3]!;
        }
      }
      const scale = clampScale(args.scale ?? autoScale(doc.width, doc.height), doc.width, doc.height, 40);
      return {
        data: { docId: doc.id, frame: args.frame, before, after, legend: "red = previous frames, blue = next frames" },
        images: [renderCanvasView(buf, { scale, grid: true, rulers: true }).toPng()],
      };
    },
  });

  register({
    name: "render_tiled",
    title: "Render tiled 🖼",
    description: "A frame repeated repeat×repeat (default 3) to spot seams in tiles and textures.",
    input: {
      docId: zDocId,
      frame: z.number().int().min(0).optional(),
      repeat: z.number().int().min(2).max(8).optional(),
      scale: z.number().int().min(1).max(16).optional(),
    },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const frame = args.frame ?? 0;
      checkFrame(doc, frame);
      const palette = paletteRgb(project.paletteFor(doc));
      const n = args.repeat ?? 3;
      const tiled = tileAffine(exportComposite(doc, palette, frame), n, n);
      const scale = clampScale(args.scale ?? autoScale(tiled.width, tiled.height, 480), tiled.width, tiled.height, 0);
      return {
        data: { docId: doc.id, frame, repeat: n, scale },
        images: [renderCanvasView(tiled, { scale, grid: false }).toPng()],
      };
    },
  });

  register({
    name: "render_in_context",
    title: "Render in context 🖼",
    description:
      "Several assets side by side at the same scale, bottom-aligned, to check that sizes and styles match. frames: frame per document " +
      "(default 0). background: \"checker\" (default) or a hex color.",
    input: {
      docIds: z.array(z.string()).min(1).max(24),
      layout: z.enum(["row", "grid"]).optional(),
      scale: z.number().int().min(1).max(16).optional(),
      frames: z.array(z.number().int().min(0)).optional(),
      background: z.string().optional(),
    },
    readOnly: true,
    handler: (args) => {
      const docs = args.docIds.map((id) => project.getDoc(id));
      const maxW = Math.max(...docs.map((d) => d.width));
      const maxH = Math.max(...docs.map((d) => d.height));
      let bg: Background = "checker";
      if (args.background && args.background !== "checker") {
        const c = parseHexColor(args.background);
        bg = [c.r, c.g, c.b];
      }
      const cells: SheetCell[] = docs.map((d, i) => {
        const frame = args.frames?.[i] ?? 0;
        checkFrame(d, frame);
        const own = d.rig?.directions[frame]
          ? affineFromIndices(assemble(d, d.rig.directions[frame]!).pixels, d.width, d.height, paletteRgb(project.paletteFor(d)))
          : composeFrame(d, paletteRgb(project.paletteFor(d)), frame, { showGuides: false });
        const buf = new AffineBuffer(maxW, maxH);
        blitAffine(buf, own, Math.floor((maxW - d.width) / 2), maxH - d.height);
        return { buf, title: d.name, subtitle: `${d.width}x${d.height}` };
      });
      const columns = args.layout === "grid" ? Math.ceil(Math.sqrt(docs.length)) : docs.length;
      const scale = clampScale(args.scale ?? autoScale(maxW, maxH, 160), maxW * Math.min(columns, docs.length), maxH, 0);
      return {
        data: { docs: docs.map((d) => ({ id: d.id, name: d.name, size: { w: d.width, h: d.height } })), scale },
        images: [renderSheet(cells, scale, { background: bg, columns }).toPng()],
      };
    },
  });

  register({
    name: "export_gif",
    title: "Export GIF",
    description:
      "Write an animated GIF of all frames (or one tag) for a HUMAN to review, scaled up (default 4×). Returns the file path, not an image. " +
      "Files go to outputDir/.pixelmcp/previews/.",
    input: { docId: zDocId, tag: z.string().optional(), scale: z.number().int().min(1).max(16).optional() },
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const frames = framesForTag(doc, args.tag);
      const scale = args.scale ?? 4;
      const base = paletteRgb(project.paletteFor(doc));
      // Global table: transparent slot, the document palette, then extra colors made by additive blending.
      const table: RGB[] = [{ r: 0, g: 0, b: 0 }, ...base.slice(1)];
      const lookup = new Map<number, number>();
      table.forEach((c, i) => {
        if (i > 0 && !lookup.has(rgbKey(c.r, c.g, c.b))) lookup.set(rgbKey(c.r, c.g, c.b), i);
      });
      const indexOf = (r: number, g: number, b: number): number => {
        const key = rgbKey(r, g, b);
        const hit = lookup.get(key);
        if (hit !== undefined) return hit;
        if (table.length < 256) {
          table.push({ r, g, b });
          lookup.set(key, table.length - 1);
          return table.length - 1;
        }
        let best = 1;
        let bestD = Infinity;
        for (let i = 1; i < table.length; i++) {
          const d = colorDistance({ r, g, b }, table[i]!);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        lookup.set(key, best);
        return best;
      };
      const W = doc.width * scale;
      const H = doc.height * scale;
      const gifFrames = frames.map((f) => {
        const buf = exportComposite(doc, base, f);
        const small = new Uint8Array(doc.width * doc.height);
        for (let p = 0; p < small.length; p++) {
          if (buf.isEmpty(p)) continue;
          const [r, g, b] = buf.resolve(p, [0, 0, 0]);
          small[p] = indexOf(r, g, b!);
        }
        const big = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) big[y * W + x] = small[Math.floor(y / scale) * doc.width + Math.floor(x / scale)]!;
        return { indices: big, delayMs: doc.frames[f]!.durationMs };
      });
      if (!gifFrames.length) fail("No frames to export.");
      const gif = encodeGif({ width: W, height: H, palette: table, transparentIndex: 0, frames: gifFrames });
      const name = sanitizeAssetName(doc.name).replace(/\//g, "_") + (args.tag ? `_${sanitizeAssetName(args.tag)}` : "");
      const file = path.join(project.stateDir, "previews", `${name}.gif`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, gif);
      return { data: { path: file, relativePath: project.displayPath(file), frames: frames.length, size: { w: W, h: H } } };
    },
  });
}
