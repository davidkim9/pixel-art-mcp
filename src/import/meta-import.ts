/**
 * Rebuilds a document from pixel-art-mcp metadata (lossless re-import):
 * frames, durations, tags, pivots, trims, tileset masks, icon names and
 * character rigs. Extruded edge pixels are outside the rects and ignored.
 */
import { addIconGuide } from "../icons.js";
import { addLayer, createDocument, ensureCel, tagFrames } from "../document.js";
import type { AssetMetadata, FrameMeta } from "../export/metadata.js";
import type { Project } from "../project.js";
import { blobFrameLabel } from "../tileset/blob47.js";
import { frameLabel } from "../tileset/corner15.js";
import { addTransitionGuide } from "../tileset/sets.js";
import type { DocKind, Document, ExportConfig, Frame, Pose, RigPart, TagDirection, TilesetTemplate } from "../types.js";
import { DOC_KINDS } from "../types.js";
import { fail } from "../util/errors.js";

export interface IndexImage {
  w: number;
  h: number;
  data: Uint8Array;
}

function blit(dst: Uint8Array, dw: number, dh: number, src: IndexImage, rect: { x: number; y: number; w: number; h: number }, ox: number, oy: number): void {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > src.w || rect.y + rect.h > src.h) {
    fail(`Metadata rect ${JSON.stringify(rect)} lies outside the ${src.w}x${src.h} image (was the image scaled or cropped?).`);
  }
  for (let y = 0; y < rect.h; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= dh) continue;
    for (let x = 0; x < rect.w; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= dw) continue;
      const v = src.data[(rect.y + y) * src.w + rect.x + x]!;
      if (v !== 0) dst[ty * dw + tx] = v;
    }
  }
}

export interface MetaImportResult {
  doc: Document;
  exportConfig: ExportConfig;
}

export function documentFromMetadata(
  project: Project,
  meta: AssetMetadata,
  main: IndexImage,
  glow: IndexImage | undefined,
  opts: { id: string; name: string; paletteId: string; kind?: DocKind },
): MetaImportResult {
  const kind = opts.kind ?? (DOC_KINDS.includes(meta.kind) ? meta.kind : "sprite");
  const layout = meta.layout ?? { type: meta.frames.length === 1 ? "png" : "spritesheet", layout: "row", padding: 0, extrude: 0 };
  if (layout.type === "character" && layout.mode === "parts") {
    fail("Character \"parts\" exports are separate images; import the atlas export instead (export_character mode \"atlas\").");
  }
  const canvas = meta.sourceSize ?? { w: meta.frames[0]?.rect.w ?? main.w, h: meta.frames[0]?.rect.h ?? main.h };
  const doc = createDocument({ id: opts.id, name: opts.name, kind, width: canvas.w, height: canvas.h, paletteId: opts.paletteId });

  if (layout.type === "character") return characterFromMetadata(project, doc, meta, main);

  const mainLayer = layout.type === "tileset" ? "tiles" : layout.type === "icons" ? "icon" : "layer_1";
  doc.layers = [];
  addLayer(doc, mainLayer === "layer_1" ? "Layer 1" : mainLayer, { id: mainLayer });
  if (glow) addLayer(doc, "glow", { id: "glow", blend: "additive" });
  doc.frames = meta.frames.map((f: FrameMeta): Frame => {
    const off = f.offsetPx ?? { x: 0, y: 0 };
    return { durationMs: f.durationMs, pivot: { x: f.pivotPx.x + off.x, y: f.pivotPx.y + off.y } };
  });
  meta.frames.forEach((f, i) => {
    const off = f.offsetPx ?? { x: 0, y: 0 };
    blit(ensureCel(doc, mainLayer, i), doc.width, doc.height, main, f.rect, off.x, off.y);
    if (glow) blit(ensureCel(doc, "glow", i), doc.width, doc.height, glow, f.rect, off.x, off.y);
  });
  for (const t of meta.tags ?? []) {
    if (t.from >= 0 && t.to < doc.frames.length && t.from <= t.to) tagFrames(doc, t.name, t.from, t.to, t.direction as TagDirection);
  }

  let exportConfig: ExportConfig;
  if (layout.type === "png") exportConfig = { type: "png" };
  else if (layout.type === "spritesheet") {
    exportConfig = { type: "spritesheet", layout: layout.layout, padding: layout.padding, extrude: layout.extrude };
    if (layout.columns !== undefined) exportConfig.columns = layout.columns;
    if (layout.tag !== undefined) exportConfig.tag = layout.tag;
  } else if (layout.type === "tileset") {
    exportConfig = { type: "tileset", columns: layout.columns, padding: layout.padding, extrude: layout.extrude };
    const ts = meta.tileset ?? {};
    const template = ts.template as TilesetTemplate | undefined;
    doc.tileset = { tileSize: doc.width, wrapDrawing: false };
    if (template) {
      doc.tileset.template = template;
      if (ts.terrains) doc.tileset.terrains = ts.terrains as { lower: string; upper: string };
      doc.tileset.overlay = Boolean(ts.overlay);
      meta.frames.forEach((f, i) => {
        const mask = typeof f.mask === "number" ? f.mask : i;
        doc.frames[i]!.label = template === "corner15" ? frameLabel(mask) : blobFrameLabel(mask);
      });
      addTransitionGuide(project, doc);
    }
  } else if (layout.type === "source") {
    exportConfig = {
      type: "rects",
      width: meta.size.w,
      height: meta.size.h,
      rects: meta.frames.map((f) => ({ ...f.rect, offsetX: f.offsetPx?.x ?? 0, offsetY: f.offsetPx?.y ?? 0 })),
    };
  } else if (layout.type === "icons") {
    exportConfig = { type: "icons", columns: layout.columns, padding: layout.padding, extrude: layout.extrude };
    doc.icon = { size: meta.icon?.size ?? doc.width, margin: meta.icon?.margin ?? 1 };
    meta.frames.forEach((f, i) => (doc.frames[i]!.label = f.name));
    addIconGuide(project, doc);
  } else {
    fail(`Unknown metadata layout "${(layout as { type: string }).type}".`);
  }
  return { doc, exportConfig };
}

