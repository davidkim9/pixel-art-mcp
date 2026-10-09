import { addLayer, compositeIndexed, createDocument, ensureCel, exportLayers } from "../document.js";
import { assembleExport, collectFrames, defaultTarget, validateForExport } from "../export/exporters.js";
import type { ExportResult, ExportTarget } from "../export/exporters.js";
import { checkPaddingExtrude, layoutGrid } from "../export/layout.js";
import type { ExportFrame } from "../export/metadata.js";
import { brightestIndex, paletteRgb } from "../palette.js";
import type { Project } from "../project.js";
import { AffineBuffer, affineFromIndices } from "../render/compose.js";
import type { Document, TilesetTemplate } from "../types.js";
import { check, fail } from "../util/errors.js";
import { BLOB47_MASKS, BLOB_MASK_TO_FRAME, BLOB_SOURCES, NEIGHBOR_ORDER, blobFrameLabel, blobMaskAt, composeBlobTile } from "./blob47.js";
import type { QuadrantVariant } from "./blob47.js";
import { BL, BR, CORNER_ORDER, TL, TR, dualGridMasks, frameLabel, generateCorner15, maskName } from "./corner15.js";
import type { GeneratedTile } from "./corner15.js";
import { checkTransitionSet, frameMask, requireTemplate, templateFrameCount, tileImages } from "./check.js";

export { checkTransitionSet, frameMask, requireTemplate, templateFrameCount, tileImages };

/** Faint dots marking which parts of each tile are upper terrain. */
export function drawGuide(doc: Document, guideId: string, template: TilesetTemplate, color: number): void {
  const s = doc.width;
  const dots = (cel: Uint8Array, x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (x % 2 === 0 && y % 2 === 0) cel[y * s + x] = color;
  };
  const half = Math.floor(s / 2);
  const third = Math.max(1, Math.floor(s / 3));
  for (let f = 0; f < doc.frames.length; f++) {
    const cel = ensureCel(doc, guideId, f);
    const mask = frameMask(template, f);
    if (template === "corner15") {
      if (mask & TL) dots(cel, 0, 0, half, half);
      if (mask & TR) dots(cel, half, 0, s, half);
      if (mask & BR) dots(cel, half, half, s, s);
      if (mask & BL) dots(cel, 0, half, half, s);
    } else {
      const bands = [0, third, s - third, s];
      const regions: Array<[number, number, number]> = [
        [1, 1, -1], [1, 0, 1], [2, 0, 2], [2, 1, 4], [2, 2, 8], [1, 2, 16], [0, 2, 32], [0, 1, 64], [0, 0, 128],
      ];
      for (const [rx, ry, bit] of regions) {
        if (bit === -1 || mask & bit) dots(cel, bands[rx]!, bands[ry]!, bands[rx + 1]!, bands[ry + 1]!);
      }
    }
  }
}

export function createTransitionSet(
  project: Project,
  opts: { name: string; tileSize: number; template: TilesetTemplate; terrains: { lower: string; upper: string }; paletteId?: string; overlay: boolean },
): Document {
  check(Number.isInteger(opts.tileSize) && opts.tileSize >= 4 && opts.tileSize <= 256, "tileSize must be an integer 4–256");
  const doc = createDocument({
    id: project.newDocId(),
    name: opts.name,
    kind: "tileset",
    width: opts.tileSize,
    height: opts.tileSize,
    paletteId: project.resolvePaletteId(opts.paletteId),
  });
  doc.tileset = {
    tileSize: opts.tileSize,
    wrapDrawing: false,
    template: opts.template,
    terrains: { ...opts.terrains },
    overlay: opts.overlay,
  };
  doc.layers = [];
  addLayer(doc, "tiles", { id: "tiles" });
  const guide = addLayer(doc, "guide", { id: "guide", guide: true, locked: true });
  const n = templateFrameCount(opts.template);
  doc.frames = Array.from({ length: n }, (_, i) => ({
    durationMs: 100,
    label: opts.template === "corner15" ? frameLabel(i) + (i === 0 ? (opts.overlay ? " (leave empty)" : " (base tile)") : "") : blobFrameLabel(BLOB47_MASKS[i]!),
  }));
  drawGuide(doc, guide.id, opts.template, brightestIndex(project.getPalette(doc.paletteId)));
  return doc;
}

