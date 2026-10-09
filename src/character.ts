/** Layered (cutout / paper-doll) characters (spec §7). */
import { addLayer, ensureCel, getCel, hasContent, rebuildFrames } from "./document.js";
import type { Document, Point, Pose, PosePart, Rig, RigPart } from "./types.js";
import { check, fail } from "./util/errors.js";

export const DEFAULT_PARTS = ["foot_l", "foot_r", "body", "hand_l", "hand_r", "head"];
export const DEFAULT_DIRECTIONS = ["down", "up", "left", "right"];

/** Back → front defaults for the standard parts; far-side limbs go behind the body. */
const STANDARD_ORDER: Record<string, string[]> = {
  down: ["foot_l", "foot_r", "body", "hand_l", "hand_r", "head"],
  up: ["foot_l", "foot_r", "hand_l", "hand_r", "body", "head"],
  left: ["hand_r", "foot_r", "body", "foot_l", "head", "hand_l"],
  right: ["hand_l", "foot_l", "body", "foot_r", "head", "hand_r"],
};

/** Swaps left/right tokens in an id: hand_l ↔ hand_r, arm_left_upper ↔ arm_right_upper. */
export function swapLeftRight(id: string): string {
  const swap: Record<string, string> = { l: "r", r: "l", left: "right", right: "left", L: "R", R: "L" };
  return id
    .split("_")
    .map((t) => swap[t] ?? t)
    .join("_");
}

/** Sets up a new character document: one layer per part, one frame per direction. */
export function setupCharacter(doc: Document, parts = DEFAULT_PARTS, directions = DEFAULT_DIRECTIONS): void {
  check(parts.length > 0, "A character needs at least one part.");
  check(directions.length > 0, "A character needs at least one direction.");
  check(new Set(directions).size === directions.length, "Directions must be unique.");
  doc.layers = [];
  for (const p of parts) addLayer(doc, p);
  doc.frames = directions.map((d) => ({ durationMs: 100, label: d }));
  doc.cels = {};
  const ids = doc.layers.map((l) => l.id);
  const center = { x: doc.width / 2, y: doc.height / 2 };
  const rigParts: RigPart[] = ids.map((id) => {
    const part: RigPart = { layerId: id, pivot: { ...center } };
    if (id !== "body" && ids.includes("body")) part.parent = "body";
    return part;
  });
  const drawOrder: Record<string, string[]> = {};
  for (const d of directions) {
    const standard = STANDARD_ORDER[d];
    drawOrder[d] = standard && ids.every((id) => standard.includes(id)) && standard.every((id) => ids.includes(id)) ? [...standard] : [...ids];
  }
  doc.rig = { parts: rigParts, directions: [...directions], drawOrder, poses: [] };
}

export function requireRig(doc: Document): Rig {
  if (!doc.rig) fail(`Document "${doc.id}" has no rig (create it with kind "character").`);
  return doc.rig;
}

export function directionFrame(doc: Document, direction: string): number {
  const rig = requireRig(doc);
  const i = rig.directions.indexOf(direction);
  if (i < 0) fail(`Unknown direction "${direction}". Directions: ${rig.directions.join(", ")}.`);
  if (i >= doc.frames.length) fail(`Direction "${direction}" has no frame (frame ${i} is missing).`);
  return i;
}

export function getPart(doc: Document, layerId: string): RigPart | undefined {
  return doc.rig?.parts.find((p) => p.layerId === layerId);
}

export function partPivot(part: RigPart, direction: string): Point {
  return part.byDirection?.[direction]?.pivot ?? part.pivot;
}

export function partAttach(part: RigPart, direction: string): Point {
  return part.byDirection?.[direction]?.attachPoint ?? part.attachPoint ?? partPivot(part, direction);
}

export function findPose(doc: Document, name: string): Pose {
  const rig = requireRig(doc);
  const pose = rig.poses.find((p) => p.name === name);
  if (!pose) fail(`No pose "${name}". Poses: ${rig.poses.map((p) => p.name).join(", ") || "(none — use define_pose)"}.`);
  return pose;
}

