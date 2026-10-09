import { z } from "zod";
import { ANCHORS, cloneDocument, createDocument, getTagRanges, resizeCanvas } from "../document.js";
import type { Project } from "../project.js";
import { maskBounds, maskCount } from "../selection.js";
import type { Document, DocKind, ProjectSettings } from "../types.js";
import { DOC_KINDS } from "../types.js";
import { isWrapEnabled } from "../raster.js";
import { setupDocumentKind } from "../kinds.js";
import { docPreview, framePreview, zDocId, zPreview } from "./helpers.js";
import type { Register } from "./helpers.js";

export function sizeWarnings(width: number, height: number): string[] {
  return width % 8 === 0 && height % 8 === 0 ? [] : [`Canvas ${width}x${height} is not a multiple of 8.`];
}

export function describeDocument(project: Project, doc: Document): Record<string, unknown> {
  const sel = project.getSelection(doc);
  const info: Record<string, unknown> = {
    id: doc.id,
    name: doc.name,
    kind: doc.kind,
    width: doc.width,
    height: doc.height,
    paletteId: doc.paletteId,
    layers: doc.layers.map((l, i) => ({ index: i, ...l })),
    frames: doc.frames.map((f, i) => ({ index: i, ...f })),
    tags: getTagRanges(doc),
    wrap: isWrapEnabled(doc),
  };
  if (doc.symmetry && doc.symmetry.mode !== "none") info.symmetry = doc.symmetry;
  if (sel) info.selection = { bounds: maskBounds(sel, doc.width, doc.height), pixels: maskCount(sel) };
  if (doc.rig) info.rig = doc.rig;
  if (doc.tileset) info.tileset = doc.tileset;
  if (doc.icon) info.icon = doc.icon;
  if (doc.source) info.source = { ...doc.source, path: project.displayPath(doc.source.path) };
  return info;
}

