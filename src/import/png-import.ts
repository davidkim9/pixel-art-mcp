import fs from "node:fs";
import path from "node:path";
import { toHex } from "../color.js";
import { createDocument, ensureCel, tagFrames } from "../document.js";
import { isAssetMetadata } from "../export/manifest.js";
import { METADATA_KEYWORD } from "../export/metadata.js";
import type { AssetMetadata } from "../export/metadata.js";
import { createPalette } from "../palette.js";
import { decodePng } from "../png.js";
import type { DecodedPng } from "../png.js";
import type { Project } from "../project.js";
import type { DocKind, Document, ExportConfig, Palette, TagDirection } from "../types.js";
import { fail } from "../util/errors.js";
import { sha256, slugify, uniqueId } from "../util/ids.js";
import { ColorMapper } from "./colormap.js";
import type { ColorMappingReport, ColorMode } from "./colormap.js";
import { documentFromMetadata } from "./meta-import.js";
import type { IndexImage } from "./meta-import.js";
import { detectScale, downsample, rgbaComparator } from "./scale.js";
import { detectGrid, gridRects, parseAsepriteJson } from "./slicing.js";
import type { GridDetection, GridSpec, SliceRect, XY } from "./slicing.js";

export interface ImportOptions {
  name?: string;
  kind?: DocKind;
  paletteId?: string;
  colorMode?: ColorMode;
  alphaThreshold?: number;
  scale?: "auto" | number;
}

export type Slicing = "none" | "metadata" | "auto" | { asepriteJson: string } | GridSpec;

export interface PngImportOptions extends ImportOptions {
  slicing?: Slicing;
}

export interface ImportReport {
  docId: string | null;
  source: { path: string; format: "png" | "aseprite" };
  size: { w: number; h: number };
  detectedScale: number;
  frames: number;
  layers: string[];
  tags: string[];
  colorMapping: ColorMappingReport;
  alphaThresholded: number;
  warnings: string[];
  [extra: string]: unknown;
}

export interface ImportOutcome {
  ok: boolean;
  report: ImportReport;
  doc?: Document;
  message?: string;
}

/** MCP metadata for a PNG: sidecar JSON next to it, else the embedded tEXt chunk. */
export function findMetadata(file: string, png: { texts: Array<{ keyword: string; text: string }> }): { meta?: AssetMetadata; where?: "sidecar" | "embedded"; sidecar?: string } {
  const sidecar = file.replace(/\.png$/i, ".json");
  if (sidecar !== file && fs.existsSync(sidecar)) {
    try {
      const meta = JSON.parse(fs.readFileSync(sidecar, "utf8")) as unknown;
      if (isAssetMetadata(meta) && (meta.image === undefined || meta.image === path.basename(file))) return { meta, where: "sidecar", sidecar };
    } catch {
      // not ours
    }
  }
  const text = png.texts.find((t) => t.keyword === METADATA_KEYWORD);
  if (text) {
    try {
      const meta = JSON.parse(text.text) as unknown;
      if (isAssetMetadata(meta)) return { meta, where: "embedded" };
    } catch {
      // ignore
    }
  }
  return {};
}

/** True if every used, opaque PNG palette entry has the same color at the same index in `palette`. */
function directIndicesCompatible(png: DecodedPng, palette: Palette, alphaThreshold: number): boolean {
  if (!png.indices || !png.palette) return false;
  const used = new Set<number>();
  for (let i = 0; i < png.indices.length; i++) used.add(png.indices[i]!);
  for (const idx of used) {
    const e = png.palette[idx]!;
    if (e.a < alphaThreshold) continue;
    if (idx === 0 || idx >= palette.colors.length) return false;
    if (palette.colors[idx] !== toHex(e)) return false;
  }
  return true;
}

export interface MappedImage {
  image?: IndexImage;
  scale: number;
  mapping: ColorMappingReport;
  alphaThresholded: number;
  failed: boolean;
  direct: boolean;
  extractedPalette?: string[];
}

