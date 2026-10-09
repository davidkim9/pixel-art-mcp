import type { TagDirection } from "../types.js";
import { fail } from "../util/errors.js";

/** A frame cut from a sheet: source rect, placed at (offsetX, offsetY) on the frame canvas. */
export interface SliceRect {
  x: number;
  y: number;
  w: number;
  h: number;
  offsetX: number;
  offsetY: number;
}

export type XY = number | { x: number; y: number };
const ax = (v: XY | undefined, axis: "x" | "y") => (v === undefined ? 0 : typeof v === "number" ? v : v[axis]);

export interface GridSpec {
  frameWidth: number;
  frameHeight: number;
  margin?: XY;
  spacing?: XY;
  count?: number;
}

/** Row-major cells of a uniform grid that fit inside W×H. */
export function gridRects(W: number, H: number, spec: GridSpec): SliceRect[] {
  const { frameWidth: fw, frameHeight: fh } = spec;
  if (!(fw >= 1 && fh >= 1)) fail("frameWidth and frameHeight must be positive.");
  const mx = ax(spec.margin, "x");
  const my = ax(spec.margin, "y");
  const sx = ax(spec.spacing, "x");
  const sy = ax(spec.spacing, "y");
  const rects: SliceRect[] = [];
  for (let y = my; y + fh <= H; y += fh + sy) {
    for (let x = mx; x + fw <= W; x += fw + sx) rects.push({ x, y, w: fw, h: fh, offsetX: 0, offsetY: 0 });
  }
  if (!rects.length) fail(`A ${fw}x${fh} grid doesn't fit in the ${W}x${H} image.`);
  if (spec.count !== undefined) {
    if (spec.count > rects.length) fail(`count ${spec.count} exceeds the ${rects.length} cells that fit.`);
    return rects.slice(0, spec.count);
  }
  return rects;
}

export interface AxisCandidate {
  size: number;
  margin: number;
  spacing: number;
  count: number;
  kind: "uniform" | "period" | "single";
}

