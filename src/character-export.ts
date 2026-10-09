/** Character export: one packed atlas, or one PNG per part and direction. */
import path from "node:path";
import { getPart, partPivot, requireRig } from "./character.js";
import { exportLayers, framePivot, getCel } from "./document.js";
import { assembleExport, defaultTarget, validateForExport } from "./export/exporters.js";
import type { ExportFile, ExportResult, ExportTarget } from "./export/exporters.js";
import { buildAtlas, checkPaddingExtrude, crop, layoutPacked } from "./export/layout.js";
import { METADATA_VERSION, frameMeta } from "./export/metadata.js";
import type { AssetMetadata, ExportFrame } from "./export/metadata.js";
import { paletteRgb } from "./palette.js";
import { encodeIndexedPng } from "./png.js";
import type { Project } from "./project.js";
import { contentBounds } from "./selection.js";
import type { Document } from "./types.js";
import { fail } from "./util/errors.js";
import { asciiJson } from "./util/ids.js";


function characterBlock(doc: Document): Record<string, unknown> {
  const rig = requireRig(doc);
  return {
    canvas: { w: doc.width, h: doc.height },
    originPx: framePivot(doc, 0),
    layers: doc.layers.filter((l) => !l.guide).map((l) => ({ id: l.id, name: l.name })),
    parts: rig.parts,
    directions: rig.directions,
    ...(rig.mirrors ? { mirrors: rig.mirrors } : {}),
    drawOrder: rig.drawOrder,
    poses: rig.poses,
  };
}

/** One cropped frame per (direction, part) with content. */
export function characterFrames(doc: Document): { frames: ExportFrame[]; warnings: string[] } {
  const rig = requireRig(doc);
  const warnings: string[] = [];
  const additive = doc.layers.filter(exportLayers("additive"));
  if (additive.length) warnings.push(`Additive layers are not exported for characters: ${additive.map((l) => l.id).join(", ")}.`);
  const parts = doc.layers.filter(exportLayers("normal"));
  const frames: ExportFrame[] = [];
  rig.directions.forEach((direction, f) => {
    if (f >= doc.frames.length) return;
    for (const layer of parts) {
      const cel = getCel(doc, layer.id, f);
      const b = cel ? contentBounds(cel, doc.width, doc.height) : null;
      if (!cel || !b) continue;
      const part = getPart(doc, layer.id);
      const pivot = part ? partPivot(part, direction) : framePivot(doc, f);
      frames.push({
        name: `${layer.id}_${direction}`,
        pixels: crop(cel, doc.width, b),
        w: b.w,
        h: b.h,
        durationMs: doc.frames[f]!.durationMs,
        pivot: { x: pivot.x - b.x, y: pivot.y - b.y },
        offset: { x: b.x, y: b.y },
        extra: { part: layer.id, direction },
      });
    }
  });
  if (!frames.length) fail("The character has no pixels to export.");
  return { frames, warnings };
}

export function exportCharacter(project: Project, doc: Document, opts: { mode?: "atlas" | "parts"; name?: string; target?: ExportTarget }): ExportResult {
  requireRig(doc);
  const warnings = validateForExport(project, doc);
  const cfg = doc.source?.exportConfig?.type === "character" ? doc.source.exportConfig : undefined;
  const mode = opts.mode ?? cfg?.mode ?? project.settings.characterExport;
  const padding = cfg?.padding ?? project.settings.atlasPadding;
  const extrude = cfg?.extrude ?? project.settings.atlasExtrude;
  checkPaddingExtrude(padding, extrude);
  const target = opts.target ?? defaultTarget(project, doc, opts.name);
  const { frames, warnings: frameWarnings } = characterFrames(doc);
  warnings.push(...frameWarnings);
  if (mode === "atlas") {
    const layout = layoutPacked(frames.map((f) => ({ w: f.w, h: f.h })), padding);
    return assembleExport({
      project,
      doc,
      target,
      frames,
      layout,
      extrude,
      layoutMeta: { type: "character", mode: "atlas", padding, extrude },
      tags: [],
      extra: { character: characterBlock(doc) },
      warnings,
    });
  }
  // parts: one PNG per (part, direction) + a single metadata file
  const palette = paletteRgb(project.paletteFor(doc));
  const files: ExportFile[] = [];
  const metaFrames = frames.map((f) => {
    const image = `${target.base}_${f.name}.png`;
    files.push({ path: path.join(target.dir, image), data: encodeIndexedPng({ width: f.w, height: f.h, indices: buildAtlas([f], { width: f.w, height: f.h, positions: [{ x: 0, y: 0 }] }, 0), palette }) });
    return { ...frameMeta(f, { x: 0, y: 0 }), image };
  });
  const metadata: AssetMetadata = {
    version: METADATA_VERSION,
    name: target.assetName,
    kind: doc.kind,
    size: { w: doc.width, h: doc.height },
    sourceSize: { w: doc.width, h: doc.height },
    pixelsPerUnit: project.settings.pixelsPerUnit,
    paletteId: doc.paletteId,
    layout: { type: "character", mode: "parts", padding: 0, extrude: 0 },
    frames: metaFrames,
    tags: [],
    character: characterBlock(doc),
  };
  files.push({ path: path.join(target.dir, `${target.base}.json`), data: Buffer.from(asciiJson(metadata, 2) + "\n") });
  if (project.settings.metadataMode === "embedded") warnings.push("Character \"parts\" exports always write a sidecar JSON (one metadata file for all part images).");
  return { name: target.assetName, files, metadata, warnings };
}
