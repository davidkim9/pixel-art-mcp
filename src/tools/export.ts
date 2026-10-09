import { z } from "zod";
import { exportSinglePng, exportSpritesheet } from "../export/exporters.js";
import { writeExport } from "../export/write.js";
import type { Project } from "../project.js";
import { validateDocument } from "../validate.js";
import { zDocId } from "./helpers.js";
import type { Register } from "./helpers.js";

export function registerExportTools(register: Register, project: Project): void {
  register({
    name: "export_png",
    title: "Export PNG",
    description:
      "Export one frame (default 0) as a single indexed PNG (palette embedded, index 0 transparent) plus metadata, to outputDir/<name>.png. " +
      "Visible non-guide layers are flattened; additive layers go to <name>_glow.png. Validation errors block the export.",
    input: { docId: zDocId, frame: z.number().int().min(0).optional(), name: z.string().optional().describe("export name (default: document name); may contain / for subfolders") },
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const result = exportSinglePng(project, doc, { frame: args.frame, name: args.name });
      return { data: { ...writeExport(project, result), size: result.metadata.size } };
    },
  });

  register({
    name: "export_spritesheet",
    title: "Export spritesheet",
    description:
      "Export all frames (or one tag) as an indexed PNG sheet + metadata (frame rects, durations, tags, pivots). " +
      "layout: row | grid | packed (packed trims each frame; offsetPx gives its position in the canvas). padding/extrude default to project settings. " +
      "Additive layers export as <name>_glow.png with the same layout.",
    input: {
      docId: zDocId,
      tag: z.string().optional(),
      layout: z.enum(["row", "grid", "packed"]).optional().describe("default row"),
      padding: z.number().int().min(0).max(64).optional(),
      extrude: z.number().int().min(0).max(32).optional(),
      columns: z.number().int().min(1).optional().describe("grid layout only"),
      name: z.string().optional(),
    },
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const result = exportSpritesheet(project, doc, args);
      return {
        data: {
          ...writeExport(project, result),
          size: result.metadata.size,
          frames: result.metadata.frames.length,
          tags: result.metadata.tags,
          hasGlow: Boolean(result.metadata.glow),
        },
      };
    },
  });

  register({
    name: "validate_document",
    title: "Validate document",
    description:
      "Run the export checks: palette range and partial alpha (errors), canvas multiple of 8, orphan pixels, frame durations and tag gaps, " +
      "tile seams, corner15 completeness and edge matching (error), rig overlaps, icon safe area. Errors block export.",
    input: { docId: zDocId },
    readOnly: true,
    handler: (args) => {
      const report = validateDocument(project, project.getDoc(args.docId));
      return { data: { ok: report.errors.length === 0, ...report } };
    },
  });
}