/** Threshold + scale detection + color mapping of a decoded PNG. */
export function mapPng(png: DecodedPng, opts: { palette?: Palette; mode: ColorMode; alphaThreshold: number; scale: "auto" | number }): MappedImage {
  const { width: W, height: H } = png;
  const direct = opts.mode !== "extract" && opts.palette !== undefined && directIndicesCompatible(png, opts.palette, opts.alphaThreshold);
  let scale = 1;
  if (opts.scale === "auto") scale = detectScale(W, H, rgbaComparator(png.rgba, opts.alphaThreshold));
  else scale = opts.scale;
  if (!Number.isInteger(scale) || scale < 1 || W % scale !== 0 || H % scale !== 0) fail(`Scale ${scale} doesn't divide the ${W}x${H} image.`);
  const w = W / scale;
  const h = H / scale;
  const rgba = downsample(png.rgba, W, H, scale, 4);
  let partial = 0;
  for (let i = 3; i < png.rgba.length; i += 4) if (png.rgba[i]! > 0 && png.rgba[i]! < 255) partial++;
  if (direct) {
    const idx = downsample(png.indices!, W, H, scale, 1);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = png.palette![idx[i]!]!.a < opts.alphaThreshold ? 0 : idx[i]!;
    return { image: { w, h, data: out }, scale, mapping: { mode: opts.mode, offPalette: [], substitutions: [] }, alphaThresholded: partial, failed: false, direct: true };
  }
  const mapper = new ColorMapper({ mode: opts.mode, palette: opts.palette, alphaThreshold: opts.alphaThreshold, coordScale: scale });
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[y * w + x] = mapper.map(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!, rgba[o + 3]!, x, y);
    }
  }
  return {
    image: mapper.failed ? undefined : { w, h, data: out },
    scale,
    mapping: mapper.report(),
    alphaThresholded: partial,
    failed: mapper.failed,
    direct: false,
    extractedPalette: opts.mode === "extract" ? mapper.extractedColors() : undefined,
  };
}

function divideXY(v: XY | undefined, n: number, what: string): XY | undefined {
  if (v === undefined) return undefined;
  const d = (k: number) => {
    if (k % n !== 0) fail(`${what} ${k} isn't divisible by the detected scale ${n}; pass scale: 1 or adjust.`);
    return k / n;
  };
  return typeof v === "number" ? d(v) : { x: d(v.x), y: d(v.y) };
}

function baseName(file: string): string {
  return path.basename(file).replace(/\.[^.]+$/, "");
}

/** Resolves the palette to map into (may be undefined in extract mode). */
export function targetPalette(project: Project, opts: ImportOptions, preferred?: string): Palette | undefined {
  if (opts.paletteId) return project.getPalette(opts.paletteId);
  if (preferred && project.palettes.has(preferred)) return project.palettes.get(preferred);
  const id = project.settings.defaultPaletteId ?? (project.palettes.size === 1 ? [...project.palettes.keys()][0] : undefined);
  return id ? project.getPalette(id) : undefined;
}

export function registerExtractedPalette(project: Project, name: string, colors: string[]): Palette {
  const id = uniqueId(slugify(name, "palette"), (c) => project.palettes.has(c));
  const palette = createPalette(id, name, colors);
  project.palettes.set(id, palette);
  if (!project.settings.defaultPaletteId) project.settings.defaultPaletteId = id;
  return palette;
}

