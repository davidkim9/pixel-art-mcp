import fs from "node:fs";
import path from "node:path";
import { toHex } from "../color.js";
import { addLayer, createDocument, ensureCel } from "../document.js";
import { PaletteMatcher } from "../palette.js";
import type { PaletteSourceResult } from "../palette-sources.js";
import type { Project } from "../project.js";
import type { BlendMode, Document, Palette, TagDirection } from "../types.js";
import { fail } from "../util/errors.js";
import { sha256, slugify } from "../util/ids.js";
import { ASE_BLEND_NAMES, ASE_TAG_DIRECTIONS, parseAseprite, renderTilemapCel } from "./aseprite.js";
import type { AseLayer, AsepriteFile } from "./aseprite.js";
import { ColorMapper } from "./colormap.js";
import type { ColorMappingReport } from "./colormap.js";
import { registerExtractedPalette, targetPalette } from "./png-import.js";
import type { ImportOptions, ImportOutcome, ImportReport } from "./png-import.js";
import { detectScale } from "./scale.js";

export interface AseImportOptions extends ImportOptions {
  layerGroups?: "flatten-names" | "merge";
  includeHidden?: boolean;
}

const STANDARD_PARTS = new Set(["head", "body", "torso", "hand_l", "hand_r", "foot_l", "foot_r", "arm_l", "arm_r", "leg_l", "leg_r"]);

interface Hierarchy {
  parent: Array<number | undefined>;
  pathName: string[];
  visible: boolean[];
  root: number[];
}

function hierarchy(ase: AsepriteFile): Hierarchy {
  const parent: Array<number | undefined> = [];
  const pathName: string[] = [];
  const visible: boolean[] = [];
  const root: number[] = [];
  const stack: number[] = [];
  for (const l of ase.layers) {
    stack.length = l.childLevel;
    const p = l.childLevel > 0 ? stack[l.childLevel - 1] : undefined;
    parent[l.index] = p;
    pathName[l.index] = p !== undefined ? `${pathName[p]}/${l.name}` : l.name;
    visible[l.index] = l.visible && (p === undefined || visible[p]!);
    root[l.index] = p !== undefined ? root[p]! : l.index;
    stack[l.childLevel] = l.index;
  }
  return { parent, pathName, visible, root };
}

interface PlannedLayer {
  name: string;
  visible: boolean;
  blend: BlendMode;
  sources: AseLayer[];
}

function mapBlend(layer: AseLayer, warnings: string[], label: string): BlendMode {
  if (layer.blendMode === 0) return "normal";
  if (layer.blendMode === 16 || layer.blendMode === 5) return "additive";
  warnings.push(`Layer '${label}' uses blend mode '${ASE_BLEND_NAMES[layer.blendMode] ?? layer.blendMode}'; flattened to normal.`);
  return "normal";
}

function planLayers(ase: AsepriteFile, opts: AseImportOptions, warnings: string[]): PlannedLayer[] {
  const h = hierarchy(ase);
  const includeHidden = opts.includeHidden ?? true;
  const plans: PlannedLayer[] = [];
  const byRoot = new Map<number, PlannedLayer>();
  for (const l of ase.layers) {
    if (l.type === 1) continue;
    const label = h.pathName[l.index]!;
    if (l.reference) {
      warnings.push(`Reference layer '${label}' was skipped (reference layers are never exported).`);
      continue;
    }
    if (!h.visible[l.index] && !includeHidden) continue;
    if (l.opacity < 255) warnings.push(`Layer '${label}' had ${Math.round((l.opacity / 255) * 100)}% opacity; flattened to 100%.`);
    if (l.type === 2) warnings.push(`Tilemap layer '${label}' was imported as rendered pixels.`);
    const blend = mapBlend(l, warnings, label);
    if (opts.layerGroups === "merge" && h.root[l.index] !== l.index) {
      const rootIdx = h.root[l.index]!;
      if (!h.visible[l.index] && h.visible[rootIdx]) {
        warnings.push(`Hidden layer '${label}' inside a merged group was skipped.`);
        continue;
      }
      let plan = byRoot.get(rootIdx);
      if (!plan) {
        plan = { name: ase.layers[rootIdx]!.name, visible: h.visible[rootIdx]!, blend: "normal", sources: [] };
        byRoot.set(rootIdx, plan);
        plans.push(plan);
      }
      if (blend !== "normal") warnings.push(`Layer '${label}' is merged into '${plan.name}' with normal blending.`);
      plan.sources.push(l);
      continue;
    }
    plans.push({ name: h.pathName[l.index]!, visible: h.visible[l.index]!, blend, sources: [l] });
  }
  return plans;
}

