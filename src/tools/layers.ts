import { z } from "zod";
import {
  addFrame,
  addLayer,
  checkFrame,
  duplicateFrame,
  duplicateLayer,
  findLayer,
  getTagRanges,
  moveFrame,
  removeFrame,
  removeLayer,
  reorderLayer,
  tagFrames,
} from "../document.js";
import type { Project } from "../project.js";
import { TAG_DIRECTIONS } from "../types.js";
import { fail } from "../util/errors.js";
import { zDocId } from "./helpers.js";
import type { Register } from "./helpers.js";

export function registerLayerFrameTools(register: Register, project: Project): void {
  const layerList = (docId: string) => project.getDoc(docId).layers.map((l, i) => ({ index: i, id: l.id, name: l.name, visible: l.visible, blend: l.blend, ...(l.guide ? { guide: true } : {}) }));

  register({
    name: "add_layer",
    title: "Add layer",
    description: "Add a layer (on top unless index is given; 0 = bottom). blend \"additive\" marks a glow layer, exported separately as name_glow.png.",
    input: {
      docId: zDocId,
      name: z.string().min(1),
      blend: z.enum(["normal", "additive"]).optional(),
      index: z.number().int().min(0).optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const layer = addLayer(doc, args.name, { blend: args.blend, index: args.index });
      return { data: { layerId: layer.id, layers: layerList(doc.id) } };
    },
  });

  register({
    name: "remove_layer",
    title: "Remove layer",
    description: "Delete a layer and its pixels in every frame.",
    input: { docId: zDocId, layerId: z.string() },
    destructive: true,
    mutates: (a) => a.docId,
    handler: (args) => {
      removeLayer(project.getDoc(args.docId), args.layerId);
      return { data: { layers: layerList(args.docId) } };
    },
  });

  register({
    name: "rename_layer",
    title: "Rename layer",
    description: "Change a layer's display name (its id stays the same).",
    input: { docId: zDocId, layerId: z.string(), name: z.string().min(1) },
    mutates: (a) => a.docId,
    handler: (args) => {
      findLayer(project.getDoc(args.docId), args.layerId).name = args.name;
      return { data: { layers: layerList(args.docId) } };
    },
  });

  register({
    name: "reorder_layer",
    title: "Reorder layer",
    description: "Move a layer to newIndex in the stack (0 = bottom).",
    input: { docId: zDocId, layerId: z.string(), newIndex: z.number().int().min(0) },
    mutates: (a) => a.docId,
    handler: (args) => {
      reorderLayer(project.getDoc(args.docId), args.layerId, args.newIndex);
      return { data: { layers: layerList(args.docId) } };
    },
  });

  register({
    name: "set_layer_visibility",
    title: "Set layer visibility",
    description: "Show or hide a layer. Hidden layers are never exported.",
    input: { docId: zDocId, layerId: z.string(), visible: z.boolean() },
    mutates: (a) => a.docId,
    handler: (args) => {
      findLayer(project.getDoc(args.docId), args.layerId).visible = args.visible;
      return { data: { layers: layerList(args.docId) } };
    },
  });

  register({
    name: "duplicate_layer",
    title: "Duplicate layer",
    description: "Copy a layer (all frames) directly above the original.",
    input: { docId: zDocId, layerId: z.string(), newName: z.string().optional() },
    mutates: (a) => a.docId,
    handler: (args) => {
      const layer = duplicateLayer(project.getDoc(args.docId), args.layerId, args.newName);
      return { data: { layerId: layer.id, layers: layerList(args.docId) } };
    },
  });

  register({
    name: "set_layer_properties",
    title: "Set layer properties",
    description: "Lock/unlock a layer, change its blend mode, or mark it as a guide layer (shown faintly in previews, never exported).",
    input: {
      docId: zDocId,
      layerId: z.string(),
      locked: z.boolean().optional(),
      blend: z.enum(["normal", "additive"]).optional(),
      guide: z.boolean().optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const layer = findLayer(project.getDoc(args.docId), args.layerId);
      if (args.locked !== undefined) layer.locked = args.locked;
      if (args.blend !== undefined) layer.blend = args.blend;
      if (args.guide !== undefined) {
        if (args.guide) layer.guide = true;
        else delete layer.guide;
      }
      return { data: { layer } };
    },
  });

  // ---------------------------------------------------------------------------
  // Frames

  const frameList = (docId: string) => {
    const doc = project.getDoc(docId);
    return { frames: doc.frames.map((f, i) => ({ index: i, ...f })), tags: getTagRanges(doc) };
  };

  register({
    name: "add_frame",
    title: "Add frame",
    description: "Add a frame at the end (or at index). copyFrom copies another frame's pixels; durationMs defaults to the copied frame's or 100.",
    input: {
      docId: zDocId,
      durationMs: z.number().int().min(1).optional(),
      copyFrom: z.number().int().min(0).optional(),
      index: z.number().int().min(0).optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const frame = addFrame(doc, { durationMs: args.durationMs, copyFrom: args.copyFrom, index: args.index });
      project.selections.delete(doc.id);
      return { data: { frame, ...frameList(doc.id) } };
    },
  });

  register({
    name: "remove_frame",
    title: "Remove frame",
    description: "Delete a frame (all layers).",
    input: { docId: zDocId, frame: z.number().int().min(0) },
    destructive: true,
    mutates: (a) => a.docId,
    handler: (args) => {
      removeFrame(project.getDoc(args.docId), args.frame);
      return { data: frameList(args.docId) };
    },
  });

  register({
    name: "duplicate_frame",
    title: "Duplicate frame",
    description: "Copy a frame (pixels, duration, tag) right after itself.",
    input: { docId: zDocId, frame: z.number().int().min(0) },
    mutates: (a) => a.docId,
    handler: (args) => {
      const frame = duplicateFrame(project.getDoc(args.docId), args.frame);
      return { data: { frame, ...frameList(args.docId) } };
    },
  });

  register({
    name: "move_frame",
    title: "Move frame",
    description: "Move a frame from one position to another.",
    input: { docId: zDocId, from: z.number().int().min(0), to: z.number().int().min(0) },
    mutates: (a) => a.docId,
    handler: (args) => {
      moveFrame(project.getDoc(args.docId), args.from, args.to);
      return { data: frameList(args.docId) };
    },
  });

  register({
    name: "set_frame_duration",
    title: "Set frame duration",
    description: "Set the duration of one frame, or of frames frame..to (inclusive).",
    input: { docId: zDocId, frame: z.number().int().min(0), ms: z.number().int().min(1), to: z.number().int().min(0).optional() },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const to = args.to ?? args.frame;
      checkFrame(doc, args.frame);
      checkFrame(doc, to);
      if (to < args.frame) fail("to must be >= frame");
      for (let i = args.frame; i <= to; i++) doc.frames[i]!.durationMs = args.ms;
      return { data: frameList(doc.id) };
    },
  });

  register({
    name: "tag_frames",
    title: "Tag frames",
    description:
      "Name an animation range (\"idle\", \"walk\", \"explode\"): frames from..to inclusive. Re-tagging moves the tag (it is removed from frames outside the range). " +
      "An empty tag clears tags in the range. direction: forward | reverse | pingpong | pingpong_reverse.",
    input: {
      docId: zDocId,
      tag: z.string(),
      from: z.number().int().min(0),
      to: z.number().int().min(0),
      direction: z.enum(TAG_DIRECTIONS).optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      tagFrames(project.getDoc(args.docId), args.tag, args.from, args.to, args.direction);
      return { data: frameList(args.docId) };
    },
  });

  register({
    name: "set_pivot",
    title: "Set pivot",
    description:
      "Set the pivot (anchor) in canvas pixels for all frames, or for frames frame..to. Coordinates are continuous: (0,0) is the top-left corner, " +
      "(width/2, height) is bottom-center (feet). Exported as pivotPx in the metadata. Default: center (characters: bottom-center).",
    input: {
      docId: zDocId,
      x: z.number(),
      y: z.number(),
      frame: z.number().int().min(0).optional(),
      to: z.number().int().min(0).optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const from = args.frame ?? 0;
      const to = args.frame === undefined ? doc.frames.length - 1 : (args.to ?? args.frame);
      checkFrame(doc, from);
      checkFrame(doc, to);
      for (let i = from; i <= to; i++) doc.frames[i]!.pivot = { x: args.x, y: args.y };
      return { data: { pivot: { x: args.x, y: args.y }, frames: [from, to] } };
    },
  });
}
