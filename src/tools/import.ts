import { z } from "zod";
import { DOC_KINDS } from "../types.js";
import { importAseprite } from "../import/ase-import.js";
import { inspectFile } from "../import/inspect.js";
import { importPng } from "../import/png-import.js";
import type { ImportOutcome } from "../import/png-import.js";
import { exportToSource } from "../import/source-export.js";
import type { Project } from "../project.js";
import { ToolError } from "../util/errors.js";
import { zDocId } from "./helpers.js";
import type { Register, ToolOutput } from "./helpers.js";

const zXY = z.union([z.number().int().min(0), z.object({ x: z.number().int().min(0), y: z.number().int().min(0) })]);

const importOptions = {
  path: z.string().describe("File path, relative to the project root (must be inside the project or importRoots)"),
  name: z.string().optional().describe("Document name (default: file name / metadata name)"),
  kind: z.enum(DOC_KINDS).optional(),
  paletteId: z.string().optional().describe("Palette to map into (default: the project palette)"),
  colorMode: z.enum(["exact", "nearest", "extract"]).optional().describe("exact (default): fail on any off-palette color; nearest: snap (OKLab) and report; extract: build a new palette"),
  alphaThreshold: z.number().int().min(0).max(255).optional().describe("Alpha below this → transparent, at/above → opaque (default 128)"),
  scale: z.union([z.literal("auto"), z.number().int().min(1)]).optional().describe("Integer upscale factor to undo; \"auto\" (default) detects it"),
};

function outcome(o: ImportOutcome): ToolOutput {
  if (!o.ok) throw new ToolError(o.message ?? "Import failed", o.report);
  return { data: o.report };
}

export function registerImportTools(register: Register, project: Project): void {
  register({
    name: "inspect_file",
    title: "Inspect file",
    description:
      "Report what a PNG or .aseprite file contains without importing it: size, color mode, embedded palette, unique colors, partial alpha, detected " +
      "upscale, layers / frames / tags / slices (Aseprite), whether pixel-art-mcp metadata (sidecar JSON or tEXt) is present, and an auto-slicing guess. " +
      "Use it to plan an import.",
    input: { path: z.string() },
    readOnly: true,
    handler: (args) => ({ data: inspectFile(project, args.path) }),
  });

  register({
    name: "import_png",
    title: "Import PNG",
    description:
      "Open a PNG as a document (the file is never modified). slicing: \"metadata\" (default when pixel-art-mcp metadata exists — lossless: frames, " +
      "durations, tags, pivots, trims, masks, rigs; extrusion is discarded) | \"none\" (one frame) | {frameWidth, frameHeight, margin?, spacing?, count?} " +
      "in source-image pixels | {asepriteJson: path} for Aseprite sheet JSON | \"auto\" (detect a grid from transparent gutters; refuses and returns a " +
      "proposal when ambiguous). Exact color mode fails with every off-palette color listed and imports nothing.",
    input: {
      ...importOptions,
      slicing: z
        .union([
          z.enum(["none", "metadata", "auto"]),
          z.object({ asepriteJson: z.string() }),
          z.object({ frameWidth: z.number().int().min(1), frameHeight: z.number().int().min(1), margin: zXY.optional(), spacing: zXY.optional(), count: z.number().int().min(1).optional() }),
        ])
        .optional(),
    },
    handler: (args) => outcome(importPng(project, args.path, args)),
  });

  register({
    name: "import_aseprite",
    title: "Import Aseprite",
    description:
      "Open an .aseprite/.ase file as a document, preserving layers (and visibility), frames, durations, tags (forward/reverse/ping-pong) and slices " +
      "(a slice pivot becomes the frame pivot; slices named like rig parts are reported as candidates). Linked cels become copies; tilemap layers are " +
      "rendered to pixels. Indexed files keep their palette mapping (transparent index remapped to 0). Non-normal blend modes and opacity are " +
      "flattened with a warning, except addition/lighten → additive. layerGroups: \"flatten-names\" (default; \"arm/upper\") or \"merge\".",
    input: {
      ...importOptions,
      layerGroups: z.enum(["flatten-names", "merge"]).optional(),
      includeHidden: z.boolean().optional().describe("Keep hidden layers (as hidden layers). Default true."),
    },
    handler: (args) => outcome(importAseprite(project, args.path, args)),
  });

  register({
    name: "export_to_source",
    title: "Export to source",
    description:
      "Re-export an imported document to its original location: PNG sources are overwritten in place with the original layout and metadata " +
      "regenerated; .aseprite sources get <name>.png + metadata next to them (writing .aseprite is out of scope). Refuses if the source changed since " +
      "import, unless force: true.",
    input: { docId: zDocId, force: z.boolean().optional() },
    handler: (args) => ({ data: exportToSource(project, project.getDoc(args.docId), args.force ?? false) }),
  });
}