const BG_TRANSPARENT = 256; // sentinel: background layer pixel using the transparent index (opaque in Aseprite)

/** Per planned layer and frame: raw indices (indexed files, -1 = empty) or RGBA. */
function extractPixels(ase: AsepriteFile, plans: PlannedLayer[], warnings: string[]): Array<Array<Int16Array | Uint8Array>> {
  const { width: W, height: H } = ase;
  const indexed = ase.colorDepth === 8;
  const bpp = ase.colorDepth / 8;
  const opacityWarned = new Set<string>();
  let zWarned = false;
  return plans.map((plan) =>
    ase.frames.map((frame) => {
      const buf: Int16Array | Uint8Array = indexed ? new Int16Array(W * H).fill(-1) : new Uint8Array(W * H * 4);
      for (const layer of plan.sources) {
        const cel = frame.cels.find((c) => c.layerIndex === layer.index);
        if (!cel) continue;
        if (cel.opacity < 255 && !opacityWarned.has(layer.name)) {
          opacityWarned.add(layer.name);
          warnings.push(`Layer '${layer.name}' has cels below 100% opacity; flattened to 100%.`);
        }
        if (cel.zIndex !== 0 && !zWarned) {
          zWarned = true;
          warnings.push("Some cels use z-index ordering, which can't be represented per frame; layer order was used.");
        }
        let img: { w: number; h: number; pixels: Uint8Array } | undefined;
        if (cel.tilemap) img = renderTilemapCel(ase, layer, cel);
        else if (cel.pixels) img = { w: cel.w, h: cel.h, pixels: cel.pixels };
        if (!img) continue;
        for (let y = 0; y < img.h; y++) {
          const ty = cel.y + y;
          if (ty < 0 || ty >= H) continue;
          for (let x = 0; x < img.w; x++) {
            const tx = cel.x + x;
            if (tx < 0 || tx >= W) continue;
            const s = (y * img.w + x) * bpp;
            const p = ty * W + tx;
            if (indexed) {
              const v = img.pixels[s]!;
              if (v === ase.transparentIndex) {
                if (layer.background) (buf as Int16Array)[p] = BG_TRANSPARENT;
                continue;
              }
              (buf as Int16Array)[p] = v;
            } else {
              const [r, g, b, a] = bpp === 4 ? [img.pixels[s]!, img.pixels[s + 1]!, img.pixels[s + 2]!, img.pixels[s + 3]!] : [img.pixels[s]!, img.pixels[s]!, img.pixels[s]!, img.pixels[s + 1]!];
              if (a === 0) continue;
              const o = p * 4;
              buf[o] = r;
              buf[o + 1] = g;
              buf[o + 2] = b;
              buf[o + 3] = a;
            }
          }
        }
      }
      return buf;
    }),
  );
}

function downsampleBuf(buf: Int16Array | Uint8Array, W: number, H: number, n: number, channels: number): Int16Array | Uint8Array {
  const w = W / n;
  const h = H / n;
  const out = buf instanceof Int16Array ? new Int16Array(w * h * channels) : new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) out[(y * w + x) * channels + c] = buf[(y * n * W + x * n) * channels + c]!;
  return out;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Aligned palette for an Aseprite file: index i of ours = file index r(i) (transparent index swapped to 0). */
export function asePaletteColors(ase: AsepriteFile): { colors: string[]; remap: (v: number) => number } {
  const t = ase.colorDepth === 8 ? ase.transparentIndex : -1;
  const remap = (v: number) => (t <= 0 ? v : v === t ? 0 : v === 0 ? t : v);
  const n = ase.palette.length;
  const colors: string[] = [];
  for (let i = 1; i < n; i++) colors.push(toHex(ase.palette[remap(i)]!));
  return { colors, remap };
}

/** load_palette support for .aseprite files. */
export function paletteFromAseprite(buf: Uint8Array): PaletteSourceResult {
  const ase = parseAseprite(buf);
  if (!ase.palette.length) fail("The .aseprite file has no palette.");
  if (ase.colorDepth === 8) {
    const { colors } = asePaletteColors(ase);
    const note = ase.transparentIndex !== 0 ? ` (transparent index ${ase.transparentIndex} swapped with 0)` : "";
    return { colors, origin: `indexed Aseprite palette, indices preserved${note}` };
  }
  if (ase.palette[0]!.a === 0) return { colors: ase.palette.slice(1).map((c) => toHex(c)), origin: "Aseprite palette (entry 0 transparent; indices preserved)" };
  return { colors: ase.palette.map((c) => toHex(c)), origin: "Aseprite palette (shifted by one: index 0 is reserved for transparency)" };
}