/** Pose parts as they apply to a direction (mirrored automatically for directions made by mirror_rig). */
export function posePartsFor(doc: Document, pose: Pose | undefined, direction: string): Record<string, PosePart> {
  if (!pose) return {};
  const mirrored = doc.rig?.mirrors?.[direction] !== undefined;
  if (!mirrored) return pose.parts;
  const out: Record<string, PosePart> = {};
  const layers = new Set(doc.layers.map((l) => l.id));
  for (const [id, p] of Object.entries(pose.parts)) {
    const swapped = swapLeftRight(id);
    out[layers.has(swapped) ? swapped : id] = { ...p, dx: -p.dx };
  }
  return out;
}

/** Visible, non-guide layer ids of a direction in draw order (back → front); undeclared layers go to the back. */
export function drawOrderFor(doc: Document, direction: string): string[] {
  const drawable = doc.layers.filter((l) => l.visible && !l.guide).map((l) => l.id);
  const declared = (doc.rig?.drawOrder[direction] ?? []).filter((id) => drawable.includes(id));
  return [...drawable.filter((id) => !declared.includes(id)), ...declared];
}

/** Effective offsets: a part moves with its parent chain. */
export function effectiveOffsets(doc: Document, parts: Record<string, PosePart>): Map<string, Point> {
  const result = new Map<string, Point>();
  const resolve = (id: string, depth: number): Point => {
    const cached = result.get(id);
    if (cached) return cached;
    const own = parts[id] ?? { dx: 0, dy: 0 };
    const parent = getPart(doc, id)?.parent;
    let off = { x: own.dx, y: own.dy };
    if (parent && parent !== id && depth < 32 && doc.layers.some((l) => l.id === parent)) {
      const p = resolve(parent, depth + 1);
      off = { x: off.x + p.x, y: off.y + p.y };
    }
    result.set(id, off);
    return off;
  };
  for (const l of doc.layers) resolve(l.id, 0);
  return result;
}

/** A part's pixels moved by an offset (and optionally flipped around its pivot), clipped to the canvas. */
export function placePart(doc: Document, layerId: string, frame: number, offset: Point, flipX: boolean, pivotX: number): { pixels: Uint8Array; clipped: number } {
  const src = getCel(doc, layerId, frame);
  const out = new Uint8Array(doc.width * doc.height);
  let clipped = 0;
  if (!src) return { pixels: out, clipped };
  for (let y = 0; y < doc.height; y++) {
    for (let x = 0; x < doc.width; x++) {
      const v = src[y * doc.width + x]!;
      if (v === 0) continue;
      const fx = flipX ? Math.round(2 * pivotX - x - 1) : x;
      const nx = fx + offset.x;
      const ny = y + offset.y;
      if (nx < 0 || ny < 0 || nx >= doc.width || ny >= doc.height) {
        clipped++;
        continue;
      }
      out[ny * doc.width + nx] = v;
    }
  }
  return { pixels: out, clipped };
}

export interface Assembled {
  pixels: Uint8Array;
  order: string[];
  clipped: number;
  warnings: string[];
  placed: Map<string, Uint8Array>;
  offsets: Map<string, Point>;
}

/** Composites the parts of one direction in draw order with a pose applied. */
export function assemble(doc: Document, direction: string, pose?: Pose): Assembled {
  const rig = requireRig(doc);
  const frame = directionFrame(doc, direction);
  const parts = posePartsFor(doc, pose, direction);
  const offsets = effectiveOffsets(doc, parts);
  const order = drawOrderFor(doc, direction);
  const missing = order.filter((id) => !(rig.drawOrder[direction] ?? []).includes(id));
  const warnings: string[] = [];
  if (missing.length && rig.drawOrder[direction]) warnings.push(`Not in the "${direction}" draw order (drawn at the back): ${missing.join(", ")}.`);
  const pixels = new Uint8Array(doc.width * doc.height);
  const placed = new Map<string, Uint8Array>();
  let clipped = 0;
  for (const id of order) {
    const pp = parts[id];
    if (pp?.hidden) continue;
    const part = getPart(doc, id);
    const pivotX = part ? partPivot(part, direction).x : doc.width / 2;
    const r = placePart(doc, id, frame, offsets.get(id)!, pp?.flipX ?? false, pivotX);
    clipped += r.clipped;
    placed.set(id, r.pixels);
    for (let i = 0; i < pixels.length; i++) if (r.pixels[i]) pixels[i] = r.pixels[i]!;
  }
  if (clipped) warnings.push(`${clipped} pixel(s) moved outside the canvas and were clipped.`);
  return { pixels, order, clipped, warnings, placed, offsets };
}

