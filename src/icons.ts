/** Icon sets (spec §10): one frame per icon, a safe-area guide, a shared outline/shadow style. */
import { addLayer, compositeIndexed, createDocument, ensureCel, exportLayers, layerIndex } from "./document.js";
import { assembleExport, collectFrames, defaultTarget, validateForExport } from "./export/exporters.js";
import type { ExportResult, ExportTarget } from "./export/exporters.js";
import { checkPaddingExtrude, layoutGrid } from "./export/layout.js";
import type { Project } from "./project.js";
import { outlineWrites, shadowCel } from "./shading.js";
import { brightestIndex } from "./palette.js";
import type { Document, IconStyle, Layer } from "./types.js";
import { check, fail } from "./util/errors.js";

export const OUTLINE_LAYER = "style_outline";
export const SHADOW_LAYER = "style_shadow";


const isStyleLayer = (l: Layer) => l.id === OUTLINE_LAYER || l.id === SHADOW_LAYER;

export function createIconSet(project: Project, opts: { name: string; size: number; count: number; paletteId?: string; margin: number; names?: string[] }): Document {
  check(opts.count >= 1 && opts.count <= 1024, "count must be 1–1024");
  check(opts.margin >= 0 && opts.margin * 2 < opts.size, "margin must leave a non-empty safe area");
  const doc = createDocument({
    id: project.newDocId(),
    name: opts.name,
    kind: "icon",
    width: opts.size,
    height: opts.size,
    paletteId: project.resolvePaletteId(opts.paletteId),
  });
  doc.icon = { size: opts.size, margin: opts.margin };
  doc.layers = [];
  addLayer(doc, "icon", { id: "icon" });
  const guide = addLayer(doc, "guide", { id: "guide", guide: true, locked: true });
  doc.frames = Array.from({ length: opts.count }, (_, i) => ({ durationMs: 100, label: opts.names?.[i] ?? `icon_${i}` }));
  // Guide: dots on the margin ring outside the safe area.
  const color = brightestIndex(project.getPalette(doc.paletteId));
  for (let f = 0; f < doc.frames.length; f++) {
    const cel = ensureCel(doc, guide.id, f);
    for (let y = 0; y < opts.size; y++) {
      for (let x = 0; x < opts.size; x++) {
        const outside = x < opts.margin || y < opts.margin || x >= opts.size - opts.margin || y >= opts.size - opts.margin;
        if (outside && (x + y) % 2 === 0) cel[y * opts.size + x] = color;
      }
    }
  }
  return doc;
}

/** Art = visible, non-guide, non-style normal layers. */
function artPixels(doc: Document, frame: number): Uint8Array {
  return compositeIndexed(doc, frame, (l) => exportLayers("normal")(l) && !isStyleLayer(l));
}

/** (Re)generates the outline and shadow layers below the art for every frame. */
export function applyIconStyle(doc: Document, style: IconStyle): { outlinePixels: number; shadowPixels: number } {
  const w = doc.width;
  const h = doc.height;
  const ensureStyleLayer = (id: string, below?: string) => {
    let layer = doc.layers.find((l) => l.id === id);
    if (!layer) layer = addLayer(doc, id, { id, index: below ? layerIndex(doc, below) : 0, locked: true });
    return layer;
  };
  const remove = (id: string) => {
    if (!doc.layers.some((l) => l.id === id)) return;
    doc.layers = doc.layers.filter((l) => l.id !== id);
    for (const key of Object.keys(doc.cels)) if (key.startsWith(`${id}:`)) delete doc.cels[key];
  };
  let outlinePixels = 0;
  let shadowPixels = 0;
  if (style.outline) ensureStyleLayer(OUTLINE_LAYER);
  else remove(OUTLINE_LAYER);
  if (style.shadow) ensureStyleLayer(SHADOW_LAYER, doc.layers.some((l) => l.id === OUTLINE_LAYER) ? OUTLINE_LAYER : undefined);
  else remove(SHADOW_LAYER);
  for (let f = 0; f < doc.frames.length; f++) {
    const art = artPixels(doc, f);
    const silhouette = art.slice();
    if (style.outline) {
      const writes = outlineWrites(art, w, h, { mode: "outside", connectivity: style.outline.connectivity, wrap: false }, () => style.outline!.color);
      const cel = ensureCel(doc, OUTLINE_LAYER, f);
      cel.fill(0);
      for (const [p, c] of writes) {
        cel[p] = c;
        silhouette[p] = c;
        outlinePixels++;
      }
    }
    if (style.shadow) {
      const shadow = shadowCel(silhouette, w, h, style.shadow.dx, style.shadow.dy, style.shadow.color, false);
      ensureCel(doc, SHADOW_LAYER, f).set(shadow);
      shadowPixels += shadow.reduce((n, v) => n + (v ? 1 : 0), 0);
    }
  }
  return { outlinePixels, shadowPixels };
}

export function iconNames(doc: Document, names?: string[]): string[] {
  if (names && names.length > doc.frames.length) fail(`${names.length} names for ${doc.frames.length} icons.`);
  const out = doc.frames.map((f, i) => names?.[i] ?? f.label ?? `icon_${i}`);
  const seen = new Set<string>();
  for (const n of out) {
    if (seen.has(n)) fail(`Duplicate icon name "${n}".`);
    seen.add(n);
  }
  return out;
}

export function exportIconAtlas(project: Project, doc: Document, opts: { names?: string[]; columns?: number; name?: string; target?: ExportTarget }): ExportResult {
  if (doc.kind !== "icon") fail(`Document "${doc.id}" is not an icon set.`);
  const names = iconNames(doc, opts.names);
  names.forEach((n, i) => (doc.frames[i]!.label = n));
  const warnings = validateForExport(project, doc);
  const padding = project.settings.atlasPadding;
  const extrude = project.settings.atlasExtrude;
  checkPaddingExtrude(padding, extrude);
  const target = opts.target ?? defaultTarget(project, doc, opts.name);
  const frames = collectFrames(doc, doc.frames.map((_, i) => i), target.assetName.split("/").pop()!).map((f, i) => ({ ...f, name: names[i]! }));
  const columns = opts.columns ?? Math.ceil(Math.sqrt(frames.length));
  const layout = layoutGrid(frames.map((f) => ({ w: f.w, h: f.h })), padding, columns);
  return assembleExport({
    project,
    doc,
    target,
    frames,
    layout,
    extrude,
    layoutMeta: { type: "icons", padding, extrude, columns },
    tags: [],
    extra: { icons: Object.fromEntries(names.map((n, i) => [n, i])), icon: { size: doc.icon?.size ?? doc.width, margin: doc.icon?.margin ?? 0 } },
    warnings,
  });
}