/** Adds the locked guide layer of a transition set (used when re-importing an exported set). */
export function addTransitionGuide(project: Project, doc: Document): void {
  const template = doc.tileset?.template;
  if (!template || doc.layers.some((l) => l.id === "guide")) return;
  const guide = addLayer(doc, "guide", { id: "guide", guide: true, locked: true });
  drawGuide(doc, guide.id, template, brightestIndex(project.getPalette(doc.paletteId)));
}

export interface GenerateReport {
  generated: GeneratedTile[] | Array<{ mask: number; frame: number; from: string }>;
  kept: number[];
  stillMissing: number[];
}

export function generateAutotile(doc: Document, sources: number[] | undefined, overwrite: boolean, layerId: string): GenerateReport {
  const template = requireTemplate(doc);
  const tiles = tileImages(doc);
  const size = doc.width;
  const nonEmpty = (i: number) => tiles[i]!.some((v) => v !== 0);
  if (template === "corner15") {
    const src = (sources ?? [...Array(16).keys()].filter((m) => m > 0 && nonEmpty(m))).filter((m) => m > 0 && m < 16);
    for (const m of src) if (!nonEmpty(m)) fail(`Source tile ${m} is empty.`);
    if (!src.length) fail("Draw at least one tile first (e.g. 15 full, 3 edge, 1 outer corner, 7 inner corner).");
    const targets = new Set<number>();
    const kept: number[] = [];
    for (let m = 1; m < 16; m++) {
      if (src.includes(m)) continue;
      if (nonEmpty(m) && !overwrite) kept.push(m);
      else targets.add(m);
    }
    const generated = generateCorner15(tiles, size, src, doc.tileset!.overlay ?? false, targets);
    for (const g of generated) ensureCel(doc, layerId, g.mask).set(tiles[g.mask]!);
    const stillMissing = [...Array(16).keys()].filter((m) => m > 0 && !tiles[m]!.some((v) => v));
    return { generated, kept, stillMissing };
  }
  const variants = Object.entries(BLOB_SOURCES) as Array<[QuadrantVariant, number]>;
  const srcTiles = {} as Record<QuadrantVariant, Uint8Array>;
  const missingSources: string[] = [];
  for (const [variant, mask] of variants) {
    const frame = BLOB47_MASKS.indexOf(mask);
    if (!nonEmpty(frame)) missingSources.push(`${variant} (frame ${frame}, ${blobFrameLabel(mask)})`);
    srcTiles[variant] = tiles[frame]!;
  }
  if (missingSources.length) fail(`blob47 generation needs these five source tiles drawn first: ${missingSources.join("; ")}.`);
  const sourceFrames = new Set(variants.map(([, m]) => BLOB47_MASKS.indexOf(m)));
  const generated: Array<{ mask: number; frame: number; from: string }> = [];
  const kept: number[] = [];
  BLOB47_MASKS.forEach((mask, frame) => {
    if (sourceFrames.has(frame)) return;
    if (nonEmpty(frame) && !overwrite) {
      kept.push(mask);
      return;
    }
    ensureCel(doc, layerId, frame).set(composeBlobTile(mask, srcTiles, size));
    generated.push({ mask, frame, from: "quadrants" });
  });
  return { generated, kept, stillMissing: [] };
}

/** Copies the non-empty pixels of src into dst at (dx, dy). */
function overlayAffine(dst: AffineBuffer, src: AffineBuffer, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const p = y * src.width + x;
      if (src.isEmpty(p)) continue;
      const tx = dx + x;
      const ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
      dst.data.set(src.data.subarray(p * 4, p * 4 + 4), (ty * dst.width + tx) * 4);
    }
  }
}

export interface TerrainRender {
  buf: AffineBuffer;
  usedMasks: number[];
  missingTiles: number[];
}