function characterFromMetadata(project: Project, doc: Document, meta: AssetMetadata, main: IndexImage): MetaImportResult {
  void project;
  const c = (meta.character ?? {}) as {
    originPx?: { x: number; y: number };
    layers?: Array<{ id: string; name: string }>;
    parts?: RigPart[];
    directions?: string[];
    mirrors?: Record<string, string>;
    drawOrder?: Record<string, string[]>;
    poses?: Pose[];
  };
  const directions = c.directions ?? [];
  if (!directions.length) fail("Character metadata has no directions.");
  doc.layers = [];
  for (const l of c.layers ?? []) addLayer(doc, l.name, { id: l.id });
  for (const f of meta.frames) {
    const part = String(f.part ?? "");
    if (part && !doc.layers.some((l) => l.id === part)) addLayer(doc, part, { id: part });
  }
  doc.frames = directions.map((d) => {
    const any = meta.frames.find((f) => f.direction === d);
    const frame: Frame = { durationMs: any?.durationMs ?? 100, label: d };
    if (c.originPx) frame.pivot = { ...c.originPx };
    return frame;
  });
  for (const f of meta.frames) {
    const fi = directions.indexOf(String(f.direction));
    if (fi < 0) fail(`Frame "${f.name}" has unknown direction "${String(f.direction)}".`);
    const off = f.offsetPx ?? { x: 0, y: 0 };
    blit(ensureCel(doc, String(f.part), fi), doc.width, doc.height, main, f.rect, off.x, off.y);
  }
  doc.rig = {
    parts: structuredClone(c.parts ?? []),
    directions: [...directions],
    drawOrder: structuredClone(c.drawOrder ?? {}),
    poses: structuredClone(c.poses ?? []),
  };
  if (c.mirrors) doc.rig.mirrors = { ...c.mirrors };
  const layout = meta.layout as { padding?: number; extrude?: number };
  return { doc, exportConfig: { type: "character", mode: "atlas", padding: layout.padding, extrude: layout.extrude } };
}
