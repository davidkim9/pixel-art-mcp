import { compositeIndexed, exportLayers } from "../document.js";
import { paletteRgb } from "../palette.js";
import type { Project } from "../project.js";
import type { Document, TilesetTemplate } from "../types.js";
import { fail } from "../util/errors.js";
import { BLOB47_MASKS } from "./blob47.js";
import { checkCorner15 } from "./corner15.js";
import type { TransitionCheck } from "./corner15.js";

export function templateFrameCount(template: TilesetTemplate): number {
  return template === "corner15" ? 16 : BLOB47_MASKS.length;
}

/** Mask stored in frame i of a template set. */
export function frameMask(template: TilesetTemplate, frame: number): number {
  return template === "corner15" ? frame : BLOB47_MASKS[frame]!;
}

export function requireTemplate(doc: Document): TilesetTemplate {
  const t = doc.tileset?.template;
  if (!t) fail(`Document "${doc.id}" is not a transition set (create one with create_transition_set).`);
  const expected = templateFrameCount(t);
  if (doc.frames.length !== expected) fail(`A ${t} set needs exactly ${expected} frames (frame index = template slot); this one has ${doc.frames.length}.`);
  return t;
}

/** Flattened exported pixels of every frame. */
export function tileImages(doc: Document): Uint8Array[] {
  return doc.frames.map((_, f) => compositeIndexed(doc, f, exportLayers("normal")));
}

export function checkTransitionSet(project: Project, doc: Document): TransitionCheck & { template: TilesetTemplate } {
  const template = requireTemplate(doc);
  const tiles = tileImages(doc);
  const palette = paletteRgb(project.paletteFor(doc));
  if (template === "corner15") return { template, ...checkCorner15(tiles, doc.width, doc.tileset!.overlay ?? false, palette) };
  const missing = tiles.map((t, i) => (t.some((v) => v) ? -1 : BLOB47_MASKS[i]!)).filter((m) => m >= 0);
  return { template, ok: missing.length === 0, missing, mismatches: [], seamWarnings: [], baseNotEmpty: false };
}

