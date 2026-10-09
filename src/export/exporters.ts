import path from "node:path";
import { compositeIndexed, exportLayers, framePivot, getTagRanges, hasContent } from "../document.js";
import { paletteRgb } from "../palette.js";
import { encodeIndexedPng } from "../png.js";
import type { Project } from "../project.js";
import { contentBounds } from "../selection.js";
import type { Document, Point, SheetLayout } from "../types.js";
import { fail } from "../util/errors.js";
import { asciiJson, sanitizeAssetName } from "../util/ids.js";
import { formatIssues, validateDocument } from "../validate.js";
import { buildAtlas, checkPaddingExtrude, crop, layoutGrid, layoutPacked, layoutRow } from "./layout.js";
import type { AtlasLayout } from "./layout.js";
import { METADATA_KEYWORD, METADATA_VERSION, frameMeta } from "./metadata.js";
import type { AssetMetadata, ExportFrame, LayoutMeta, TagMeta } from "./metadata.js";

export interface ExportFile {
  path: string;
  data: Buffer;
}

export interface ExportResult {
  /** Asset name relative to the output directory (no extension). */
  name: string;
  files: ExportFile[];
  metadata: AssetMetadata;
  warnings: string[];
}

/** Where an export is written: a directory and a base file name (no extension). */
export interface ExportTarget {
  dir: string;
  base: string;
  /** Name recorded in metadata (and used for frame names). */
  assetName: string;
}

export function defaultTarget(project: Project, doc: Document, name?: string): ExportTarget {
  const assetName = sanitizeAssetName(name ?? doc.source?.assetName ?? doc.name);
  const abs = project.outputPath(assetName);
  return { dir: path.dirname(abs), base: path.basename(abs), assetName };
}

/** Runs validation; errors block the export, warnings are returned. */
export function validateForExport(project: Project, doc: Document): string[] {
  const report = validateDocument(project, doc);
  if (report.errors.length) {
    fail(`Export blocked by validation errors:\n${formatIssues(report)}`, report);
  }
  return report.warnings.map((w) => `[${w.check}] ${w.message}`);
}

export function hasGlowLayers(doc: Document): boolean {
  return doc.layers.some(exportLayers("additive"));
}

/** Flattened frame images (normal layers, plus additive layers as glow). */
export function collectFrames(doc: Document, frames: number[], baseName: string): ExportFrame[] {
  const glow = hasGlowLayers(doc);
  return frames.map((f, k) => ({
    name: `${baseName}_${k}`,
    pixels: compositeIndexed(doc, f, exportLayers("normal")),
    glow: glow ? compositeIndexed(doc, f, exportLayers("additive")) : undefined,
    w: doc.width,
    h: doc.height,
    durationMs: doc.frames[f]!.durationMs,
    pivot: framePivot(doc, f),
  }));
}

/** Trims a frame to the bounding box of its pixels (main ∪ glow); empty frames become 1×1. */
export function trimFrame(f: ExportFrame): ExportFrame {
  const union = new Uint8Array(f.w * f.h);
  for (let i = 0; i < union.length; i++) union[i] = f.pixels[i]! | (f.glow?.[i] ?? 0);
  const b = contentBounds(union, f.w, f.h) ?? { x: 0, y: 0, w: 1, h: 1 };
  const base = f.offset ?? { x: 0, y: 0 };
  return {
    ...f,
    pixels: crop(f.pixels, f.w, b),
    glow: f.glow ? crop(f.glow, f.w, b) : undefined,
    w: b.w,
    h: b.h,
    pivot: { x: f.pivot.x - b.x, y: f.pivot.y - b.y },
    offset: { x: base.x + b.x, y: base.y + b.y },
  };
}

/** Tag ranges re-indexed to the exported frame list. */
export function tagsFor(doc: Document, frames: number[]): TagMeta[] {
  const pos = new Map(frames.map((f, k) => [f, k]));
  const tags: TagMeta[] = [];
  for (const r of getTagRanges(doc)) {
    const from = pos.get(r.from);
    const to = pos.get(r.to);
    if (from === undefined || to === undefined || to - from !== r.to - r.from) continue;
    tags.push({ name: r.name, from, to, direction: r.direction });
  }
  return tags;
}

export function computeLayout(frames: ExportFrame[], layout: SheetLayout | "fixedGrid", padding: number, columns?: number): AtlasLayout {
  const sizes = frames.map((f) => ({ w: f.w, h: f.h }));
  if (layout === "row") return layoutRow(sizes, padding);
  if (layout === "packed") return layoutPacked(sizes, padding);
  return layoutGrid(sizes, padding, columns);
}

export interface AssembleOptions {
  project: Project;
  doc: Document;
  target: ExportTarget;
  frames: ExportFrame[];
  layout: AtlasLayout;
  extrude: number;
  layoutMeta: LayoutMeta;
  tags: TagMeta[];
  extra?: Partial<AssetMetadata>;
  warnings: string[];
}