export function importAseprite(project: Project, filePath: string, opts: AseImportOptions): ImportOutcome {
  const file = project.resolveReadPath(filePath);
  if (!/\.(aseprite|ase)$/i.test(file)) fail(`${filePath} is not an .aseprite/.ase file.`);
  const buf = fs.readFileSync(file);
  const ase = parseAseprite(buf);
  const warnings = [...ase.warnings];
  const mode = opts.colorMode ?? "exact";
  const alphaThreshold = opts.alphaThreshold ?? 128;
  const plans = planLayers(ase, opts, warnings);
  if (!plans.length) fail("The file has no image layers to import.");
  let pixels = extractPixels(ase, plans, warnings);
  const indexed = ase.colorDepth === 8;
  const channels = indexed ? 1 : 4;

  // Scale detection across every layer and frame.
  // .aseprite files are authored at native resolution: detect upscaling only when asked.
  let scale = 1;
  if (typeof opts.scale === "number") scale = opts.scale;
  else if (opts.scale === "auto") {
    let g = 0;
    for (const layer of pixels) {
      for (const b of layer) {
        const same = indexed
          ? (a: number, c: number) => b[a] === b[c]
          : (a: number, c: number) => {
              const ta = b[a * 4 + 3]! < alphaThreshold;
              const tc = b[c * 4 + 3]! < alphaThreshold;
              if (ta || tc) return ta && tc;
              return b[a * 4] === b[c * 4] && b[a * 4 + 1] === b[c * 4 + 1] && b[a * 4 + 2] === b[c * 4 + 2];
            };
        g = gcd(g, detectScale(ase.width, ase.height, same));
        if (g === 1) break;
      }
      if (g === 1) break;
    }
    scale = g || 1;
  }
  if (ase.width % scale !== 0 || ase.height % scale !== 0) fail(`Scale ${scale} doesn't divide the ${ase.width}x${ase.height} canvas.`);
  const W = ase.width / scale;
  const H = ase.height / scale;
  if (scale > 1) pixels = pixels.map((layer) => layer.map((b) => downsampleBuf(b, ase.width, ase.height, scale, channels)));

  const report: ImportReport = {
    docId: null,
    source: { path: project.displayPath(file), format: "aseprite" },
    size: { w: W, h: H },
    detectedScale: scale,
    frames: ase.frames.length,
    layers: [],
    tags: ase.tags.map((t) => t.name),
    colorMapping: { mode, offPalette: [], substitutions: [] },
    alphaThresholded: 0,
    warnings,
    colorDepth: indexed ? "indexed" : ase.colorDepth === 16 ? "grayscale" : "rgba",
  };

  // ---- Color mapping → index buffers
  let palette: Palette | undefined = targetPalette(project, opts);
  if (mode !== "extract" && !palette && !indexed) fail("No palette to map into: load_palette first, pass paletteId, or use colorMode \"extract\".");
  let outputs: Uint8Array[][];
  let mapping: ColorMappingReport;
  let alphaThresholded = 0;
  if (indexed) {
    const { colors, remap } = asePaletteColors(ase);
    const filePal = ase.palette;
    if (ase.transparentIndex !== 0) {
      warnings.push(`Transparent index ${ase.transparentIndex} was remapped to 0 (indices ${ase.transparentIndex} and 0 swapped).`);
      report.transparentIndexRemapped = { from: ase.transparentIndex, to: 0 };
    }
    const used = new Set<number>();
    let bgUsed = false;
    for (const layer of pixels) for (const b of layer) for (let i = 0; i < b.length; i++) {
      const v = b[i]!;
      if (v === BG_TRANSPARENT) bgUsed = true;
      else if (v >= 0) used.add(v);
    }
    for (const v of used) {
      const a = filePal[v]?.a ?? 255;
      if (a > 0 && a < 255) alphaThresholded++;
    }
    const bgColor = filePal[ase.transparentIndex] ?? { r: 0, g: 0, b: 0, a: 255 };
    const compatible =
      palette !== undefined &&
      mode !== "extract" &&
      [...used].every((v) => {
        const e = filePal[v];
        if (!e) return false;
        if (e.a < alphaThreshold) return true;
        const u = remap(v);
        return u >= 1 && u < palette!.colors.length && palette!.colors[u] === toHex(e);
      });
    if (mode === "extract" || !palette || compatible) {
      let bgIndex: number | undefined;
      if (mode === "extract" || !palette) {
        const extra = [...colors];
        if (bgUsed) {
          if (extra.length >= 255) warnings.push("Background pixels that use the transparent index stay transparent (no free palette slot).");
          else {
            extra.push(toHex(bgColor));
            bgIndex = extra.length;
            warnings.push(`Background-layer pixels using the transparent index are opaque in Aseprite; they map to new index ${bgIndex} (${toHex(bgColor)}).`);
          }
        }
        palette = registerExtractedPalette(project, opts.name ?? path.basename(file).replace(/\.[^.]+$/, ""), extra);
        report.paletteCreated = { id: palette.id, colors: palette.colors.length - 1 };
      } else if (bgUsed) {
        bgIndex = new PaletteMatcher(palette).exact(bgColor.r, bgColor.g, bgColor.b);
        if (bgIndex === undefined) {
          if (mode === "nearest") bgIndex = new PaletteMatcher(palette).nearest(bgColor.r, bgColor.g, bgColor.b);
          else {
            mapping = {
              mode,
              offPalette: [{ color: toHex(bgColor), count: 0, samples: [] }],
              substitutions: [],
            };
            report.colorMapping = mapping;
            return { ok: false, report, message: `Background-layer pixels use ${toHex(bgColor)} (the transparent index, opaque on background layers), which is not in palette "${palette.id}".` };
          }
        }
      }
      report.paletteMapping = "indexed palette kept (indices preserved)";
      mapping = { mode, offPalette: [], substitutions: [] };
      outputs = pixels.map((layer) =>
        layer.map((b) => {
          const out = new Uint8Array(W * H);
          for (let i = 0; i < out.length; i++) {
            const v = b[i]!;
            if (v === BG_TRANSPARENT) out[i] = bgIndex ?? 0;
            else if (v >= 0) out[i] = (filePal[v]?.a ?? 255) < alphaThreshold ? 0 : remap(v);
          }
          return out;
        }),
      );
    } else {
      const mapper = new ColorMapper({ mode, palette, alphaThreshold, coordScale: scale });
      outputs = pixels.map((layer, li) =>
        layer.map((b, f) => {
          const out = new Uint8Array(W * H);
          for (let i = 0; i < out.length; i++) {
            const v = b[i]!;
            if (v < 0) continue;
            const e = v === BG_TRANSPARENT ? { ...bgColor, a: 255 } : (filePal[v] ?? { r: 0, g: 0, b: 0, a: 255 });
            out[i] = mapper.map(e.r, e.g, e.b, e.a, i % W, Math.floor(i / W), f, plans[li]!.name);
          }
          return out;
        }),
      );
      mapping = mapper.report();
      if (mapper.failed) {
        report.colorMapping = mapping;
        report.alphaThresholded = alphaThresholded;
        return { ok: false, report, message: `${mapping.offPalette.length} color(s) are not in palette "${palette.id}". Nothing was imported.` };
      }
      report.paletteMapping = "file palette differs from the target palette; colors were mapped";
    }
  } else {
    const mapper = new ColorMapper({ mode, palette, alphaThreshold, coordScale: scale });
    outputs = pixels.map((layer, li) =>
      layer.map((b, f) => {
        const out = new Uint8Array(W * H);
        for (let i = 0; i < out.length; i++) {
          const o = i * 4;
          if (b[o + 3] === 0) continue;
          out[i] = mapper.map(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!, i % W, Math.floor(i / W), f, plans[li]!.name);
        }
        return out;
      }),
    );
    alphaThresholded = mapper.alphaThresholded;
    mapping = mapper.report();
    if (mapper.failed) {
      report.colorMapping = mapping;
      report.alphaThresholded = alphaThresholded;
      const message = mapper.tooManyColors ? "More than 255 colors; can't extract a palette." : `${mapping.offPalette.length} color(s) are not in palette "${palette!.id}". Nothing was imported.`;
      return { ok: false, report, message };
    }
    if (mode === "extract") {
      palette = registerExtractedPalette(project, opts.name ?? path.basename(file).replace(/\.[^.]+$/, ""), mapper.extractedColors());
      report.paletteCreated = { id: palette.id, colors: palette.colors.length - 1 };
    }
  }
  report.colorMapping = mapping;
  report.alphaThresholded = alphaThresholded;

  // ---- Document
  const kind = opts.kind ?? "sprite";
  const doc: Document = createDocument({
    id: project.newDocId(),
    name: opts.name ?? path.basename(file).replace(/\.[^.]+$/, ""),
    kind,
    width: W,
    height: H,
    paletteId: palette!.id,
  });
  doc.layers = [];
  const ids: string[] = [];
  plans.forEach((plan, li) => {
    const layer = addLayer(doc, plan.name, { blend: plan.blend, visible: plan.visible });
    ids.push(layer.id);
    outputs[li]!.forEach((cel, f) => {
      if (cel.some((v) => v !== 0)) ensureCel(doc, layer.id, f).set(cel);
    });
  });
  doc.frames = ase.frames.map((f) => ({ durationMs: f.duration || 100 }));

  // Tags (Aseprite allows overlaps; a frame keeps the last tag that covers it)
  const owner: Array<string | undefined> = [];
  for (const t of ase.tags) {
    const dir: TagDirection = ASE_TAG_DIRECTIONS[t.direction] ?? "forward";
    for (let f = t.from; f <= t.to && f < doc.frames.length; f++) {
      if (owner[f] !== undefined) warnings.push(`Tags '${owner[f]}' and '${t.name}' overlap at frame ${f}; the frame keeps '${t.name}'.`);
      owner[f] = t.name;
      doc.frames[f]!.tag = t.name;
    }
    doc.tagDirections = { ...doc.tagDirections, [t.name]: dir };
    if (t.repeat > 0) warnings.push(`Tag '${t.name}' repeat count (${t.repeat}) is not stored.`);
  }

  // Slices: a pivot becomes the frame pivot; rig-part names are offered as candidates.
  const sliceInfo = ase.slices.map((s) => ({
    name: s.name,
    keys: s.keys.map((k) => ({ frame: k.frame, bounds: { x: k.x / scale, y: k.y / scale, w: k.w / scale, h: k.h / scale }, ...(k.pivot ? { pivot: { x: k.pivot.x / scale, y: k.pivot.y / scale } } : {}) })),
  }));
  const withPivot = ase.slices.filter((s) => s.flags & 2 && s.keys.some((k) => k.pivot));
  const pivotSlice = withPivot.find((s) => /^(pivot|origin|anchor)$/i.test(s.name)) ?? withPivot[0];
  if (pivotSlice) {
    const keys = [...pivotSlice.keys].sort((a, b) => a.frame - b.frame);
    keys.forEach((k, i) => {
      if (!k.pivot) return;
      const end = keys[i + 1]?.frame ?? doc.frames.length;
      for (let f = k.frame; f < end && f < doc.frames.length; f++) doc.frames[f]!.pivot = { x: (k.x + k.pivot.x) / scale, y: (k.y + k.pivot.y) / scale };
    });
    report.pivotFromSlice = pivotSlice.name;
    if (withPivot.length > 1) warnings.push(`Several slices have pivots; '${pivotSlice.name}' was used for frame pivots.`);
  }
  const layerNames = new Set([...ids, ...plans.map((p) => p.name)]);
  const candidates = sliceInfo.filter((s) => STANDARD_PARTS.has(slugify(s.name)) || layerNames.has(s.name) || layerNames.has(slugify(s.name)));
  if (sliceInfo.length) report.slices = sliceInfo;
  if (candidates.length) report.rigPartCandidates = candidates.map((c) => ({ name: c.name, layerId: ids.find((id) => id === slugify(c.name)) ?? null, bounds: c.keys[0]?.bounds, pivot: c.keys[0]?.pivot }));

  if (kind === "tileset") doc.tileset = { tileSize: Math.min(W, H), wrapDrawing: false };
  if (kind === "icon") doc.icon = { size: Math.min(W, H), margin: 1 };
  if (kind === "character") {
    const singleTags = ase.tags.length === doc.frames.length && ase.tags.every((t, i) => t.from === i && t.to === i);
    const directions = singleTags ? ase.tags.map((t) => t.name) : doc.frames.map((_, i) => `frame_${i}`);
    doc.frames.forEach((f, i) => (f.label = directions[i]));
    doc.rig = {
      parts: ids.map((id) => ({ layerId: id, pivot: { x: W / 2, y: H / 2 } })),
      directions,
      drawOrder: Object.fromEntries(directions.map((d) => [d, [...ids]])),
      poses: [],
    };
    warnings.push("Character rig created with default pivots; set them with define_rig_part" + (candidates.length ? " (see rigPartCandidates)." : "."));
  }
  if (ase.hasColorProfile) report.colorProfile = "ignored (colors are used as stored)";
  doc.source = { path: file, format: "aseprite", importedAt: new Date().toISOString(), sha256: sha256(buf), scale };
  project.addDoc(doc);
  Object.assign(report, {
    docId: doc.id,
    layers: ids,
    tags: [...new Set(ase.tags.map((t) => t.name))],
    hiddenLayers: doc.layers.filter((l) => !l.visible).map((l) => l.id),
  });
  return { ok: true, report, doc };
}
