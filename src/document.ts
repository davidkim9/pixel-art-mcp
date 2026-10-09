import type { BlendMode, DocKind, Document, Frame, Layer, Point, TagDirection } from "./types.js";
import { check, fail } from "./util/errors.js";
import { slugify, uniqueId } from "./util/ids.js";

export const DEFAULT_FRAME_MS = 100;

export function celKey(layerId: string, frame: number): string {
  return `${layerId}:${frame}`;
}

export function getCel(doc: Document, layerId: string, frame: number): Uint8Array | undefined {
  return doc.cels[celKey(layerId, frame)];
}

export function ensureCel(doc: Document, layerId: string, frame: number): Uint8Array {
  const key = celKey(layerId, frame);
  let cel = doc.cels[key];
  if (!cel) {
    cel = new Uint8Array(doc.width * doc.height);
    doc.cels[key] = cel;
  }
  return cel;
}

/** The cel's pixels, or a fresh transparent buffer (not stored) if the cel is empty. */
export function readCel(doc: Document, layerId: string, frame: number): Uint8Array {
  return getCel(doc, layerId, frame) ?? new Uint8Array(doc.width * doc.height);
}

export function createDocument(params: {
  id: string;
  name: string;
  kind: DocKind;
  width: number;
  height: number;
  paletteId: string;
}): Document {
  const { width, height } = params;
  check(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1, `Invalid canvas size ${width}x${height}`);
  check(width <= 4096 && height <= 4096, "Canvas is limited to 4096x4096 pixels");
  return {
    id: params.id,
    name: params.name,
    kind: params.kind,
    width,
    height,
    paletteId: params.paletteId,
    layers: [{ id: "layer_1", name: "Layer 1", visible: true, locked: false, blend: "normal" }],
    frames: [{ durationMs: DEFAULT_FRAME_MS }],
    cels: {},
  };
}

export function cloneDocument(doc: Document): Document {
  return structuredClone(doc);
}

// ---------------------------------------------------------------------------
// Layers

export function findLayer(doc: Document, layerId: string): Layer {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) {
    fail(`Document "${doc.id}" has no layer "${layerId}". Layers: ${doc.layers.map((l) => `${l.id} ("${l.name}")`).join(", ")}.`);
  }
  return layer;
}

/** Resolves an optional layer id: defaults to the only non-guide layer. */
export function resolveLayerId(doc: Document, layerId?: string): string {
  if (layerId !== undefined) {
    const byId = doc.layers.find((l) => l.id === layerId);
    if (byId) return byId.id;
    const byName = doc.layers.filter((l) => l.name === layerId);
    if (byName.length === 1) return byName[0]!.id;
    return findLayer(doc, layerId).id;
  }
  const drawable = doc.layers.filter((l) => !l.guide);
  if (drawable.length === 1) return drawable[0]!.id;
  fail(`Document "${doc.id}" has ${drawable.length} layers; pass layerId (one of: ${drawable.map((l) => l.id).join(", ")}).`);
}

export function layerIndex(doc: Document, layerId: string): number {
  findLayer(doc, layerId);
  return doc.layers.findIndex((l) => l.id === layerId);
}

export function addLayer(
  doc: Document,
  name: string,
  opts: { blend?: BlendMode; index?: number; guide?: boolean; id?: string; locked?: boolean; visible?: boolean } = {},
): Layer {
  const id = uniqueId(opts.id ?? slugify(name, "layer"), (candidate) => doc.layers.some((l) => l.id === candidate));
  const layer: Layer = {
    id,
    name,
    visible: opts.visible ?? true,
    locked: opts.locked ?? false,
    blend: opts.blend ?? "normal",
  };
  if (opts.guide) layer.guide = true;
  const index = opts.index ?? doc.layers.length;
  check(index >= 0 && index <= doc.layers.length, `Layer index ${index} out of range 0–${doc.layers.length}`);
  doc.layers.splice(index, 0, layer);
  return layer;
}

export function removeLayer(doc: Document, layerId: string): void {
  findLayer(doc, layerId);
  check(doc.layers.length > 1, "Cannot remove the last layer.");
  doc.layers = doc.layers.filter((l) => l.id !== layerId);
  for (const key of Object.keys(doc.cels)) {
    if (key.startsWith(`${layerId}:`) && key.slice(layerId.length + 1).match(/^\d+$/)) delete doc.cels[key];
  }
  if (doc.rig) {
    doc.rig.parts = doc.rig.parts.filter((p) => p.layerId !== layerId);
    for (const part of doc.rig.parts) if (part.parent === layerId) delete part.parent;
    for (const dir of Object.keys(doc.rig.drawOrder)) {
      doc.rig.drawOrder[dir] = doc.rig.drawOrder[dir]!.filter((id) => id !== layerId);
    }
    for (const pose of doc.rig.poses) delete pose.parts[layerId];
  }
}