function runs(profile: boolean[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  profile.forEach((v, i) => {
    if (v && start < 0) start = i;
    if (!v && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  });
  if (start >= 0) out.push([start, profile.length]);
  return out;
}

/** Possible frame sizes along one axis, from the transparent gutters between content. */
export function axisCandidates(profile: boolean[]): AxisCandidate[] {
  const N = profile.length;
  const content = runs(profile);
  if (!content.length) return [];
  const lead = content[0]![0];
  const trail = N - content[content.length - 1]![1];
  if (content.length === 1) {
    const out: AxisCandidate[] = [{ size: N, margin: 0, spacing: 0, count: 1, kind: "single" }];
    if (lead > 0 && lead === trail) out.push({ size: N - 2 * lead, margin: lead, spacing: 0, count: 1, kind: "single" });
    return out;
  }
  const cands: AxisCandidate[] = [];
  // Evenly sized content separated by even gutters: frames are the content, gutters are spacing
  // (trailing empty cells allowed).
  const widths = content.map(([a, b]) => b - a);
  const gaps = content.slice(1).map(([a], i) => a - content[i]![1]);
  if (widths.every((w) => w === widths[0]) && gaps.every((g) => g === gaps[0])) {
    const pitch = widths[0]! + gaps[0]!;
    const extra = trail - lead;
    if (extra >= 0 && extra % pitch === 0) {
      cands.push({ size: widths[0]!, margin: lead, spacing: gaps[0]!, count: content.length + extra / pitch, kind: "uniform" });
    }
  }
  // Periodic cells without spacing: no content crosses a cell boundary, every cell has content,
  // and every cell holds the same number of separate pieces.
  const maxRun = Math.max(...widths);
  const periods: number[] = [];
  for (let p = maxRun; p < N; p++) {
    if (N % p !== 0) continue;
    if (periods.some((q) => p % q === 0)) continue; // a multiple of a finer valid grid
    if (content.some(([a, b]) => Math.floor(a / p) !== Math.floor((b - 1) / p))) continue;
    const perCell = new Map<number, number>();
    for (const [a] of content) perCell.set(Math.floor(a / p), (perCell.get(Math.floor(a / p)) ?? 0) + 1);
    if (perCell.size !== N / p) continue;
    periods.push(p);
    if (new Set(perCell.values()).size !== 1) continue;
    cands.push({ size: p, margin: 0, spacing: 0, count: N / p, kind: "period" });
  }
  if (!cands.length) cands.push({ size: N, margin: 0, spacing: 0, count: 1, kind: "single" });
  return cands;
}

export interface GridDetection {
  confident: boolean;
  proposal: GridSpec;
  alternatives: GridSpec[];
  reason: string;
}

function toSpec(a: AxisCandidate, b: AxisCandidate): GridSpec {
  const spec: GridSpec = { frameWidth: a.size, frameHeight: b.size };
  if (a.margin || b.margin) spec.margin = a.margin === b.margin ? a.margin : { x: a.margin, y: b.margin };
  // Spacing is irrelevant on an axis with a single cell; reuse the other axis's value.
  const sx = a.count === 1 ? b.spacing : a.spacing;
  const sy = b.count === 1 ? sx : b.spacing;
  if (sx || sy) spec.spacing = sx === sy ? sx : { x: sx, y: sy };
  return spec;
}

/** Detects a uniform frame grid from fully transparent rows/columns between frames. */
export function detectGrid(opaque: (x: number, y: number) => boolean, W: number, H: number): GridDetection {
  const cols = Array.from({ length: W }, (_, x) => {
    for (let y = 0; y < H; y++) if (opaque(x, y)) return true;
    return false;
  });
  const rows = Array.from({ length: H }, (_, y) => {
    for (let x = 0; x < W; x++) if (opaque(x, y)) return true;
    return false;
  });
  const cx = axisCandidates(cols);
  const cy = axisCandidates(rows);
  if (!cx.length || !cy.length) {
    return { confident: false, proposal: { frameWidth: W, frameHeight: H }, alternatives: [], reason: "The image is fully transparent." };
  }
  let pairs = cx.flatMap((a) => cy.map((b) => [a, b] as const));
  // Margins should agree between axes (spacing too, unless an axis has a single cell).
  const consistent = pairs.filter(([a, b]) => a.margin === b.margin && (a.count === 1 || b.count === 1 || a.spacing === b.spacing));
  if (consistent.length) pairs = consistent;
  const [first, ...rest] = pairs.map(([a, b]) => ({ spec: toSpec(a, b), cells: a.count * b.count }));
  const trivial = first!.cells === 1;
  const confident = rest.length === 0 && !trivial;
  return {
    confident,
    proposal: first!.spec,
    alternatives: rest.map((r) => r.spec),
    reason: trivial
      ? "No transparent gutters separate frames; pass explicit frameWidth/frameHeight (or use \"none\")."
      : confident
        ? "Unique grid consistent with the transparent gutters."
        : "Several grids fit the transparent gutters; re-run with explicit frameWidth/frameHeight.",
  };
}

// ---------------------------------------------------------------------------
// Aseprite-exported sheet JSON (hash or array format)

export interface AseJsonFrame {
  filename: string;
  rect: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  duration: number;
}

export interface AseJson {
  frames: AseJsonFrame[];
  tags: Array<{ name: string; from: number; to: number; direction: TagDirection }>;
  slices: Array<{ name: string; keys: Array<{ frame: number; bounds: { x: number; y: number; w: number; h: number }; pivot?: { x: number; y: number } }> }>;
  image?: string;
}

const JSON_DIRECTIONS: Record<string, TagDirection> = {
  forward: "forward",
  reverse: "reverse",
  pingpong: "pingpong",
  pingpong_reverse: "pingpong_reverse",
  "ping-pong": "pingpong",
};

export function parseAsepriteJson(text: string): AseJson {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    fail(`Invalid Aseprite JSON: ${(e as Error).message}`);
  }
  if (!data || typeof data !== "object" || !data.frames) fail("Not an Aseprite sheet JSON (no \"frames\").");
  const entries: Array<[string, any]> = Array.isArray(data.frames)
    ? data.frames.map((f: any, i: number) => [f.filename ?? String(i), f])
    : Object.entries(data.frames);
  const frames = entries.map(([filename, f]) => {
    if (!f?.frame) fail(`Frame "${filename}" has no "frame" rect.`);
    const rect = { x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h };
    return {
      filename,
      rect,
      rotated: Boolean(f.rotated),
      trimmed: Boolean(f.trimmed),
      spriteSourceSize: f.spriteSourceSize ?? { x: 0, y: 0, w: rect.w, h: rect.h },
      sourceSize: f.sourceSize ?? { w: rect.w, h: rect.h },
      duration: typeof f.duration === "number" ? f.duration : 100,
    };
  });
  const tags = (data.meta?.frameTags ?? []).map((t: any) => ({
    name: String(t.name),
    from: t.from,
    to: t.to,
    direction: JSON_DIRECTIONS[String(t.direction ?? "forward").toLowerCase()] ?? "forward",
  }));
  const slices = (data.meta?.slices ?? []).map((s: any) => ({ name: String(s.name), keys: s.keys ?? [] }));
  return { frames, tags, slices, image: data.meta?.image };
}