export function registerProjectTools(register: Register, project: Project): void {
  register({
    name: "configure_project",
    title: "Configure project",
    description:
      "Set project settings (all optional): pixelsPerUnit (16), outputDir (\"./assets\", relative to the project root), defaultPaletteId, " +
      "atlasPadding (2), atlasExtrude (1), metadataMode (\"sidecar\" | \"embedded\" | \"both\"), " +
      "importRoots (extra directories assets may be read from), characterExport (\"atlas\" | \"parts\"). Returns the full settings.",
    input: {
      pixelsPerUnit: z.number().positive().optional(),
      outputDir: z.string().min(1).optional(),
      defaultPaletteId: z.string().optional(),
      atlasPadding: z.number().int().min(0).max(64).optional(),
      atlasExtrude: z.number().int().min(0).max(32).optional(),
      metadataMode: z.enum(["sidecar", "embedded", "both"]).optional(),
      importRoots: z.array(z.string()).optional(),
      characterExport: z.enum(["atlas", "parts"]).optional(),
    },
    handler: (args) => {
      if (args.defaultPaletteId !== undefined) project.getPalette(args.defaultPaletteId);
      const next: ProjectSettings = { ...project.settings };
      for (const [k, v] of Object.entries(args)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
      project.settings = next;
      return { data: { settings: project.settings, root: project.root, outputDir: project.displayPath(project.outputDir) } };
    },
  });

  register({
    name: "create_document",
    title: "Create document",
    description:
      "Create a document with one layer and one frame. kind: sprite | character | tileset | effect | icon. Uses the default palette unless paletteId is given. " +
      "Character documents get one layer per part and one frame per direction (parts/directions optional). Warns if the size is not a multiple of 8.",
    input: {
      name: z.string().min(1),
      kind: z.enum(DOC_KINDS),
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(4096),
      paletteId: z.string().optional(),
      parts: z.array(z.string()).optional().describe("character only: part layer names (default head, body, hand_l, hand_r, foot_l, foot_r)"),
      directions: z.array(z.string()).optional().describe("character only: directions (default down, up, left, right)"),
    },
    handler: (args) => {
      const doc = createDocument({
        id: project.newDocId(),
        name: args.name,
        kind: args.kind as DocKind,
        width: args.width,
        height: args.height,
        paletteId: project.resolvePaletteId(args.paletteId),
      });
      const notes = setupDocumentKind(doc, { parts: args.parts, directions: args.directions });
      project.addDoc(doc);
      return {
        data: {
          docId: doc.id,
          name: doc.name,
          kind: doc.kind,
          width: doc.width,
          height: doc.height,
          paletteId: doc.paletteId,
          layers: doc.layers.map((l) => l.id),
          frames: doc.frames.length,
          notes,
          warnings: sizeWarnings(args.width, args.height),
        },
      };
    },
  });

  register({
    name: "list_documents",
    title: "List documents",
    description: "Ids, names, kinds and sizes of all open documents.",
    input: {},
    readOnly: true,
    handler: () => ({
      data: {
        documents: [...project.docs.values()].map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          width: d.width,
          height: d.height,
          layers: d.layers.length,
          frames: d.frames.length,
          paletteId: d.paletteId,
        })),
      },
    }),
  });

  register({
    name: "get_document_info",
    title: "Get document info",
    description: "Layers, frames (durations, tags, labels, pivots), tags, rig / tileset / icon config, symmetry, wrap mode, selection and import source of a document.",
    input: { docId: zDocId },
    readOnly: true,
    handler: (args) => ({ data: describeDocument(project, project.getDoc(args.docId)) }),
  });

  register({
    name: "duplicate_document",
    title: "Duplicate document",
    description: "Deep copy of a document under a new name.",
    input: { docId: zDocId, newName: z.string().min(1) },
    handler: (args) => {
      const copy = cloneDocument(project.getDoc(args.docId));
      copy.id = project.newDocId();
      copy.name = args.newName;
      delete copy.source;
      project.addDoc(copy);
      return { data: { docId: copy.id, name: copy.name } };
    },
  });

  register({
    name: "delete_document",
    title: "Delete document",
    description: "Close a document (removes it from memory and from the next save_project).",
    input: { docId: zDocId },
    destructive: true,
    handler: (args) => {
      project.removeDoc(args.docId);
      return { data: { deleted: args.docId } };
    },
  });

  register({
    name: "resize_canvas",
    title: "Resize canvas",
    description: `Resize the canvas of all layers and frames. anchor: ${ANCHORS.join(", ")}. Pivots and rig points move with the content.`,
    input: {
      docId: zDocId,
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(4096),
      anchor: z.enum(ANCHORS).optional().describe("default \"center\""),
      preview: zPreview,
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const offset = resizeCanvas(doc, args.width, args.height, args.anchor ?? "center");
      project.selections.delete(doc.id);
      const data = { width: doc.width, height: doc.height, contentOffset: offset, warnings: sizeWarnings(doc.width, doc.height) };
      return args.preview ? { data, images: [framePreview(project, doc, 0)] } : { data };
    },
  });

  register({
    name: "undo",
    title: "Undo",
    description: "Undo the last change to a document (up to 30 steps per document).",
    input: { docId: zDocId, preview: zPreview },
    handler: (args) => {
      const remaining = project.undo(args.docId);
      const data = { undone: true, remainingUndoSteps: remaining };
      return args.preview ? { data, images: [docPreview(project, project.getDoc(args.docId))] } : { data };
    },
  });

  register({
    name: "save_project",
    title: "Save project",
    description: "Persist settings, palettes and all documents to outputDir/.pixelmcp/project.json (native JSON format).",
    input: {},
    handler: () => {
      const file = project.save();
      return { data: { saved: project.displayPath(file), documents: project.docs.size, palettes: project.palettes.size } };
    },
  });

  register({
    name: "load_project",
    title: "Load project",
    description: "Load a saved project from outputDir/.pixelmcp/ (or from `dir`), replacing the documents and palettes in memory.",
    input: { dir: z.string().optional().describe("Output directory (or its .pixelmcp folder) to load from; default: current outputDir") },
    destructive: true,
    handler: (args) => {
      const file = project.load(args.dir);
      return {
        data: {
          loaded: project.displayPath(file),
          documents: [...project.docs.values()].map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
          palettes: [...project.palettes.keys()],
          settings: project.settings,
        },
      };
    },
  });
}