export function reorderLayer(doc: Document, layerId: string, newIndex: number): void {
  const from = layerIndex(doc, layerId);
  check(Number.isInteger(newIndex) && newIndex >= 0 && newIndex < doc.layers.length, `newIndex must be 0–${doc.layers.length - 1} (0 = bottom)`);
  const [layer] = doc.layers.splice(from, 1);
  doc.layers.splice(newIndex, 0, layer!);
}

export function duplicateLayer(doc: Document, layerId: string, newName?: string): Layer {
  const src = findLayer(doc, layerId);
  const layer = addLayer(doc, newName ?? `${src.name} copy`, {
    blend: src.blend,
    index: layerIndex(doc, layerId) + 1,
    guide: src.guide,
    visible: src.visible,
  });
  for (let f = 0; f < doc.frames.length; f++) {
    const cel = getCel(doc, layerId, f);
    if (cel) doc.cels[celKey(layer.id, f)] = cel.slice();
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Frames

export function checkFrame(doc: Document, frame: number): void {
  if (!Number.isInteger(frame) || frame < 0 || frame >= doc.frames.length) {
    fail(`Frame ${frame} does not exist in "${doc.id}" (frames 0–${doc.frames.length - 1}).`);
  }
}

/**
 * Rebuilds the frame list. Each plan entry names the old frame whose cels it
 * takes (null = blank) and the new frame's metadata.
 */
export function rebuildFrames(doc: Document, plan: Array<{ src: number | null; frame: Frame }>): void {
  check(plan.length > 0, "A document needs at least one frame.");
  const cels: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  plan.forEach((entry, newIndex) => {
    if (entry.src === null) return;
    for (const layer of doc.layers) {
      const oldKey = celKey(layer.id, entry.src);
      const cel = doc.cels[oldKey];
      if (!cel) continue;
      cels[celKey(layer.id, newIndex)] = used.has(oldKey) ? cel.slice() : cel;
      used.add(oldKey);
    }
  });
  doc.frames = plan.map((p) => p.frame);
  doc.cels = cels;
}

export function addFrame(doc: Document, opts: { durationMs?: number; copyFrom?: number; index?: number } = {}): number {
  const index = opts.index ?? doc.frames.length;
  check(Number.isInteger(index) && index >= 0 && index <= doc.frames.length, `Frame index ${index} out of range 0–${doc.frames.length}`);
  if (opts.copyFrom !== undefined) checkFrame(doc, opts.copyFrom);
  const template = opts.copyFrom !== undefined ? doc.frames[opts.copyFrom]! : undefined;
  const frame: Frame = { durationMs: opts.durationMs ?? template?.durationMs ?? DEFAULT_FRAME_MS };
  if (template?.pivot) frame.pivot = { ...template.pivot };
  const plan = doc.frames.map((f, i) => ({ src: i as number | null, frame: f }));
  plan.splice(index, 0, { src: opts.copyFrom ?? null, frame });
  rebuildFrames(doc, plan);
  return index;
}

export function removeFrame(doc: Document, frame: number): void {
  checkFrame(doc, frame);
  check(doc.frames.length > 1, "Cannot remove the last frame.");
  const plan = doc.frames.map((f, i) => ({ src: i as number | null, frame: f })).filter((_, i) => i !== frame);
  rebuildFrames(doc, plan);
}

export function duplicateFrame(doc: Document, frame: number): number {
  checkFrame(doc, frame);
  const copy = structuredClone(doc.frames[frame]!);
  const plan = doc.frames.map((f, i) => ({ src: i as number | null, frame: f }));
  plan.splice(frame + 1, 0, { src: frame, frame: copy });
  rebuildFrames(doc, plan);
  return frame + 1;
}

export function moveFrame(doc: Document, from: number, to: number): void {
  checkFrame(doc, from);
  checkFrame(doc, to);
  const plan = doc.frames.map((f, i) => ({ src: i as number | null, frame: f }));
  const [entry] = plan.splice(from, 1);
  plan.splice(to, 0, entry!);
  rebuildFrames(doc, plan);
}

export interface TagRange {
  name: string;
  from: number;
  to: number;
  direction: TagDirection;
}

/** Tags as contiguous frame ranges, in frame order. */
export function getTagRanges(doc: Document): TagRange[] {
  const ranges: TagRange[] = [];
  doc.frames.forEach((frame, i) => {
    if (!frame.tag) return;
    const last = ranges[ranges.length - 1];
    if (last && last.name === frame.tag && last.to === i - 1) last.to = i;
    else ranges.push({ name: frame.tag, from: i, to: i, direction: doc.tagDirections?.[frame.tag] ?? "forward" });
  });
  return ranges;
}

/** Frames belonging to a tag (or all frames if tag is undefined). */
export function framesForTag(doc: Document, tag?: string): number[] {
  if (tag === undefined) return doc.frames.map((_, i) => i);
  const frames = doc.frames.map((f, i) => (f.tag === tag ? i : -1)).filter((i) => i >= 0);
  if (frames.length === 0) {
    const tags = [...new Set(doc.frames.map((f) => f.tag).filter(Boolean))];
    fail(`Document "${doc.id}" has no frames tagged "${tag}". Tags: ${tags.length ? tags.join(", ") : "(none)"}.`);
  }
  return frames;
}

/** Tags frames from..to (inclusive). The tag is removed from frames outside the range. Empty tag clears. */
export function tagFrames(doc: Document, tag: string, from: number, to: number, direction?: TagDirection): void {
  checkFrame(doc, from);
  checkFrame(doc, to);
  check(from <= to, "from must be <= to");
  if (tag !== "") {
    for (const f of doc.frames) if (f.tag === tag) delete f.tag;
  }
  for (let i = from; i <= to; i++) {
    if (tag === "") delete doc.frames[i]!.tag;
    else doc.frames[i]!.tag = tag;
  }
  if (tag !== "" && direction) {
    doc.tagDirections ??= {};
    doc.tagDirections[tag] = direction;
  }
}

// ---------------------------------------------------------------------------
// Pivots

export function defaultPivot(doc: Document): Point {
  return doc.kind === "character" ? { x: doc.width / 2, y: doc.height } : { x: doc.width / 2, y: doc.height / 2 };
}

export function framePivot(doc: Document, frame: number): Point {
  return doc.frames[frame]?.pivot ?? defaultPivot(doc);
}

// ---------------------------------------------------------------------------
// Compositing (indexed)

export type LayerFilter = (layer: Layer) => boolean;

/** Visible, non-guide layers with the given blend mode — what gets exported. */
export function exportLayers(blend: BlendMode): LayerFilter {
  return (l) => l.visible && !l.guide && l.blend === blend;
}

/** Flattens the selected layers of a frame: the top-most non-transparent pixel wins. */
export function compositeIndexed(doc: Document, frame: number, filter: LayerFilter = exportLayers("normal")): Uint8Array {
  const out = new Uint8Array(doc.width * doc.height);
  for (const layer of doc.layers) {
    if (!filter(layer)) continue;
    const cel = getCel(doc, layer.id, frame);
    if (!cel) continue;
    for (let i = 0; i < out.length; i++) {
      const v = cel[i]!;
      if (v !== 0) out[i] = v;
    }
  }
  return out;
}

export function hasContent(pixels: Uint8Array): boolean {
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Canvas resize

export const ANCHORS = [
  "top-left", "top", "top-center", "top-right",
  "left", "center-left", "center", "right", "center-right",
  "bottom-left", "bottom", "bottom-center", "bottom-right",
] as const;
export type Anchor = (typeof ANCHORS)[number];

export function anchorOffset(anchor: Anchor, oldW: number, oldH: number, newW: number, newH: number): Point {
  const horizontal = anchor.includes("left") ? "left" : anchor.includes("right") ? "right" : "center";
  const vertical = anchor.startsWith("top") ? "top" : anchor.startsWith("bottom") ? "bottom" : "center";
  const dx = horizontal === "left" ? 0 : horizontal === "right" ? newW - oldW : Math.floor((newW - oldW) / 2);
  const dy = vertical === "top" ? 0 : vertical === "bottom" ? newH - oldH : Math.floor((newH - oldH) / 2);
  return { x: dx, y: dy };
}

/** Resizes the canvas, keeping content anchored. Pivots and rig points move with the content. */
export function resizeCanvas(doc: Document, width: number, height: number, anchor: Anchor): Point {
  check(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 4096 && height <= 4096, `Invalid canvas size ${width}x${height}`);
  const off = anchorOffset(anchor, doc.width, doc.height, width, height);
  const cels: Record<string, Uint8Array> = {};
  for (const [key, cel] of Object.entries(doc.cels)) {
    const out = new Uint8Array(width * height);
    for (let y = 0; y < doc.height; y++) {
      const ny = y + off.y;
      if (ny < 0 || ny >= height) continue;
      for (let x = 0; x < doc.width; x++) {
        const nx = x + off.x;
        if (nx < 0 || nx >= width) continue;
        out[ny * width + nx] = cel[y * doc.width + x]!;
      }
    }
    cels[key] = out;
  }
  doc.cels = cels;
  doc.width = width;
  doc.height = height;
  const shift = (p: Point | undefined) => {
    if (p) {
      p.x += off.x;
      p.y += off.y;
    }
  };
  for (const f of doc.frames) shift(f.pivot);
  if (doc.rig) {
    for (const part of doc.rig.parts) {
      shift(part.pivot);
      shift(part.attachPoint);
      for (const o of Object.values(part.byDirection ?? {})) {
        shift(o.pivot);
        shift(o.attachPoint);
      }
    }
  }
  if (doc.symmetry) {
    doc.symmetry.axisX += off.x;
    doc.symmetry.axisY += off.y;
  }
  if (doc.tileset && width === height) doc.tileset.tileSize = width;
  if (doc.icon && width === height) doc.icon.size = width;
  return off;
}