/** Renders a cell map with the set (corner15: dual grid offset by half a tile; blob47: cell-centered). */
export function renderTerrain(project: Project, doc: Document, cells: boolean[][], base?: { doc: Document; frame: number }): TerrainRender {
  const template = requireTemplate(doc);
  const palette = paletteRgb(project.paletteFor(doc));
  const s = doc.width;
  const tiles = tileImages(doc).map((t) => affineFromIndices(t, s, s, palette));
  const nonEmpty = tileImages(doc).map((t) => t.some((v) => v));
  const baseBuf = base ? affineFromIndices(compositeIndexed(base.doc, base.frame, exportLayers("normal")), base.doc.width, base.doc.height, paletteRgb(project.paletteFor(base.doc))) : undefined;
  const used = new Set<number>();
  const missing = new Set<number>();
  if (template === "corner15") {
    const masks = dualGridMasks(cells);
    const H = masks.length;
    const W = masks[0]!.length;
    const buf = new AffineBuffer(W * s, H * s);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const m = masks[j]![i]!;
        used.add(m);
        if (baseBuf) overlayAffine(buf, baseBuf, i * s, j * s);
        if (m !== 0 && !nonEmpty[m]) missing.add(m);
        overlayAffine(buf, tiles[m]!, i * s, j * s);
      }
    }
    return { buf, usedMasks: [...used].sort((a, b) => a - b), missingTiles: [...missing].sort((a, b) => a - b) };
  }
  const H = cells.length;
  const W = cells[0]?.length ?? 0;
  const buf = new AffineBuffer(W * s, H * s);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (baseBuf) overlayAffine(buf, baseBuf, x * s, y * s);
      if (!cells[y]![x]) continue;
      const m = blobMaskAt(cells, x, y);
      used.add(m);
      const frame = BLOB47_MASKS.indexOf(m);
      if (!nonEmpty[frame]) missing.add(m);
      overlayAffine(buf, tiles[frame]!, x * s, y * s);
    }
  }
  return { buf, usedMasks: [...used].sort((a, b) => a - b), missingTiles: [...missing].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// Export

export function exportTileset(project: Project, doc: Document, opts: { columns?: number; name?: string; target?: ExportTarget }): ExportResult {
  if (doc.kind !== "tileset" && !doc.tileset) fail(`Document "${doc.id}" is not a tileset.`);
  const warnings = validateForExport(project, doc);
  const cfg = doc.source?.exportConfig?.type === "tileset" ? doc.source.exportConfig : undefined;
  const padding = cfg?.padding ?? project.settings.atlasPadding;
  const extrude = cfg?.extrude ?? project.settings.atlasExtrude;
  checkPaddingExtrude(padding, extrude);
  const template = doc.tileset?.template;
  opts = { ...opts, columns: opts.columns ?? cfg?.columns };
  const target = opts.target ?? defaultTarget(project, doc, opts.name);
  const base = target.assetName.split("/").pop()!;
  const frameIdx = doc.frames.map((_, i) => i);
  let frames: ExportFrame[] = collectFrames(doc, frameIdx, base);
  let columns = opts.columns ?? Math.ceil(Math.sqrt(frames.length));
  const tilesetMeta: Record<string, unknown> = { tileSize: doc.width };
  if (template === "corner15") {
    requireTemplate(doc);
    if (opts.columns !== undefined && opts.columns !== 4) warnings.push("corner15 atlases always use 4 columns so that frameIndex === mask.");
    columns = 4;
    frames = frames.map((f, m) => ({ ...f, name: `${base}_${m}`, extra: { mask: m, corners: maskName(m) } }));
    Object.assign(tilesetMeta, {
      template,
      cornerOrder: [...CORNER_ORDER],
      maskFormula: "TL*1 + TR*2 + BR*4 + BL*8 (1 = upper terrain)",
      frameIndexIsMask: true,
      terrains: doc.tileset!.terrains,
      overlay: doc.tileset!.overlay ?? false,
      dualGrid: true,
    });
  } else if (template === "blob47") {
    requireTemplate(doc);
    columns = opts.columns ?? 8;
    frames = frames.map((f, i) => ({ ...f, name: `${base}_${BLOB47_MASKS[i]}`, extra: { mask: BLOB47_MASKS[i] } }));
    Object.assign(tilesetMeta, {
      template,
      neighborOrder: [...NEIGHBOR_ORDER],
      maskFormula: "N*1 + NE*2 + E*4 + SE*8 + S*16 + SW*32 + W*64 + NW*128; corners count only with both adjacent edges",
      maskToFrame: BLOB_MASK_TO_FRAME,
      terrains: doc.tileset!.terrains,
      overlay: doc.tileset!.overlay ?? false,
    });
  }
  const layout = layoutGrid(frames.map((f) => ({ w: f.w, h: f.h })), padding, columns);
  return assembleExport({
    project,
    doc,
    target,
    frames,
    layout,
    extrude,
    layoutMeta: { type: "tileset", padding, extrude, columns },
    tags: [],
    extra: { tileset: tilesetMeta },
    warnings,
  });
}

export { BL, BR, TL, TR };
