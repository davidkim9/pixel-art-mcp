import { z } from "zod";
import { checkFrame, compositeIndexed, getCel, resolveLayerId } from "../document.js";
import type { Project } from "../project.js";
import {
  Painter,
  brushStamp,
  curvePoints,
  ellipsePoints,
  floodRegion,
  isWrapEnabled,
  linePoints,
  mirrorPoints,
  mulberry32,
  pixelPerfect,
  polygonPoints,
  polylinePoints,
  rectPoints,
  removeLCorners,
  strokePoints,
} from "../raster.js";
import type { BrushShape, Point } from "../raster.js";
import type { Document, SymmetryMode } from "../types.js";
import { fail } from "../util/errors.js";
import { checkColor, drawTarget, regionMask, withPreview, zColor, zDocId, zFrame, zLayerId, zPoint, zPreview, zRegion } from "./helpers.js";
import type { DrawTarget, Register } from "./helpers.js";

/** Codes for read_grid: stable for indices ≤ 61, then any free printable character. */
const STABLE_CODES = "123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const EXTRA_CODES = "!#$%&*+-:;<=>?@^~|/\\()[]{}'\",`";

export function gridCodes(used: number[], preset: Record<string, number> = {}): Map<number, string> {
  const codes = new Map<number, string>();
  const taken = new Set<string>([".", "_"]);
  for (const [ch, idx] of Object.entries(preset)) {
    if (ch.length === 1 && !taken.has(ch) && !codes.has(idx) && idx !== 0) {
      codes.set(idx, ch);
      taken.add(ch);
    }
  }
  const stable = used.every((i) => i <= STABLE_CODES.length) && Object.keys(preset).length === 0;
  const pool = [...STABLE_CODES, ...EXTRA_CODES];
  for (const idx of used) {
    if (idx === 0 || codes.has(idx)) continue;
    let ch: string | undefined;
    if (stable) ch = STABLE_CODES[idx - 1];
    else ch = pool.find((c) => !taken.has(c));
    if (!ch) fail("Too many distinct colors in the region for single-character codes; read a smaller region.");
    codes.set(idx, ch);
    taken.add(ch);
  }
  return codes;
}

/** Parses draw_grid-style rows into palette indices (null = leave unchanged). */
function parseGrid(project: Project, doc: Document, rows: string[], legendIn: Record<string, number>): Array<Array<number | null>> {
  const width = [...rows[0]!].length;
  rows.forEach((row, i) => {
    if ([...row].length !== width) fail(`Row ${i} has ${[...row].length} characters; all rows must have ${width}.`);
  });
  for (const [ch, idx] of Object.entries(legendIn)) {
    if ([...ch].length !== 1) fail(`Legend key "${ch}" must be a single character.`);
    if (ch === ".") fail("\".\" is reserved for \"leave unchanged\" and can't be in the legend.");
    checkColor(project, doc, idx, `Legend "${ch}"`);
  }
  const legend = new Map<string, number>(Object.entries(legendIn));
  legend.set("_", 0);
  const unknown = new Set<string>();
  for (const row of rows) for (const ch of row) if (ch !== "." && !legend.has(ch)) unknown.add(ch);
  if (unknown.size) {
    fail(`Characters not in legend: ${[...unknown].map((c) => JSON.stringify(c)).join(", ")}. Nothing was drawn.`);
  }
  return rows.map((row) => [...row].map((ch) => (ch === "." ? null : legend.get(ch)!)));
}

const zPoints = (min: number) => z.array(zPoint).min(min).transform((pts) => pts.map((p) => [p.x, p.y] as Point));
const zBrush = z.enum(["circle", "square", "diamond"]).optional().describe("Brush tip for strokes wider than 1px (default circle)");
const zTension = z.number().min(-1).max(1).optional().describe("Curve tension: 0 = Catmull-Rom (default), toward 1 = tighter/straighter");

function paint(t: DrawTarget, plot: (painter: Painter) => void) {
  const painter = new Painter(t.cel, t.doc.width, t.doc.height, { wrap: isWrapEnabled(t.doc), symmetry: t.doc.symmetry });
  plot(painter);
  return painter.commit();
}

