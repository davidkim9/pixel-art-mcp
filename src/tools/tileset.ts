import { z } from "zod";
import { checkFrame, compositeIndexed, exportLayers, resolveLayerId } from "../document.js";
import { writeExport } from "../export/write.js";
import { paletteRgb } from "../palette.js";
import type { Project } from "../project.js";
import { affineFromIndices, composeFrame } from "../render/compose.js";
import { autoScale, clampScale, renderCanvasView, renderSheet, tileAffine } from "../render/previews.js";
import type { Highlight, SheetCell } from "../render/previews.js";
import { BLOB47_MASKS, BLOB_TEST_MAP } from "../tileset/blob47.js";
import { TEST_MAP, defaultTerrainLegend, edgePoint, frameLabel, parseTerrainMap } from "../tileset/corner15.js";
import { analyzeSeams } from "../tileset/seams.js";
import { checkTransitionSet, createTransitionSet, exportTileset, generateAutotile, requireTemplate, renderTerrain } from "../tileset/sets.js";
import { fail } from "../util/errors.js";
import { docPreview, zDocId, zPreview } from "./helpers.js";
import type { Register } from "./helpers.js";

export function registerTilesetTools(register: Register, project: Project): void {
  register({
    name: "set_wrap_mode",
    title: "Set wrap mode",
    description: "When enabled, every drawing tool wraps around the canvas edges (pixels leaving one side enter the opposite side). Use it to draw seamless tiles.",
    input: { docId: zDocId, enabled: z.boolean() },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      if (doc.tileset) doc.tileset.wrapDrawing = args.enabled;
      else doc.wrap = args.enabled;
      return { data: { docId: doc.id, wrap: args.enabled } };
    },
  });

  register({
    name: "check_seams",
    title: "Check seams 🖼",
    description:
      "Compare opposite edges of a tile (right↔left, bottom↔top): the pixels that touch when it repeats. Reports pixel pairs whose transparency " +
      "differs or whose contrast is well above the tile's own pixel-to-pixel contrast, with a verdict, plus a 3×3 tiled preview with flagged pixels outlined.",
    input: { docId: zDocId, frame: z.number().int().min(0).optional(), scale: z.number().int().min(1).max(16).optional() },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const frame = args.frame ?? 0;
      checkFrame(doc, frame);
      const palette = paletteRgb(project.paletteFor(doc));
      const pixels = compositeIndexed(doc, frame, exportLayers("normal"));
      const report = analyzeSeams(pixels, doc.width, doc.height, palette);
      const tiled = tileAffine(affineFromIndices(pixels, doc.width, doc.height, palette), 3, 3);
      const highlights: Highlight[] = [];
      for (const pair of [...report.horizontal.flagged, ...report.vertical.flagged]) {
        // Mark both sides of the seam around the center copy.
        highlights.push({ x: pair.a.x + doc.width, y: pair.a.y + doc.height });
        highlights.push({
          x: pair.b.x + doc.width + (pair.a.x !== pair.b.x ? doc.width : 0),
          y: pair.b.y + doc.height + (pair.a.y !== pair.b.y ? doc.height : 0),
        });
      }
      const scale = clampScale(args.scale ?? autoScale(tiled.width, tiled.height, 480), tiled.width, tiled.height);
      return {
        data: {
          docId: doc.id,
          frame,
          verdict: report.verdict,
          horizontal: { ...report.horizontal, flagged: report.horizontal.flagged.slice(0, 40) },
          vertical: { ...report.vertical, flagged: report.vertical.flagged.slice(0, 40) },
        },
        images: [renderCanvasView(tiled, { scale, grid: false, highlights }).toPng()],
      };
    },
  });

  register({
    name: "create_transition_set",
    title: "Create transition set",
    description:
      "Create a tileset document for terrain transitions. template corner15 (default; dual grid): 16 frames where frame index === corner mask " +
      "(TL*1 + TR*2 + BR*4 + BL*8, 1 = upper terrain); frame 0 is all-lower (leave empty in overlay mode). blob47: 47 cell-centered tiles " +
      "(frame i = mask in ascending order). A faint, locked guide layer dots the upper-terrain corners of every frame. overlay (default true): " +
      "lower-terrain corners are transparent, drawn over a separate base. Draw on layer \"tiles\".",
    input: {
      name: z.string().min(1),
      tileSize: z.number().int().min(4).max(256),
      template: z.enum(["corner15", "blob47"]).optional(),
      terrains: z.object({ lower: z.string(), upper: z.string() }),
      paletteId: z.string().optional(),
      overlay: z.boolean().optional(),
    },
    handler: (args) => {
      const doc = createTransitionSet(project, {
        name: args.name,
        tileSize: args.tileSize,
        template: args.template ?? "corner15",
        terrains: args.terrains,
        paletteId: args.paletteId,
        overlay: args.overlay ?? true,
      });
      project.addDoc(doc);
      const guidance =
        doc.tileset!.template === "corner15"
          ? "Draw tile 15 (full) first, then one edge (e.g. 3), one outer corner (e.g. 1) and one inner corner (e.g. 7); run generate_autotile, hand-draw diagonals 5 and 10, then check_transition_set and render_terrain_preview."
          : "Draw the five source tiles (isolated 0, vertical strip 17, horizontal strip 68, cross 85, full 255), run generate_autotile, then check with render_terrain_preview.";
      return {
        data: {
          docId: doc.id,
          tileSize: args.tileSize,
          template: doc.tileset!.template,
          frames: doc.frames.length,
          layers: doc.layers.map((l) => l.id),
          overlay: doc.tileset!.overlay,
          guidance,
        },
      };
    },
  });

  register({
    name: "generate_autotile",
    title: "Generate autotile",
    description:
      "Fill in the remaining tiles of a transition set from hand-drawn source tiles, as a starting point to refine. corner15: sources are masks " +
      "(frame indices) you drew, e.g. [15, 3, 1, 7]; other tiles are derived with lossless flips/rotations (flips preferred) and diagonals 5/10 " +
      "are composed from two outer corners unless you drew one. blob47: uses the five source tiles (masks 0, 17, 68, 85, 255) quadrant by quadrant. " +
      "Existing tiles are kept unless overwrite is true. Lighting direction may need hand fixes after rotations.",
    input: {
      docId: zDocId,
      template: z.enum(["corner15", "blob47"]).optional(),
      sources: z.array(z.number().int().min(0)).optional().describe("corner15: masks of hand-drawn tiles (default: every non-empty tile)"),
      overwrite: z.boolean().optional(),
      layerId: z.string().optional(),
      preview: zPreview,
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const template = requireTemplate(doc);
      if (args.template && args.template !== template) fail(`This document is a ${template} set, not ${args.template}.`);
      const layerId = resolveLayerId(doc, args.layerId);
      const report = generateAutotile(doc, args.sources, args.overwrite ?? false, layerId);
      const data = { template, ...report, next: "Review with render_frames / check_transition_set; hand-draw anything that looks wrong (especially diagonals)." };
      return args.preview ? { data, images: [docPreview(project, doc)] } : { data };
    },
  });

  register({
    name: "check_transition_set",
    title: "Check transition set 🖼",
    description:
      "Verify a transition set: every tile exists, and tiles whose edge on the same side has the same corner pair have identical pixels on that edge " +
      "(e.g. the right edge of every tile with TR=1,BR=0 must match). Also flags high-contrast seams where tiles repeat. Returns mismatches and a " +
      "4×4 contact sheet with mismatched edge pixels outlined.",
    input: { docId: zDocId, scale: z.number().int().min(1).max(16).optional() },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const result = checkTransitionSet(project, doc);
      const palette = paletteRgb(project.paletteFor(doc));
      const size = doc.width;
      const highlights = new Map<number, Highlight[]>();
      for (const mm of result.mismatches) {
        const list = highlights.get(mm.tile) ?? [];
        for (const i of mm.positions) list.push(edgePoint(size, mm.side, i));
        highlights.set(mm.tile, list);
      }
      const cells: SheetCell[] = doc.frames.map((f, i) => ({
        buf: composeFrame(doc, palette, i, { showGuides: false }),
        title: result.template === "corner15" ? frameLabel(i) : `#${i} m${BLOB47_MASKS[i]}`,
        subtitle: result.missing.includes(result.template === "corner15" ? i : BLOB47_MASKS[i]!) ? "MISSING" : highlights.has(i) ? "EDGE MISMATCH" : undefined,
        highlights: highlights.get(i),
      }));
      const scale = clampScale(args.scale ?? autoScale(size, size, 96), size * 4, size * 4);
      const image = renderSheet(cells, scale, { columns: result.template === "corner15" ? 4 : 8 }).toPng();
      return {
        data: {
          ok: result.ok,
          template: result.template,
          missing: result.missing,
          mismatches: result.mismatches.slice(0, 60),
          mismatchCount: result.mismatches.length,
          seamWarnings: result.seamWarnings.map((w) => ({ tile: w.tile, axis: w.axis, flagged: w.flagged.length })),
          baseNotEmpty: result.baseNotEmpty,
        },
        images: [image],
      };
    },
  });

  register({
    name: "render_terrain_preview",
    title: "Render terrain preview 🖼",
    description:
      "Render a sample map with the set. map: rows of characters, one per world cell — \"#\"/\"1\" or the upper terrain's first letter (e.g. \"g\") for " +
      "upper, \".\"/\"0\" or the lower terrain's first letter (\"d\") for lower; or pass your own legend. corner15 sets render on the dual grid (W×H cells → " +
      "(W+1)×(H+1) tiles, offset by half a tile). Without a map, a built-in test map with every corner combination (diagonals, 1-cell strips) is used. " +
      "base: {docId, frame} draws a base tile underneath (useful in overlay mode).",
    input: {
      docId: zDocId,
      map: z.array(z.string()).optional(),
      legend: z.record(z.string(), z.enum(["upper", "lower"])).optional(),
      scale: z.number().int().min(1).max(16).optional(),
      base: z.object({ docId: z.string(), frame: z.number().int().min(0).optional() }).optional(),
    },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const template = requireTemplate(doc);
      const map = args.map ?? (template === "corner15" ? TEST_MAP : BLOB_TEST_MAP);
      const legend = { ...defaultTerrainLegend(doc.tileset!.terrains), ...(args.legend ?? {}) };
      const { cells, unknown } = parseTerrainMap(map, legend);
      if (unknown.length) fail(`Map characters not in legend: ${unknown.map((c) => JSON.stringify(c)).join(", ")}. Legend: ${JSON.stringify(legend)}`);
      let base;
      if (args.base) {
        const baseDoc = project.getDoc(args.base.docId);
        const frame = args.base.frame ?? 0;
        checkFrame(baseDoc, frame);
        if (baseDoc.width !== doc.width || baseDoc.height !== doc.height) fail("The base tile must have the same size as the set's tiles.");
        base = { doc: baseDoc, frame };
      }
      const r = renderTerrain(project, doc, cells, base);
      const scale = clampScale(args.scale ?? autoScale(r.buf.width, r.buf.height, 640), r.buf.width, r.buf.height);
      return {
        data: { template, cells: { w: cells[0]?.length ?? 0, h: cells.length }, usedMasks: r.usedMasks, missingTiles: r.missingTiles, builtInMap: !args.map },
        images: [renderCanvasView(r.buf, { scale, grid: false }).toPng()],
      };
    },
  });

  register({
    name: "export_tileset",
    title: "Export tileset",
    description:
      "Export a tileset as one indexed PNG atlas with padding + extrusion and metadata listing each tile's rect and its corner mask or blob mask. " +
      "corner15 sets use a 4×4 grid in mask order (slot 0 = mask 0, empty in overlay mode) so the frame index equals the mask; blob47 metadata includes " +
      "a 256-entry maskToFrame table. Validation errors (missing tiles, edge mismatches) block the export.",
    input: { docId: zDocId, columns: z.number().int().min(1).optional(), name: z.string().optional() },
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const result = exportTileset(project, doc, args);
      return { data: { ...writeExport(project, result), size: result.metadata.size, tiles: result.metadata.frames.length } };
    },
  });
}
