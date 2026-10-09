import { z } from "zod";
import { checkFrame, ensureCel, getCel, resolveLayerId } from "../document.js";
import type { Project } from "../project.js";
import { isWrapEnabled } from "../raster.js";
import {
  colorMask,
  combineMasks,
  contentMask,
  flipSelected,
  maskBounds,
  maskCount,
  moveSelected,
  offsetCel,
  rectMask,
  rotateSelected,
} from "../selection.js";
import type { SelectMode, TransformResult } from "../selection.js";
import type { Document } from "../types.js";
import { fail } from "../util/errors.js";
import { drawTarget, withPreview, zDocId, zFrame, zLayerId, zPreview } from "./helpers.js";
import type { DrawTarget, Register } from "./helpers.js";

const zMode = z.enum(["replace", "add", "subtract", "intersect"]).optional().describe("How to combine with the current selection (default replace)");

export function registerSelectionTools(register: Register, project: Project): void {
  const summary = (doc: Document) => {
    const sel = project.getSelection(doc);
    return sel ? { bounds: maskBounds(sel, doc.width, doc.height), pixels: maskCount(sel) } : { bounds: null, pixels: 0 };
  };
  const setSelection = (doc: Document, mask: Uint8Array, mode: SelectMode | undefined) => {
    const next = combineMasks(project.getSelection(doc), mask, mode ?? "replace");
    if (maskCount(next) === 0) project.selections.delete(doc.id);
    else project.selections.set(doc.id, next);
    return summary(doc);
  };
  /** The active selection, or the whole canvas. */
  const selectionOrAll = (doc: Document) => project.getSelection(doc) ?? new Uint8Array(doc.width * doc.height).fill(1);
  const apply = (t: DrawTarget, r: TransformResult, keepSelection: boolean) => {
    t.cel.set(r.cel);
    if (keepSelection && project.getSelection(t.doc)) {
      if (maskCount(r.mask)) project.selections.set(t.doc.id, r.mask);
      else project.selections.delete(t.doc.id);
    }
    return { selection: summary(t.doc), clippedPixels: r.clipped };
  };

  register({
    name: "select_rect",
    title: "Select rectangle",
    description: "Select a rectangle. Selections are per document and are used by move/copy/flip/rotate and by region: \"selection\".",
    input: { docId: zDocId, x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1), mode: zMode },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      return { data: setSelection(doc, rectMask(doc.width, doc.height, args), args.mode) };
    },
  });

  register({
    name: "select_by_color",
    title: "Select by color",
    description:
      "Magic wand. contiguous: true selects the 4-connected region around (x, y) (index defaults to the color there); " +
      "contiguous: false selects every pixel of `index` in the layer.",
    input: {
      docId: zDocId,
      layerId: zLayerId,
      frame: zFrame,
      index: z.number().int().min(0).max(255).optional(),
      contiguous: z.boolean(),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      mode: zMode,
    },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const layerId = resolveLayerId(doc, args.layerId);
      const frame = args.frame ?? 0;
      checkFrame(doc, frame);
      const cel = getCel(doc, layerId, frame) ?? new Uint8Array(doc.width * doc.height);
      let seed: { x: number; y: number } | undefined;
      let index = args.index;
      if (args.contiguous) {
        if (args.x === undefined || args.y === undefined) fail("contiguous selection needs a seed point (x, y).");
        if (args.x < 0 || args.y < 0 || args.x >= doc.width || args.y >= doc.height) fail("Seed point is outside the canvas.");
        seed = { x: args.x, y: args.y };
        const at = cel[args.y * doc.width + args.x]!;
        if (index !== undefined && index !== at) fail(`Pixel (${args.x}, ${args.y}) has index ${at}, not ${index}.`);
        index = at;
      }
      if (index === undefined) fail("Pass index (or contiguous: true with x, y).");
      const mask = colorMask(cel, doc.width, doc.height, index, args.contiguous, seed, isWrapEnabled(doc));
      return { data: setSelection(doc, mask, args.mode) };
    },
  });

  register({
    name: "select_layer_content",
    title: "Select layer content",
    description: "Select all non-transparent pixels of a layer in a frame.",
    input: { docId: zDocId, layerId: z.string(), frame: zFrame, mode: zMode },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const layerId = resolveLayerId(doc, args.layerId);
      const frame = args.frame ?? 0;
      checkFrame(doc, frame);
      const cel = getCel(doc, layerId, frame) ?? new Uint8Array(doc.width * doc.height);
      return { data: setSelection(doc, contentMask(cel), args.mode) };
    },
  });

  register({
    name: "deselect",
    title: "Deselect",
    description: "Clear the selection of a document.",
    input: { docId: zDocId },
    readOnly: true,
    handler: (args) => {
      project.selections.delete(project.getDoc(args.docId).id);
      return { data: { selection: null } };
    },
  });

  register({
    name: "move_selection",
    title: "Move selection",
    description:
      "Move the selected pixels of a layer by (dx, dy); the selection moves too. Transparent selected pixels don't overwrite the destination. " +
      "Wraps around edges in wrap mode.",
    input: { docId: zDocId, layerId: zLayerId, frame: zFrame, dx: z.number().int(), dy: z.number().int(), preview: zPreview },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      if (!project.getSelection(t.doc)) fail("Nothing is selected.");
      const r = moveSelected(t.cel, project.getSelection(t.doc)!, t.doc.width, t.doc.height, args.dx, args.dy, isWrapEnabled(t.doc));
      return withPreview(project, t.doc, t.frame, args.preview, apply(t, r, true));
    },
  });

  register({
    name: "copy_selection",
    title: "Copy selection",
    description: "Copy the selected pixels of a layer (or the whole layer if nothing is selected) to the clipboard. cut: true also clears them. The clipboard works across documents.",
    input: { docId: zDocId, layerId: zLayerId, frame: zFrame, cut: z.boolean().optional() },
    mutates: (a) => (a.cut ? a.docId : undefined),
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const layerId = resolveLayerId(doc, args.layerId);
      const frame = args.frame ?? 0;
      checkFrame(doc, frame);
      const cel = args.cut ? ensureCel(doc, layerId, frame) : (getCel(doc, layerId, frame) ?? new Uint8Array(doc.width * doc.height));
      const mask = selectionOrAll(doc);
      const b = maskBounds(mask, doc.width, doc.height);
      if (!b) fail("Nothing is selected.");
      const pixels = new Uint8Array(b.w * b.h);
      for (let y = 0; y < b.h; y++) {
        for (let x = 0; x < b.w; x++) {
          const p = (b.y + y) * doc.width + b.x + x;
          if (mask[p]) {
            pixels[y * b.w + x] = cel[p]!;
            if (args.cut) cel[p] = 0;
          }
        }
      }
      project.clipboard = { width: b.w, height: b.h, pixels, paletteId: doc.paletteId, sourceDocId: doc.id };
      return { data: { clipboard: { width: b.w, height: b.h, origin: { x: b.x, y: b.y } } } };
    },
  });

  register({
    name: "paste",
    title: "Paste",
    description: "Paste the clipboard with its top-left at (x, y). Transparent clipboard pixels don't overwrite. The pasted pixels become the selection.",
    input: { docId: zDocId, layerId: zLayerId, frame: zFrame, x: z.number().int(), y: z.number().int(), preview: zPreview },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const clip = project.clipboard;
      if (!clip) fail("The clipboard is empty (use copy_selection).");
      const wrap = isWrapEnabled(t.doc);
      const { width: w, height: h } = t.doc;
      const mask = new Uint8Array(w * h);
      let pasted = 0;
      let clipped = 0;
      for (let y = 0; y < clip.height; y++) {
        for (let x = 0; x < clip.width; x++) {
          const v = clip.pixels[y * clip.width + x]!;
          if (v === 0) continue;
          let tx = args.x + x;
          let ty = args.y + y;
          if (wrap) {
            tx = ((tx % w) + w) % w;
            ty = ((ty % h) + h) % h;
          } else if (tx < 0 || ty < 0 || tx >= w || ty >= h) {
            clipped++;
            continue;
          }
          t.cel[ty * w + tx] = v;
          mask[ty * w + tx] = 1;
          pasted++;
        }
      }
      if (pasted) project.selections.set(t.doc.id, mask);
      const warnings = clip.paletteId !== t.doc.paletteId ? [`Clipboard came from palette "${clip.paletteId}"; indices were pasted unchanged into "${t.doc.paletteId}".`] : [];
      return withPreview(project, t.doc, t.frame, args.preview, { pasted, clippedPixels: clipped, warnings });
    },
  });

  register({
    name: "flip_selection",
    title: "Flip selection",
    description: "Mirror the selected pixels (or the whole layer if nothing is selected) within their bounding box. axis: horizontal (left↔right) | vertical (top↔bottom).",
    input: { docId: zDocId, layerId: zLayerId, frame: zFrame, axis: z.enum(["horizontal", "vertical"]), preview: zPreview },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const r = flipSelected(t.cel, selectionOrAll(t.doc), t.doc.width, t.doc.height, args.axis);
      return withPreview(project, t.doc, t.frame, args.preview, apply(t, r, true));
    },
  });

  register({
    name: "rotate_selection_90",
    title: "Rotate selection 90°",
    description: "Rotate the selected pixels (or the whole layer) clockwise by 90° × times around the center of their bounding box. Lossless.",
    input: { docId: zDocId, layerId: zLayerId, frame: zFrame, times: z.number().int(), preview: zPreview },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const r = rotateSelected(t.cel, selectionOrAll(t.doc), t.doc.width, t.doc.height, args.times, isWrapEnabled(t.doc));
      const res = apply(t, r, true);
      const warnings = r.clipped ? [`${r.clipped} pixel(s) rotated outside the canvas and were dropped.`] : [];
      return withPreview(project, t.doc, t.frame, args.preview, { ...res, warnings });
    },
  });

  register({
    name: "offset_layer",
    title: "Offset layer",
    description:
      "Shift a whole layer by (dx, dy). wrap: true moves pixels leaving one edge to the opposite edge (essential for tiles). " +
      "allFrames applies it to every frame.",
    input: {
      docId: zDocId,
      layerId: zLayerId,
      frame: zFrame,
      dx: z.number().int(),
      dy: z.number().int(),
      wrap: z.boolean().optional(),
      allFrames: z.boolean().optional(),
      preview: zPreview,
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const frames = args.allFrames ? t.doc.frames.map((_, i) => i) : [t.frame];
      for (const f of frames) {
        const cel = ensureCel(t.doc, t.layerId, f);
        cel.set(offsetCel(cel, t.doc.width, t.doc.height, args.dx, args.dy, args.wrap ?? false));
      }
      return withPreview(project, t.doc, t.frame, args.preview, { frames: frames.length });
    },
  });
}
