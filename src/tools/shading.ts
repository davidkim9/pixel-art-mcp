import { z } from "zod";
import { addLayer, checkFrame, ensureCel, getCel, layerIndex, resolveLayerId } from "../document.js";
import { darkerInRamp, getRamp } from "../palette.js";
import type { Project } from "../project.js";
import { isWrapEnabled } from "../raster.js";
import {
  LIGHT_DIRECTIONS,
  ditherWrites,
  findOrphans,
  mostCommon,
  outlineWrites,
  radialGradientWrites,
  shadeWrites,
  shadowCel,
} from "../shading.js";
import type { LightDirection } from "../shading.js";
import { fail } from "../util/errors.js";
import { checkColor, drawTarget, regionMask, withPreview, zColor, zDocId, zFrame, zLayerId, zPreview, zRegion } from "./helpers.js";
import type { Register } from "./helpers.js";

function applyWrites(cel: Uint8Array, writes: Map<number, number>): number {
  let changed = 0;
  for (const [p, c] of writes) {
    if (cel[p] !== c) {
      cel[p] = c;
      changed++;
    }
  }
  return changed;
}

export function registerShadingTools(register: Register, project: Project): void {
  register({
    name: "auto_outline",
    title: "Auto outline",
    description:
      "Outline the layer's shapes. mode \"outside\" (default) paints transparent pixels touching the shape; \"inside\" recolors the shape's edge pixels. " +
      "connectivity 4 (default, no diagonal corners) or 8. selective: true uses the next darker ramp color of the adjacent fill instead of the flat color c " +
      "(falls back to c when the fill is in no ramp or already darkest). allFrames applies it to every frame.",
    input: {
      docId: zDocId,
      layerId: zLayerId,
      frame: zFrame,
      c: zColor,
      mode: z.enum(["outside", "inside"]).optional(),
      connectivity: z.union([z.literal(4), z.literal(8)]).optional(),
      selective: z.boolean().optional(),
      allFrames: z.boolean().optional(),
      preview: zPreview,
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      checkColor(project, t.doc, args.c);
      const palette = project.paletteFor(t.doc);
      const colorFor = args.selective
        ? (fills: number[]) => darkerInRamp(palette, mostCommon(fills)) ?? args.c
        : () => args.c;
      const frames = args.allFrames ? t.doc.frames.map((_, i) => i) : [t.frame];
      let changed = 0;
      for (const f of frames) {
        const cel = ensureCel(t.doc, t.layerId, f);
        const writes = outlineWrites(cel, t.doc.width, t.doc.height, {
          mode: args.mode ?? "outside",
          connectivity: args.connectivity ?? 4,
          wrap: isWrapEnabled(t.doc),
        }, colorFor);
        changed += applyWrites(cel, writes);
      }
      return withPreview(project, t.doc, t.frame, args.preview, { changed, frames: frames.length });
    },
  });

  register({
    name: "drop_shadow",
    title: "Drop shadow",
    description:
      "Write a hard drop shadow of a layer, offset by (dx, dy) (default 1, 1), in color c, to a layer named <layer>_shadow directly below it " +
      "(created or regenerated). Applies to every frame unless frame is given.",
    input: {
      docId: zDocId,
      layerId: z.string(),
      dx: z.number().int().optional(),
      dy: z.number().int().optional(),
      c: zColor,
      frame: z.number().int().min(0).optional(),
      preview: zPreview,
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const layerId = resolveLayerId(doc, args.layerId);
      checkColor(project, doc, args.c);
      const shadowName = `${layerId}_shadow`;
      let shadow = doc.layers.find((l) => l.id === shadowName);
      if (!shadow) shadow = addLayer(doc, shadowName, { id: shadowName, index: layerIndex(doc, layerId) });
      if (shadow.locked) fail(`Layer "${shadow.id}" is locked.`);
      const frames = args.frame !== undefined ? [args.frame] : doc.frames.map((_, i) => i);
      for (const f of frames) {
        checkFrame(doc, f);
        const src = getCel(doc, layerId, f);
        const out = src ? shadowCel(src, doc.width, doc.height, args.dx ?? 1, args.dy ?? 1, args.c, isWrapEnabled(doc)) : new Uint8Array(doc.width * doc.height);
        ensureCel(doc, shadow.id, f).set(out);
      }
      return withPreview(project, doc, args.frame ?? 0, args.preview, { shadowLayerId: shadow.id, frames: frames.length });
    },
  });

  register({
    name: "shade_with_ramp",
    title: "Shade with ramp",
    description:
      "Basic directional shading of a filled shape using a named ramp (dark → light): flat interiors get a middle step, edges facing the light the lightest, " +
      "edges facing away the darkest. lightDir: top-left (default) | top | top-right | left | right | bottom-left | bottom | bottom-right. " +
      "The shape is the non-transparent pixels in region; `targets` limits it to those indices (e.g. keep the outline). rim = bevel width in pixels. " +
      "A starting point to refine by hand.",
    input: {
      docId: zDocId,
      layerId: zLayerId,
      frame: zFrame,
      region: zRegion,
      rampName: z.string(),
      lightDir: z.enum(LIGHT_DIRECTIONS).optional(),
      targets: z.array(z.number().int()).optional(),
      rim: z.number().int().min(1).max(64).optional(),
      preview: zPreview,
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const ramp = getRamp(project.paletteFor(t.doc), args.rampName);
      const mask = regionMask(project, t.doc, args.region);
      const targets = args.targets ? new Set(args.targets) : undefined;
      const shape = new Uint8Array(t.cel.length);
      for (let i = 0; i < shape.length; i++) {
        if (t.cel[i] !== 0 && (mask === null || mask[i]) && (!targets || targets.has(t.cel[i]!))) shape[i] = 1;
      }
      const writes = shadeWrites(shape, t.doc.width, t.doc.height, ramp, (args.lightDir ?? "top-left") as LightDirection, args.rim);
      const changed = applyWrites(t.cel, writes);
      return withPreview(project, t.doc, t.frame, args.preview, { shaded: writes.size, changed });
    },
  });

  register({
    name: "radial_gradient",
    title: "Radial gradient",
    description:
      "Gradient around (cx, cy) quantized to a ramp: lightest at the center, darkest at `radius` (invert: true for the reverse). " +
      "dither: none | checker | bayer2 | bayer4 | bayer8 blends neighbouring ramp steps. onlyOpaque: true recolors only existing pixels " +
      "(block out a silhouette first, then color it). Core tool for glows and explosions.",
    input: {
      docId: zDocId,
      layerId: zLayerId,
      frame: zFrame,
      cx: z.number(),
      cy: z.number(),
      radius: z.number().positive(),
      rampName: z.string(),
      dither: z.enum(["none", "checker", "bayer2", "bayer4", "bayer8"]).optional(),
      onlyOpaque: z.boolean().optional(),
      invert: z.boolean().optional(),
      preview: zPreview,
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      const ramp = getRamp(project.paletteFor(t.doc), args.rampName);
      const writes = radialGradientWrites(t.cel, t.doc.width, t.doc.height, {
        cx: args.cx,
        cy: args.cy,
        radius: args.radius,
        ramp,
        dither: args.dither ?? "none",
        onlyOpaque: args.onlyOpaque ?? false,
        invert: args.invert ?? false,
      });
      const changed = applyWrites(t.cel, writes);
      return withPreview(project, t.doc, t.frame, args.preview, { painted: writes.size, changed });
    },
  });

  register({
    name: "dither_region",
    title: "Dither region",
    description:
      "Ordered dithering between two indices over a region ({x,y,w,h}, \"selection\" or whole canvas). ratio 0 = all c1, 1 = all c2, 0.5 = even mix. " +
      "pattern: checker | bayer2 | bayer4 | bayer8. onlyOpaque limits it to existing pixels.",
    input: {
      docId: zDocId,
      layerId: zLayerId,
      frame: zFrame,
      region: zRegion,
      c1: zColor,
      c2: zColor,
      pattern: z.enum(["checker", "bayer2", "bayer4", "bayer8"]),
      ratio: z.number().min(0).max(1),
      onlyOpaque: z.boolean().optional(),
      preview: zPreview,
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const t = drawTarget(project, args);
      checkColor(project, t.doc, args.c1, "c1");
      checkColor(project, t.doc, args.c2, "c2");
      const mask = regionMask(project, t.doc, args.region);
      const writes = ditherWrites(t.cel, t.doc.width, t.doc.height, mask, args.c1, args.c2, args.pattern, args.ratio, args.onlyOpaque ?? false);
      const changed = applyWrites(t.cel, writes);
      return withPreview(project, t.doc, t.frame, args.preview, { painted: writes.size, changed });
    },
  });

  register({
    name: "find_orphan_pixels",
    title: "Find orphan pixels",
    description: "Report isolated single pixels (no opaque neighbour in 8 directions) — usually noise. Checks one frame, or every frame if frame is omitted.",
    input: { docId: zDocId, layerId: zLayerId, frame: z.number().int().min(0).optional() },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const layerId = resolveLayerId(doc, args.layerId);
      const frames = args.frame !== undefined ? [args.frame] : doc.frames.map((_, i) => i);
      const results = frames.map((f) => {
        checkFrame(doc, f);
        const cel = getCel(doc, layerId, f);
        return { frame: f, pixels: cel ? findOrphans(cel, doc.width, doc.height, isWrapEnabled(doc)) : [] };
      });
      return { data: { layerId, total: results.reduce((s, r) => s + r.pixels.length, 0), frames: results.filter((r) => r.pixels.length) } };
    },
  });
}