export function registerDrawingTools(register: Register, project: Project): void {
  const base = { docId: zDocId, layerId: zLayerId, frame: zFrame, preview: zPreview };

  register({
    name: "draw_grid",
    title: "Draw grid",
    description:
      "PRIMARY DRAWING TOOL. Paints a block of pixels from text. rows: equal-length strings, top to bottom, starting at (x, y). " +
      "legend maps single characters to palette indices. \".\" always means \"leave unchanged\", \"_\" means transparent (index 0). " +
      "Example: {\"x\":4,\"y\":2,\"legend\":{\"o\":1,\"s\":13,\"h\":15},\"rows\":[\"_ooo_\",\"osssh\",\"osssh\",\"_ooo_\"]}. " +
      "Symmetry and wrap mode apply.",
    input: {
      ...base,
      x: z.number().int(),
      y: z.number().int(),
      rows: z.array(z.string()).min(1),
      legend: z.record(z.string(), z.number().int().min(0).max(255)),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const cells = parseGrid(project, t.doc, args.rows, args.legend);
      const result = paint(t, (painter) => {
        cells.forEach((row, dy) => row.forEach((c, dx) => c !== null && painter.plot(args.x + dx, args.y + dy, c)));
      });
      return withPreview(project, t.doc, t.frame, args.preview, { ...result, size: { w: cells[0]!.length, h: cells.length } });
    },
  });

  register({
    name: "read_grid",
    title: "Read grid",
    description:
      "Read pixels back as text rows (one character per pixel, \"_\" = transparent) plus the legend used. Reads one layer, or the " +
      "flattened visible layers when layerId is omitted on a multi-layer document. Pass a legend to reuse your own character codes. " +
      "The returned legend can be fed straight back into draw_grid.",
    input: {
      docId: zDocId,
      layerId: z.string().optional(),
      frame: zFrame,
      x: z.number().int().min(0).optional(),
      y: z.number().int().min(0).optional(),
      w: z.number().int().min(1).optional(),
      h: z.number().int().min(1).optional(),
      legend: z.record(z.string(), z.number().int()).optional(),
    },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const frame = args.frame ?? 0;
      checkFrame(doc, frame);
      const drawable = doc.layers.filter((l) => !l.guide);
      let source: Uint8Array;
      let sourceName: string;
      if (args.layerId !== undefined || drawable.length === 1) {
        const id = resolveLayerId(doc, args.layerId);
        source = getCel(doc, id, frame) ?? new Uint8Array(doc.width * doc.height);
        sourceName = `layer ${id}`;
      } else {
        source = compositeIndexed(doc, frame, (l) => l.visible && !l.guide);
        sourceName = "flattened visible layers (normal and additive)";
      }
      const x0 = args.x ?? 0;
      const y0 = args.y ?? 0;
      const w = Math.min(args.w ?? doc.width - x0, doc.width - x0);
      const h = Math.min(args.h ?? doc.height - y0, doc.height - y0);
      if (w <= 0 || h <= 0) fail("Region is outside the canvas.");
      const used = new Set<number>();
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) used.add(source[y * doc.width + x]!);
      const codes = gridCodes([...used].sort((a, b) => a - b), args.legend);
      const rows: string[] = [];
      for (let y = y0; y < y0 + h; y++) {
        let row = "";
        for (let x = x0; x < x0 + w; x++) {
          const v = source[y * doc.width + x]!;
          row += v === 0 ? "_" : codes.get(v)!;
        }
        rows.push(row);
      }
      const legend: Record<string, number> = {};
      for (const [idx, ch] of [...codes.entries()].sort((a, b) => a[0] - b[0])) if (used.has(idx)) legend[ch] = idx;
      return { data: { source: sourceName, x: x0, y: y0, w, h, rows, legend, transparent: "_" } };
    },
  });

  register({
    name: "set_pixels",
    title: "Set pixels",
    description:
      "Set scattered pixels: [{x, y, c}] where c is a palette index. pixelPerfect: true treats the list as an ordered freehand stroke " +
      "and drops L-corner pixels (like Aseprite's pixel-perfect mode). Symmetry and wrap mode apply.",
    input: {
      ...base,
      pixels: z.array(z.object({ x: z.number().int(), y: z.number().int(), c: zColor })).min(1),
      pixelPerfect: z.boolean().optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      for (const p of args.pixels) checkColor(project, t.doc, p.c);
      let pixels = args.pixels;
      if (args.pixelPerfect) {
        const color = new Map(pixels.map((p) => [`${p.x},${p.y}`, p.c]));
        pixels = pixelPerfect(pixels.map((p) => [p.x, p.y] as Point)).map(([x, y]) => ({ x, y, c: color.get(`${x},${y}`)! }));
      }
      const result = paint(t, (painter) => pixels.forEach((p) => painter.plot(p.x, p.y, p.c)));
      return withPreview(project, t.doc, t.frame, args.preview, result);
    },
  });

  register({
    name: "draw_line",
    title: "Draw line",
    description: "Pixel-perfect 1px Bresenham line (8-connected, no doubled corners) from (x0,y0) to (x1,y1), endpoints included.",
    input: { ...base, x0: z.number().int(), y0: z.number().int(), x1: z.number().int(), y1: z.number().int(), c: zColor },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      checkColor(project, t.doc, args.c);
      const result = paint(t, (p) => linePoints(args.x0, args.y0, args.x1, args.y1).forEach(([x, y]) => p.plot(x, y, args.c)));
      return withPreview(project, t.doc, t.frame, args.preview, result);
    },
  });

  register({
    name: "draw_rect",
    title: "Draw rectangle",
    description: "Rectangle with top-left (x, y) and size w×h; outline only unless filled.",
    input: {
      ...base,
      x: z.number().int(),
      y: z.number().int(),
      w: z.number().int().min(1),
      h: z.number().int().min(1),
      c: zColor,
      filled: z.boolean().optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      checkColor(project, t.doc, args.c);
      const result = paint(t, (p) => rectPoints(args.x, args.y, args.w, args.h, args.filled ?? false).forEach(([x, y]) => p.plot(x, y, args.c)));
      return withPreview(project, t.doc, t.frame, args.preview, result);
    },
  });

  register({
    name: "draw_ellipse",
    title: "Draw ellipse",
    description:
      "Pixel-perfect ellipse covering pixel centers from cx-rx to cx+rx and cy-ry to cy+ry. Integer center + radius gives odd sizes " +
      "(cx=8, rx=3 → 7px wide); use .5 values for even sizes (cx=7.5, rx=3.5 → 8px wide).",
    input: {
      ...base,
      cx: z.number(),
      cy: z.number(),
      rx: z.number().min(0),
      ry: z.number().min(0),
      c: zColor,
      filled: z.boolean().optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      checkColor(project, t.doc, args.c);
      const x0 = Math.round(args.cx - args.rx);
      const x1 = Math.round(args.cx + args.rx);
      const y0 = Math.round(args.cy - args.ry);
      const y1 = Math.round(args.cy + args.ry);
      const result = paint(t, (p) => ellipsePoints(x0, y0, x1, y1, args.filled ?? false).forEach(([x, y]) => p.plot(x, y, args.c)));
      return withPreview(project, t.doc, t.frame, args.preview, { ...result, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } });
    },
  });

  register({
    name: "draw_path",
    title: "Draw path",
    description:
      "Stroke through a list of points: straight segments, or a smooth curve that passes through every point (curve: true). " +
      "1px strokes are pixel-perfect (no doubled L corners) unless pixelPerfect: false. width/widthEnd taper the stroke along its " +
      "length, which suits branches, roots, trunks, grass blades, tails and hair strands. Example (a branch thinning toward its tip): " +
      "{\"points\":[{\"x\":12,\"y\":28},{\"x\":14,\"y\":20},{\"x\":20,\"y\":14}],\"curve\":true,\"width\":3,\"widthEnd\":1,\"c\":5}. " +
      "Symmetry and wrap mode apply.",
    input: {
      ...base,
      points: zPoints(2),
      c: zColor,
      curve: z.boolean().optional(),
      tension: zTension,
      closed: z.boolean().optional(),
      width: z.number().int().min(1).max(32).optional().describe("Stroke diameter at the start (default 1)"),
      widthEnd: z.number().int().min(1).max(32).optional().describe("Stroke diameter at the end (default: width)"),
      brush: zBrush,
      pixelPerfect: z.boolean().optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      checkColor(project, t.doc, args.c);
      const closed = args.closed ?? false;
      const perfect = args.pixelPerfect ?? true;
      const path = args.curve ? curvePoints(args.points, closed, args.tension ?? 0, perfect) : polylinePoints(args.points, closed, perfect);
      const width = args.width ?? 1;
      const pixels = strokePoints(path, width, args.widthEnd ?? width, (args.brush ?? "circle") as BrushShape);
      const result = paint(t, (p) => pixels.forEach(([x, y]) => p.plot(x, y, args.c)));
      return withPreview(project, t.doc, t.frame, args.preview, { ...result, pathLength: path.length });
    },
  });

  register({
    name: "draw_polygon",
    title: "Draw polygon",
    description:
      "Closed shape through 3+ points (pixel centers): outline only, or filled. curve: true smooths the outline into a spline through " +
      "every point, which gives organic blobs: leaf clusters, canopy masses, bushes, rocks, clouds, puddles. Irregular point spacing " +
      "reads more natural than an ellipse. outline paints the edge in a second color over the fill. Symmetry and wrap mode apply.",
    input: {
      ...base,
      points: zPoints(3),
      c: zColor,
      filled: z.boolean().optional(),
      outline: zColor.optional().describe("Edge color drawn over the fill (default: c)"),
      curve: z.boolean().optional(),
      tension: zTension,
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      checkColor(project, t.doc, args.c);
      if (args.outline !== undefined) checkColor(project, t.doc, args.outline, "outline");
      const { outline, fill } = polygonPoints(args.points, args.filled ?? false, args.curve ?? false, args.tension ?? 0);
      const result = paint(t, (p) => {
        fill.forEach(([x, y]) => p.plot(x, y, args.c));
        outline.forEach(([x, y]) => p.plot(x, y, args.outline ?? args.c));
      });
      return withPreview(project, t.doc, t.frame, args.preview, result);
    },
  });

  register({
    name: "spray",
    title: "Spray",
    description:
      "Airbrush / scatter for organic texture: foliage clumps, broken leafy silhouettes, moss, speckles, sparkles, dirt. Sprays dabs " +
      "inside a circle (x, y, radius) or along a path (points, optionally curve: true). density ≈ fraction of the area covered (0–1). " +
      "colors picks randomly per dab (weights optional); size sets the dab diameter. Pass stamp {rows, legend} (draw_grid format) to " +
      "scatter a small motif such as a leaf cluster instead, randomly flipped unless randomFlip: false. within: \"opaque\" keeps " +
      "paint inside existing pixels on this layer (texture a canopy), \"transparent\" only paints empty pixels (grow a ragged edge). " +
      "falloff thins dabs toward the rim. The same seed reproduces the same result; the seed used is returned.",
    input: {
      ...base,
      x: z.number().optional(),
      y: z.number().optional(),
      radius: z.number().min(0.5).max(128).describe("Spray radius in pixels"),
      points: zPoints(1).optional().describe("Spray along this path instead of around (x, y)"),
      curve: z.boolean().optional(),
      colors: z.array(zColor).min(1).optional(),
      weights: z.array(z.number().min(0)).optional(),
      density: z.number().min(0).max(1).optional().describe("Approximate coverage, 0–1 (default 0.3)"),
      falloff: z.enum(["none", "linear", "smooth"]).optional().describe("Thin out toward the rim (default smooth)"),
      size: z.number().int().min(1).max(8).optional().describe("Dab diameter in pixels (default 1)"),
      brush: zBrush,
      stamp: z.object({ rows: z.array(z.string()).min(1), legend: z.record(z.string(), z.number().int().min(0).max(255)) }).optional(),
      randomFlip: z.boolean().optional(),
      within: z.enum(["any", "opaque", "transparent"]).optional(),
      region: zRegion,
      seed: z.number().int().optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const { width: w, height: h } = t.doc;
      if (!args.points && (args.x === undefined || args.y === undefined)) fail("Give a center (x, y) or a path (points).");
      if (!args.colors && !args.stamp) fail("Give colors to spray, or a stamp to scatter.");
      for (const c of args.colors ?? []) checkColor(project, t.doc, c);
      if (args.weights && args.weights.length !== args.colors?.length) fail("weights must have one entry per color.");
      const stamp = args.stamp ? parseGrid(project, t.doc, args.stamp.rows, args.stamp.legend) : null;

      const seed = args.seed ?? Math.floor(Math.random() * 2 ** 31);
      const rand = mulberry32(seed);
      const r = args.radius;
      const centers: Point[] = args.points
        ? args.curve ? curvePoints(args.points, false) : polylinePoints(args.points, false)
        : [[args.x!, args.y!]];
      const dab = brushStamp(args.size ?? 1, (args.brush ?? "circle") as BrushShape);
      const dabArea = stamp ? Math.max(1, stamp.flat().filter((c) => c !== null).length) : dab.length;
      const area = Math.PI * r * r + 2 * r * (centers.length - 1);
      const attempts = Math.round(((args.density ?? 0.3) * area) / dabArea);
      const falloff = args.falloff ?? "smooth";
      const weights = args.weights ?? args.colors?.map(() => 1) ?? [];
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      if (args.colors && totalWeight <= 0) fail("weights must not all be zero.");
      const pickColor = () => {
        let v = rand() * totalWeight;
        for (let i = 0; i < weights.length; i++) if ((v -= weights[i]!) < 0) return args.colors![i]!;
        return args.colors![args.colors!.length - 1]!;
      };

      const wrap = isWrapEnabled(t.doc);
      const orig = t.cel.slice();
      const mask = regionMask(project, t.doc, args.region);
      const within = args.within ?? "any";
      const allowed = (x: number, y: number) => {
        if (wrap) {
          x = ((x % w) + w) % w;
          y = ((y % h) + h) % h;
        } else if (x < 0 || y < 0 || x >= w || y >= h) return true; // let the painter count it out of bounds
        const p = y * w + x;
        if (mask && !mask[p]) return false;
        if (within === "opaque") return orig[p] !== 0;
        if (within === "transparent") return orig[p] === 0;
        return true;
      };

      let dabs = 0;
      const result = paint(t, (painter) => {
        const put = (x: number, y: number, c: number) => allowed(x, y) && painter.plot(x, y, c);
        for (let i = 0; i < attempts; i++) {
          const [cx, cy] = centers[Math.floor(rand() * centers.length)]!;
          const angle = rand() * Math.PI * 2;
          const dist = r * Math.sqrt(rand());
          const f = dist / r;
          const keep = falloff === "none" ? 1 : falloff === "linear" ? 1 - f : 1 - f * f * (3 - 2 * f);
          if (rand() >= keep) continue;
          const x = Math.round(cx + Math.cos(angle) * dist);
          const y = Math.round(cy + Math.sin(angle) * dist);
          dabs++;
          if (stamp) {
            const flipX = args.randomFlip !== false && rand() < 0.5;
            const flipY = args.randomFlip !== false && rand() < 0.5;
            const sh = stamp.length;
            const sw = stamp[0]!.length;
            const ox = x - Math.floor(sw / 2);
            const oy = y - Math.floor(sh / 2);
            stamp.forEach((row, dy) =>
              row.forEach((c, dx) => c !== null && put(ox + (flipX ? sw - 1 - dx : dx), oy + (flipY ? sh - 1 - dy : dy), c)),
            );
          } else {
            const c = pickColor();
            for (const [dx, dy] of dab) put(x + dx, y + dy, c);
          }
        }
      });
      return withPreview(project, t.doc, t.frame, args.preview, { ...result, dabs, seed });
    },
  });

  register({
    name: "pixel_perfect",
    title: "Pixel-perfect cleanup",
    description:
      "Remove doubled L-corner pixels from 1px lines already on the layer (Aseprite's pixel-perfect, applied after the fact), e.g. " +
      "after hand-drawn draw_grid linework. A corner pixel only goes when the line stays connected without it; it takes the " +
      "background color outside the corner. Filled areas are left alone, but square corners of 1px outlines (rectangles) are " +
      "rounded too, so limit region or pass c to clean only lines of that index.",
    input: { ...base, region: zRegion, c: zColor.optional().describe("Only clean lines of this palette index") },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const removed = removeLCorners(t.cel, t.doc.width, t.doc.height, regionMask(project, t.doc, args.region), isWrapEnabled(t.doc), args.c);
      return withPreview(project, t.doc, t.frame, args.preview, { removed });
    },
  });

  register({
    name: "flood_fill",
    title: "Flood fill",
    description:
      "Paint bucket at (x, y). contiguous (default true) fills the 4-connected region of the same index (wrapping across edges in wrap mode); " +
      "false replaces that index everywhere in the layer. With symmetry, mirrored seed points are filled too.",
    input: { ...base, x: z.number().int(), y: z.number().int(), c: zColor, contiguous: z.boolean().optional() },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      checkColor(project, t.doc, args.c);
      const { width: w, height: h } = t.doc;
      if (args.x < 0 || args.y < 0 || args.x >= w || args.y >= h) fail(`(${args.x}, ${args.y}) is outside the ${w}x${h} canvas.`);
      const wrap = isWrapEnabled(t.doc);
      const seeds: Array<[number, number]> = [[args.x, args.y], ...mirrorPoints(t.doc.symmetry, args.x, args.y)];
      const targets = new Set<number>();
      for (const [sx, sy] of seeds) {
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        if (args.contiguous === false) {
          const idx = t.cel[sy * w + sx]!;
          for (let i = 0; i < t.cel.length; i++) if (t.cel[i] === idx) targets.add(i);
        } else {
          for (const p of floodRegion(t.cel, w, h, sx, sy, wrap)) targets.add(p);
        }
      }
      let changed = 0;
      for (const p of targets) {
        if (t.cel[p] !== args.c) {
          t.cel[p] = args.c;
          changed++;
        }
      }
      return withPreview(project, t.doc, t.frame, args.preview, { changed, regionSize: targets.size });
    },
  });

  register({
    name: "replace_color",
    title: "Replace color",
    description: "Replace every pixel of index `from` with `to`, in a region ({x,y,w,h} or \"selection\") or the whole layer.",
    input: { ...base, from: zColor, to: zColor, region: zRegion },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      checkColor(project, t.doc, args.to);
      const mask = regionMask(project, t.doc, args.region);
      let changed = 0;
      for (let i = 0; i < t.cel.length; i++) {
        if ((mask === null || mask[i]) && t.cel[i] === args.from && args.from !== args.to) {
          t.cel[i] = args.to;
          changed++;
        }
      }
      return withPreview(project, t.doc, t.frame, args.preview, { changed });
    },
  });

  register({
    name: "clear",
    title: "Clear",
    description: "Set pixels to transparent (index 0) in a region ({x,y,w,h} or \"selection\") or the whole layer.",
    input: { ...base, region: zRegion },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const mask = regionMask(project, t.doc, args.region);
      let changed = 0;
      for (let i = 0; i < t.cel.length; i++) {
        if ((mask === null || mask[i]) && t.cel[i] !== 0) {
          t.cel[i] = 0;
          changed++;
        }
      }
      return withPreview(project, t.doc, t.frame, args.preview, { changed });
    },
  });

  register({
    name: "set_symmetry",
    title: "Set symmetry",
    description:
      "Mirror all subsequent drawing (draw_grid, set_pixels, lines, paths, polygons, rects, ellipses, spray, fills). mode: none | horizontal (mirror left↔right) | " +
      "vertical (mirror top↔bottom) | both. axis {x?, y?} is the mirror line in canvas coordinates; default is the canvas center " +
      "(e.g. x=8 on a 16px canvas mirrors pixel 0↔15; x=7.5 mirrors around the center of pixel 7).",
    input: {
      docId: zDocId,
      mode: z.enum(["none", "horizontal", "vertical", "both"]),
      axis: z.object({ x: z.number().optional(), y: z.number().optional() }).optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const sym = {
        mode: args.mode as SymmetryMode,
        axisX: args.axis?.x ?? doc.width / 2,
        axisY: args.axis?.y ?? doc.height / 2,
      };
      if (!Number.isInteger(sym.axisX * 2) || !Number.isInteger(sym.axisY * 2)) fail("Symmetry axes must be whole or half pixels (e.g. 8 or 7.5).");
      if (sym.mode === "none") delete doc.symmetry;
      else doc.symmetry = sym;
      return { data: { symmetry: doc.symmetry ?? { mode: "none" } } };
    },
  });
}