/** Builds the atlas PNG(s), metadata and sidecar for a set of placed frames. */
export function assembleExport(o: AssembleOptions): ExportResult {
  const { project, doc, target, frames, layout } = o;
  const glow = frames.some((f) => f.glow && hasContent(f.glow));
  const metadata: AssetMetadata = {
    version: METADATA_VERSION,
    name: target.assetName,
    kind: doc.kind,
    image: `${target.base}.png`,
    ...(glow ? { glow: `${target.base}_glow.png` } : {}),
    size: { w: layout.width, h: layout.height },
    sourceSize: { w: doc.width, h: doc.height },
    pixelsPerUnit: project.settings.pixelsPerUnit,
    paletteId: doc.paletteId,
    layout: o.layoutMeta,
    frames: frames.map((f, i) => frameMeta(f, layout.positions[i]!, layout.width, layout.height)),
    tags: o.tags,
    ...o.extra,
  };
  const palette = paletteRgb(project.paletteFor(doc));
  const mode = project.settings.metadataMode;
  const embed = mode === "embedded" || mode === "both";
  const files: ExportFile[] = [];
  const atlas = buildAtlas(frames, layout, o.extrude);
  files.push({
    path: path.join(target.dir, `${target.base}.png`),
    data: encodeIndexedPng({
      width: layout.width,
      height: layout.height,
      indices: atlas,
      palette,
      texts: embed ? [{ keyword: METADATA_KEYWORD, text: asciiJson(metadata) }] : [],
    }),
  });
  if (glow) {
    const glowFrames = frames.map((f) => ({ pixels: f.glow ?? new Uint8Array(f.w * f.h), w: f.w, h: f.h }));
    files.push({
      path: path.join(target.dir, `${target.base}_glow.png`),
      data: encodeIndexedPng({ width: layout.width, height: layout.height, indices: buildAtlas(glowFrames, layout, o.extrude), palette }),
    });
  }
  if (mode === "sidecar" || mode === "both") {
    files.push({ path: path.join(target.dir, `${target.base}.json`), data: Buffer.from(asciiJson(metadata, 2) + "\n") });
  }
  return { name: target.assetName, files, metadata, warnings: o.warnings };
}

export function exportSinglePng(project: Project, doc: Document, opts: { frame?: number; name?: string; target?: ExportTarget }): ExportResult {
  const warnings = validateForExport(project, doc);
  const frame = opts.frame ?? 0;
  if (frame < 0 || frame >= doc.frames.length) fail(`Frame ${frame} does not exist (frames 0–${doc.frames.length - 1}).`);
  const target = opts.target ?? defaultTarget(project, doc, opts.name);
  const base = target.assetName.split("/").pop()!;
  const frames = collectFrames(doc, [frame], base);
  const layout: AtlasLayout = { width: doc.width, height: doc.height, positions: [{ x: 0, y: 0 }] };
  return assembleExport({ project, doc, target, frames, layout, extrude: 0, layoutMeta: { type: "png" }, tags: [], warnings });
}

export interface SpritesheetOptions {
  tag?: string;
  layout?: SheetLayout;
  padding?: number;
  extrude?: number;
  columns?: number;
  name?: string;
  target?: ExportTarget;
}

export function exportSpritesheet(project: Project, doc: Document, opts: SpritesheetOptions): ExportResult {
  const warnings = validateForExport(project, doc);
  // An imported sheet re-exports with its original layout unless overridden.
  const cfg = doc.source?.exportConfig?.type === "spritesheet" ? doc.source.exportConfig : undefined;
  if (cfg) opts = { layout: cfg.layout, padding: cfg.padding, extrude: cfg.extrude, columns: cfg.columns, tag: cfg.tag, ...stripUndefined(opts) };
  const padding = opts.padding ?? project.settings.atlasPadding;
  const extrude = opts.extrude ?? project.settings.atlasExtrude;
  checkPaddingExtrude(padding, extrude);
  const layoutType = opts.layout ?? "row";
  let frameIdx = doc.frames.map((_, i) => i);
  if (opts.tag !== undefined) {
    frameIdx = frameIdx.filter((i) => doc.frames[i]!.tag === opts.tag);
    if (!frameIdx.length) fail(`No frames tagged "${opts.tag}".`);
  }
  const target = opts.target ?? defaultTarget(project, doc, opts.name);
  const base = target.assetName.split("/").pop()!;
  let frames = collectFrames(doc, frameIdx, base);
  if (layoutType === "packed") frames = frames.map(trimFrame);
  const layout = computeLayout(frames, layoutType, padding, opts.columns);
  const layoutMeta: LayoutMeta = { type: "spritesheet", layout: layoutType, padding, extrude };
  if (opts.columns !== undefined && layoutType === "grid") layoutMeta.columns = opts.columns;
  if (opts.tag !== undefined) layoutMeta.tag = opts.tag;
  return assembleExport({ project, doc, target, frames, layout, extrude, layoutMeta, tags: tagsFor(doc, frameIdx), warnings });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Pixel-duplicating upscale of an export (export_to_source for sources imported at scale N). */
export function scaleExportFrames(frames: ExportFrame[], n: number): ExportFrame[] {
  if (n === 1) return frames;
  const up = (src: Uint8Array, w: number, h: number) => {
    const out = new Uint8Array(w * n * h * n);
    for (let y = 0; y < h * n; y++) for (let x = 0; x < w * n; x++) out[y * w * n + x] = src[Math.floor(y / n) * w + Math.floor(x / n)]!;
    return out;
  };
  return frames.map((f) => ({
    ...f,
    pixels: up(f.pixels, f.w, f.h),
    glow: f.glow ? up(f.glow, f.w, f.h) : undefined,
    w: f.w * n,
    h: f.h * n,
    pivot: { x: f.pivot.x * n, y: f.pivot.y * n },
    offset: f.offset ? { x: f.offset.x * n, y: f.offset.y * n } : undefined,
  }));
}

export function scalePoint(p: Point, n: number): Point {
  return { x: p.x * n, y: p.y * n };
}
