import { z } from "zod";
import { assemble, directionFrame, findPose, getPart, mirrorRig, overlapGaps, partAttach, partPivot, requireRig } from "../character.js";
import { exportCharacter } from "../character-export.js";
import { findLayer } from "../document.js";
import { writeExport } from "../export/write.js";
import { paletteRgb } from "../palette.js";
import type { Project } from "../project.js";
import { affineFromIndices } from "../render/compose.js";
import { autoScale, clampScale, renderCanvasView, renderSheet } from "../render/previews.js";
import type { Highlight, SheetCell } from "../render/previews.js";
import type { Pose } from "../types.js";
import { fail } from "../util/errors.js";
import { zDocId, zPoint } from "./helpers.js";
import type { Register } from "./helpers.js";

export function registerCharacterTools(register: Register, project: Project): void {
  register({
    name: "define_rig_part",
    title: "Define rig part",
    description:
      "Set a part's pivot (rotation/anchor point, canvas pixels; continuous coordinates), optional parent (e.g. hand_l → body) and attachPoint " +
      "(where it sits on the parent). With direction, sets an override for that direction only. Parts move with their parent in poses.",
    input: {
      docId: zDocId,
      layerId: z.string(),
      pivot: zPoint,
      parent: z.string().nullable().optional().describe("parent layer id, or null to clear"),
      attachPoint: zPoint.optional(),
      direction: z.string().optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const rig = requireRig(doc);
      findLayer(doc, args.layerId);
      let part = getPart(doc, args.layerId);
      if (!part) {
        part = { layerId: args.layerId, pivot: { ...args.pivot } };
        rig.parts.push(part);
      }
      if (args.direction !== undefined) {
        directionFrame(doc, args.direction);
        part.byDirection = {
          ...part.byDirection,
          [args.direction]: { pivot: { ...args.pivot }, ...(args.attachPoint ? { attachPoint: { ...args.attachPoint } } : {}) },
        };
      } else {
        part.pivot = { ...args.pivot };
        if (args.attachPoint) part.attachPoint = { ...args.attachPoint };
      }
      if (args.parent === null) delete part.parent;
      else if (args.parent !== undefined) {
        findLayer(doc, args.parent);
        let cursor: string | undefined = args.parent;
        for (let depth = 0; cursor && depth < 64; depth++) {
          if (cursor === args.layerId) fail(`Parent "${args.parent}" would create a cycle.`);
          cursor = getPart(doc, cursor)?.parent;
        }
        part.parent = args.parent;
      }
      return { data: { part } };
    },
  });

  register({
    name: "set_draw_order",
    title: "Set draw order",
    description: "Layer ids back → front for one direction. Far-side limbs go behind the body (e.g. facing right: hand_l, foot_l, body, foot_r, head, hand_r).",
    input: { docId: zDocId, direction: z.string(), layerIds: z.array(z.string()).min(1) },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const rig = requireRig(doc);
      directionFrame(doc, args.direction);
      for (const id of args.layerIds) findLayer(doc, id);
      if (new Set(args.layerIds).size !== args.layerIds.length) fail("Each layer may appear only once.");
      rig.drawOrder[args.direction] = [...args.layerIds];
      const missing = doc.layers.filter((l) => !l.guide && l.visible && !args.layerIds.includes(l.id)).map((l) => l.id);
      return { data: { direction: args.direction, drawOrder: args.layerIds, warnings: missing.length ? [`Not listed (drawn at the back): ${missing.join(", ")}`] : [] } };
    },
  });

  register({
    name: "define_pose",
    title: "Define pose",
    description:
      "Define or replace a named pose (\"idle_0\", \"walk_1\"): per-part integer pixel offsets {dx, dy}, optional flipX (around the part's pivot) and hidden. " +
      "Offsets are relative to the parent (a moved body carries head and hands). Poses are mirrored automatically for directions created by mirror_rig.",
    input: {
      docId: zDocId,
      pose: z.object({
        name: z.string().min(1),
        parts: z.record(
          z.string(),
          z.object({ dx: z.number().int(), dy: z.number().int(), flipX: z.boolean().optional(), hidden: z.boolean().optional() }),
        ),
      }),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const rig = requireRig(doc);
      for (const id of Object.keys(args.pose.parts)) findLayer(doc, id);
      const pose: Pose = { name: args.pose.name, parts: structuredClone(args.pose.parts) };
      const i = rig.poses.findIndex((p) => p.name === pose.name);
      if (i >= 0) rig.poses[i] = pose;
      else rig.poses.push(pose);
      const warnings: string[] = [];
      for (const direction of rig.directions) {
        if (rig.directions.indexOf(direction) >= doc.frames.length) continue;
        const a = assemble(doc, direction, pose);
        for (const g of overlapGaps(doc, direction, a)) warnings.push(`${direction}: "${g.part}" no longer overlaps "${g.parent}" at its attach point.`);
        warnings.push(...a.warnings.map((w) => `${direction}: ${w}`));
      }
      return { data: { pose: pose.name, poses: rig.poses.map((p) => p.name), replaced: i >= 0, warnings } };
    },
  });

  register({
    name: "mirror_rig",
    title: "Mirror rig",
    description:
      "Generate one direction from another (e.g. left from right): flips every part horizontally, swaps _l/_r layers (hand_l ↔ hand_r), mirrors pivots " +
      "and attach points, and swaps the draw order's left/right parts. Adds the direction (and its frame) if it doesn't exist.",
    input: { docId: zDocId, fromDirection: z.string(), toDirection: z.string() },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const r = mirrorRig(doc, args.fromDirection, args.toDirection);
      return { data: { ...r, directions: doc.rig!.directions, drawOrder: doc.rig!.drawOrder[args.toDirection] } };
    },
  });

  register({
    name: "render_assembled",
    title: "Render assembled 🖼",
    description:
      "Character assembled from its parts in draw order with a pose applied. direction omitted → all directions side by side. pose may end in \"*\" " +
      "(e.g. \"walk_*\") to render every matching pose as a sequence. showPivots outlines each part's pivot pixel. Reports parts that stop overlapping their parent.",
    input: {
      docId: zDocId,
      pose: z.string().optional(),
      direction: z.string().optional(),
      scale: z.number().int().min(1).max(16).optional(),
      showPivots: z.boolean().optional(),
    },
    readOnly: true,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const rig = requireRig(doc);
      const palette = paletteRgb(project.paletteFor(doc));
      const directions = args.direction !== undefined ? [args.direction] : rig.directions.filter((_, i) => i < doc.frames.length);
      let poses: Array<Pose | undefined> = [undefined];
      if (args.pose?.endsWith("*")) {
        const prefix = args.pose.slice(0, -1);
        poses = rig.poses.filter((p) => p.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        if (!poses.length) fail(`No poses match "${args.pose}".`);
      } else if (args.pose) poses = [findPose(doc, args.pose)];
      const cells: SheetCell[] = [];
      const report: Array<{ direction: string; pose: string; drawOrder: string[]; gaps: unknown[]; warnings: string[] }> = [];
      for (const pose of poses) {
        for (const direction of directions) {
          const a = assemble(doc, direction, pose);
          const gaps = overlapGaps(doc, direction, a);
          const highlights: Highlight[] = [];
          if (args.showPivots) {
            for (const part of rig.parts) {
              const off = a.offsets.get(part.layerId) ?? { x: 0, y: 0 };
              const p = partPivot(part, direction);
              highlights.push({ x: Math.floor(p.x + off.x), y: Math.floor(p.y + off.y) });
              if (part.parent) {
                const at = partAttach(part, direction);
                const po = a.offsets.get(part.parent) ?? { x: 0, y: 0 };
                highlights.push({ x: Math.floor(at.x + po.x), y: Math.floor(at.y + po.y) });
              }
            }
          }
          cells.push({ buf: affineFromIndices(a.pixels, doc.width, doc.height, palette), title: direction, subtitle: pose?.name ?? "rest", highlights });
          report.push({ direction, pose: pose?.name ?? "rest", drawOrder: a.order, gaps, warnings: a.warnings });
        }
      }
      let image: Buffer;
      if (cells.length === 1) {
        const scale = clampScale(args.scale ?? autoScale(doc.width, doc.height), doc.width, doc.height, 40);
        image = renderCanvasView(cells[0]!.buf, { scale, grid: true, rulers: true, highlights: cells[0]!.highlights }).toPng();
      } else {
        const columns = directions.length === 1 ? cells.length : directions.length;
        const scale = clampScale(args.scale ?? autoScale(doc.width, doc.height, 160), doc.width * columns, doc.height);
        image = renderSheet(cells, scale, { columns }).toPng();
      }
      return { data: { renders: report }, images: [image] };
    },
  });

  register({
    name: "export_character",
    title: "Export character",
    description:
      "Export a character. mode \"atlas\" (default from project settings): one packed PNG with every part × direction cropped to its pixels; metadata " +
      "frames carry part, direction, offsetPx (crop position in the canvas), pivotPx/center at the part's pivot, plus a character block with parts, " +
      "parents, attach points, draw orders, mirrors and poses. mode \"parts\": name_<part>_<direction>.png per part plus one name.json.",
    input: { docId: zDocId, mode: z.enum(["atlas", "parts"]).optional(), name: z.string().optional() },
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const result = exportCharacter(project, doc, args);
      return { data: { ...writeExport(project, result), parts: result.metadata.frames.length, size: result.metadata.size } };
    },
  });
}