/** Parts that don't overlap their parent near the attach point (gaps appear when they move). */
export function overlapGaps(doc: Document, direction: string, assembled: Assembled): Array<{ part: string; parent: string; overlap: number }> {
  const gaps: Array<{ part: string; parent: string; overlap: number }> = [];
  for (const part of doc.rig?.parts ?? []) {
    if (!part.parent) continue;
    const child = assembled.placed.get(part.layerId);
    const parent = assembled.placed.get(part.parent);
    if (!child || !parent || !hasContent(child) || !hasContent(parent)) continue;
    const parentOffset = assembled.offsets.get(part.parent) ?? { x: 0, y: 0 };
    const a = partAttach(part, direction);
    const ax = a.x + parentOffset.x;
    const ay = a.y + parentOffset.y;
    let overlap = 0;
    for (let y = Math.ceil(ay - 2.5); y <= Math.floor(ay + 1.5); y++) {
      for (let x = Math.ceil(ax - 2.5); x <= Math.floor(ax + 1.5); x++) {
        if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) continue;
        const p = y * doc.width + x;
        if (child[p] && parent[p]) overlap++;
      }
    }
    if (overlap < 1) gaps.push({ part: part.layerId, parent: part.parent, overlap });
  }
  return gaps;
}

/** Rig warnings for validation: every direction, rest pose and every defined pose. */
export function rigWarnings(doc: Document): string[] {
  const rig = doc.rig;
  if (!rig) return [];
  const out = new Set<string>();
  for (const direction of rig.directions) {
    if (rig.directions.indexOf(direction) >= doc.frames.length) continue;
    for (const pose of [undefined, ...rig.poses]) {
      const a = assemble(doc, direction, pose);
      for (const g of overlapGaps(doc, direction, a)) {
        out.add(`"${g.part}" doesn't overlap its parent "${g.parent}" at the attach point (${direction}${pose ? `, pose ${pose.name}` : ", rest pose"}).`);
      }
    }
  }
  return [...out];
}

/** Generates `to` from `from`: flips parts, swaps _l/_r layers, mirrors pivots and swaps draw order sides. */
export function mirrorRig(doc: Document, from: string, to: string): { frame: number; swapped: string[]; added: boolean } {
  const rig = requireRig(doc);
  check(from !== to, "fromDirection and toDirection must differ.");
  const src = directionFrame(doc, from);
  let added = false;
  if (!rig.directions.includes(to)) {
    rig.directions.push(to);
    if (doc.frames.length < rig.directions.length) {
      const plan = doc.frames.map((f, i) => ({ src: i as number | null, frame: f }));
      plan.push({ src: null, frame: { durationMs: doc.frames[src]!.durationMs, label: to } });
      rebuildFrames(doc, plan);
    }
    added = true;
  }
  const dst = directionFrame(doc, to);
  doc.frames[dst]!.label = to;
  const ids = new Set(doc.layers.map((l) => l.id));
  const swapped: string[] = [];
  const W = doc.width;
  for (const layer of doc.layers) {
    if (layer.guide) continue;
    const target = ids.has(swapLeftRight(layer.id)) ? swapLeftRight(layer.id) : layer.id;
    if (target !== layer.id) swapped.push(`${layer.id}→${target}`);
    const cel = getCel(doc, layer.id, src);
    const out = new Uint8Array(W * doc.height);
    if (cel) for (let y = 0; y < doc.height; y++) for (let x = 0; x < W; x++) out[y * W + (W - 1 - x)] = cel[y * W + x]!;
    ensureCel(doc, target, dst).set(out);
  }
  for (const part of rig.parts) {
    const source = getPart(doc, swapLeftRight(part.layerId)) ?? part;
    const pivot = partPivot(source, from);
    const attach = partAttach(source, from);
    part.byDirection = {
      ...part.byDirection,
      [to]: { pivot: { x: W - pivot.x, y: pivot.y }, attachPoint: { x: W - attach.x, y: attach.y } },
    };
  }
  rig.drawOrder[to] = (rig.drawOrder[from] ?? doc.layers.map((l) => l.id)).map((id) => (ids.has(swapLeftRight(id)) ? swapLeftRight(id) : id));
  rig.mirrors = { ...rig.mirrors, [to]: from };
  return { frame: dst, swapped, added };
}