export function importPng(project: Project, filePath: string, opts: PngImportOptions): ImportOutcome {
  const file = project.resolveReadPath(filePath);
  if (!/\.png$/i.test(file)) fail(`${filePath} is not a .png file.`);
  const buf = fs.readFileSync(file);
  const png = decodePng(buf);
  const found = findMetadata(file, png);
  const slicing: Slicing = opts.slicing ?? (found.meta ? "metadata" : "none");
  if (slicing === "metadata" && !found.meta) fail("No pixel-art-mcp metadata found (sidecar JSON or embedded tEXt); choose another slicing mode.");
  const mode = opts.colorMode ?? "exact";
  const alphaThreshold = opts.alphaThreshold ?? 128;
  const warnings: string[] = [];
  const meta = slicing === "metadata" ? found.meta! : undefined;
  const palette = targetPalette(project, opts, meta?.paletteId);
  if (mode !== "extract" && !palette) fail("No palette to map into: load_palette first, pass paletteId, or use colorMode \"extract\".");
  let scaleOpt: "auto" | number = opts.scale ?? "auto";
  if ((meta || (typeof slicing === "object" && "asepriteJson" in slicing)) && scaleOpt === "auto") scaleOpt = 1;
  const mapped = mapPng(png, { palette, mode, alphaThreshold, scale: scaleOpt });
  const report: ImportReport = {
    docId: null,
    source: { path: project.displayPath(file), format: "png" },
    size: { w: png.width / mapped.scale, h: png.height / mapped.scale },
    detectedScale: mapped.scale,
    frames: 0,
    layers: [],
    tags: [],
    colorMapping: mapped.mapping,
    alphaThresholded: mapped.alphaThresholded,
    warnings,
  };
  if (found.meta) report.metadata = found.where;
  if (mapped.direct) report.paletteMapping = "PNG palette indices match the target palette; indices kept as-is";
  if (mapped.failed) {
    const message =
      mode === "extract"
        ? "The image has more than 255 colors; it can't be a palette (use colorMode \"nearest\")."
        : `${mapped.mapping.offPalette.length} color(s) are not in palette "${palette!.id}". Nothing was imported. Use colorMode "nearest" to snap them, "extract" to build a palette from the image, or fix the source.`;
    return { ok: false, report, message };
  }
  const image = mapped.image!;
  let paletteId = palette?.id;
  if (mode === "extract") {
    const p = registerExtractedPalette(project, opts.name ?? baseName(file), mapped.extractedPalette!);
    paletteId = p.id;
    report.paletteCreated = { id: p.id, colors: p.colors.length - 1 };
  }
  const id = project.newDocId();
  const name = opts.name ?? (meta?.name ? meta.name.split("/").pop()! : baseName(file));
  let doc: Document;
  let exportConfig: ExportConfig;

  if (meta) {
    let glow: IndexImage | undefined;
    if (meta.glow) {
      const glowFile = path.join(path.dirname(file), meta.glow);
      if (!fs.existsSync(glowFile)) warnings.push(`Glow image ${meta.glow} is missing; the glow layer was not imported.`);
      else {
        const g = mapPng(decodePng(fs.readFileSync(glowFile)), { palette: palette ?? project.getPalette(paletteId!), mode: mode === "extract" ? "nearest" : mode, alphaThreshold, scale: 1 });
        if (g.failed) return { ok: false, report: { ...report, glowColorMapping: g.mapping }, message: `The glow image ${meta.glow} has off-palette colors.` };
        glow = g.image;
      }
    }
    const r = documentFromMetadata(project, meta, image, glow, { id, name, paletteId: paletteId!, kind: opts.kind });
    doc = r.doc;
    exportConfig = r.exportConfig;
    report.slicing = { mode: "metadata", layout: meta.layout?.type };
  } else {
    if (slicing === "metadata") fail("No pixel-art-mcp metadata found.");
    const kind = opts.kind ?? "sprite";
    if (kind === "character") fail("A plain PNG has no rig; import it as a sprite (characters re-import from export_character metadata).");
    let rects: SliceRect[];
    let canvas = { w: image.w, h: image.h };
    let durations: number[] | undefined;
    let jsonTags: Array<{ name: string; from: number; to: number; direction: TagDirection }> = [];
    const pivots: Array<{ x: number; y: number } | undefined> = [];
    if (slicing === "none") {
      rects = [{ x: 0, y: 0, w: image.w, h: image.h, offsetX: 0, offsetY: 0 }];
      report.slicing = { mode: "none" };
    } else if (slicing === "auto") {
      const detection: GridDetection = detectGrid((x, y) => image.data[y * image.w + x] !== 0, image.w, image.h);
      const inSource = (spec: GridSpec): GridSpec => {
        const s = mapped.scale;
        const mul = (v: XY | undefined) => (v === undefined ? undefined : typeof v === "number" ? v * s : { x: v.x * s, y: v.y * s });
        return { frameWidth: spec.frameWidth * s, frameHeight: spec.frameHeight * s, ...(spec.margin !== undefined ? { margin: mul(spec.margin) } : {}), ...(spec.spacing !== undefined ? { spacing: mul(spec.spacing) } : {}) };
      };
      report.slicing = { mode: "auto", confident: detection.confident, proposal: inSource(detection.proposal), alternatives: detection.alternatives.map(inSource), reason: detection.reason };
      if (!detection.confident) {
        return { ok: false, report, message: `Auto slicing is not sure: ${detection.reason} Re-run with slicing {frameWidth, frameHeight, margin?, spacing?} (values in source-image pixels).` };
      }
      rects = dropTrailingEmpty(image, gridRects(image.w, image.h, detection.proposal), warnings);
    } else if ("asepriteJson" in slicing) {
      const jsonFile = project.resolveReadPath(slicing.asepriteJson);
      const sheet = parseAsepriteJson(fs.readFileSync(jsonFile, "utf8"));
      if (sheet.frames.some((f) => f.rotated)) fail("Rotated frames in the Aseprite JSON aren't supported.");
      canvas = { w: Math.max(...sheet.frames.map((f) => f.sourceSize.w)), h: Math.max(...sheet.frames.map((f) => f.sourceSize.h)) };
      rects = sheet.frames.map((f) => ({ ...f.rect, offsetX: f.spriteSourceSize.x, offsetY: f.spriteSourceSize.y }));
      durations = sheet.frames.map((f) => f.duration);
      jsonTags = sheet.tags;
      for (const s of sheet.slices) {
        for (const k of s.keys) if (k.pivot) for (let f = k.frame; f < sheet.frames.length; f++) pivots[f] = { x: k.bounds.x + k.pivot.x, y: k.bounds.y + k.pivot.y };
      }
      report.slicing = { mode: "asepriteJson", json: project.displayPath(jsonFile), frames: sheet.frames.length };
    } else {
      const spec: GridSpec = {
        frameWidth: slicing.frameWidth / mapped.scale,
        frameHeight: slicing.frameHeight / mapped.scale,
        margin: divideXY(slicing.margin, mapped.scale, "margin"),
        spacing: divideXY(slicing.spacing, mapped.scale, "spacing"),
        count: slicing.count,
      };
      if (!Number.isInteger(spec.frameWidth) || !Number.isInteger(spec.frameHeight)) fail(`Frame size isn't divisible by the detected scale ${mapped.scale}; pass scale: 1.`);
      rects = gridRects(image.w, image.h, spec);
      if (slicing.count === undefined) rects = dropTrailingEmpty(image, rects, warnings);
      report.slicing = { mode: "grid", cells: rects.length };
    }
    if (rects.length === 1 && slicing === "none") canvas = { w: image.w, h: image.h };
    else if (!(typeof slicing === "object" && "asepriteJson" in slicing)) canvas = { w: rects[0]!.w, h: rects[0]!.h };
    doc = createDocument({ id, name, kind, width: canvas.w, height: canvas.h, paletteId: paletteId! });
    doc.frames = rects.map((_, i) => ({ durationMs: durations?.[i] ?? 100, ...(pivots[i] ? { pivot: pivots[i] } : {}) }));
    rects.forEach((r, i) => {
      const cel = ensureCel(doc, "layer_1", i);
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const tx = x + r.offsetX;
          const ty = y + r.offsetY;
          if (tx < 0 || ty < 0 || tx >= canvas.w || ty >= canvas.h) continue;
          cel[ty * canvas.w + tx] = image.data[(r.y + y) * image.w + r.x + x]!;
        }
      }
    });
    for (const t of jsonTags) {
      if (t.from >= 0 && t.to < doc.frames.length && t.from <= t.to) tagFrames(doc, t.name, t.from, t.to, t.direction);
    }
    if (kind === "tileset") doc.tileset = { tileSize: Math.min(canvas.w, canvas.h), wrapDrawing: false };
    if (kind === "icon") doc.icon = { size: Math.min(canvas.w, canvas.h), margin: 1 };
    exportConfig = slicing === "none" ? { type: "png" } : { type: "rects", width: image.w, height: image.h, rects: rects.map((r) => ({ ...r })) };
  }

  doc.source = { path: file, format: "png", importedAt: new Date().toISOString(), sha256: sha256(buf), scale: mapped.scale, exportConfig };
  if (meta?.name) doc.source.assetName = meta.name;
  project.addDoc(doc);
  Object.assign(report, {
    docId: doc.id,
    size: { w: doc.width, h: doc.height },
    frames: doc.frames.length,
    layers: doc.layers.filter((l) => !l.guide).map((l) => l.id),
    tags: [...new Set(doc.frames.map((f) => f.tag).filter((t): t is string => Boolean(t)))],
  });
  if (mapped.scale > 1) warnings.push(`Detected ${mapped.scale}x upscaling; the document is ${doc.width}x${doc.height}. Pass scale: 1 if that is wrong.`);
  return { ok: true, report, doc };
}

function dropTrailingEmpty(image: IndexImage, rects: SliceRect[], warnings: string[]): SliceRect[] {
  let last = rects.length;
  while (last > 1 && !hasRectContent(image, rects[last - 1]!)) last--;
  if (last < rects.length) warnings.push(`Dropped ${rects.length - last} trailing empty cell(s); pass count to keep them.`);
  return rects.slice(0, last);
}

function hasRectContent(image: IndexImage, r: SliceRect): boolean {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (image.data[y * image.w + x]) return true;
  return false;
}

