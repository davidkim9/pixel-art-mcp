/** export_to_source: write an imported document back to where it came from. */
import fs from "node:fs";
import path from "node:path";
import { exportCharacter } from "../character-export.js";
import { framePivot } from "../document.js";
import { assembleExport, collectFrames, exportSinglePng, exportSpritesheet, scaleExportFrames, validateForExport } from "../export/exporters.js";
import type { ExportResult, ExportTarget } from "../export/exporters.js";
import { crop } from "../export/layout.js";
import type { ExportFrame } from "../export/metadata.js";
import { writeExport } from "../export/write.js";
import type { WrittenExport } from "../export/write.js";
import { exportIconAtlas } from "../icons.js";
import type { Project } from "../project.js";
import { exportTileset } from "../tileset/sets.js";
import type { Document, ExportConfig } from "../types.js";
import { fail } from "../util/errors.js";
import { sha256 } from "../util/ids.js";

/** Writes each frame back into the rect it was cut from (third-party sheets), scaled up if needed. */
function exportToRects(project: Project, doc: Document, cfg: Extract<ExportConfig, { type: "rects" }>, target: ExportTarget, scale: number): ExportResult {
  const warnings = validateForExport(project, doc);
  if (doc.frames.length > cfg.rects.length) fail(`The document has ${doc.frames.length} frames but the source sheet had ${cfg.rects.length} cells.`);
  if (doc.frames.length < cfg.rects.length) warnings.push(`The source had ${cfg.rects.length} cells; only ${doc.frames.length} are written.`);
  const base = target.assetName.split("/").pop()!;
  let frames: ExportFrame[] = collectFrames(doc, doc.frames.map((_, i) => i), base).map((f, i) => {
    const r = cfg.rects[i]!;
    const region = { x: r.offsetX, y: r.offsetY, w: r.w, h: r.h };
    if (region.x < 0 || region.y < 0 || region.x + region.w > doc.width || region.y + region.h > doc.height) fail(`Frame ${i} no longer fits its source rect; was the canvas resized?`);
    let outside = 0;
    for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) {
      if ((f.pixels[y * doc.width + x] || f.glow?.[y * doc.width + x]) && (x < region.x || y < region.y || x >= region.x + region.w || y >= region.y + region.h)) outside++;
    }
    if (outside) warnings.push(`Frame ${i}: ${outside} pixel(s) outside its source rect were not written.`);
    const pivot = framePivot(doc, i);
    return {
      ...f,
      pixels: crop(f.pixels, doc.width, region),
      glow: f.glow ? crop(f.glow, doc.width, region) : undefined,
      w: r.w,
      h: r.h,
      pivot: { x: pivot.x - r.offsetX, y: pivot.y - r.offsetY },
      ...(r.offsetX || r.offsetY ? { offset: { x: r.offsetX, y: r.offsetY } } : {}),
    };
  });
  frames = scaleExportFrames(frames, scale);
  const layout = { width: cfg.width * scale, height: cfg.height * scale, positions: cfg.rects.slice(0, frames.length).map((r) => ({ x: r.x * scale, y: r.y * scale })) };
  return assembleExport({
    project,
    doc,
    target,
    frames,
    layout,
    extrude: 0,
    layoutMeta: { type: "source" },
    tags: [],
    extra: scale > 1 ? { pixelsPerUnit: project.settings.pixelsPerUnit * scale } : {},
    warnings: scale > 1 ? [...warnings, `Written at ${scale}x to match the source.`] : warnings,
  });
}

export interface SourceExport extends WrittenExport {
  sourceFormat: "png" | "aseprite";
  wroteOverSource: boolean;
}

export function exportToSource(project: Project, doc: Document, force: boolean): SourceExport {
  const src = doc.source;
  if (!src) fail(`Document "${doc.id}" was not imported from a file.`);
  if (fs.existsSync(src.path)) {
    const current = sha256(fs.readFileSync(src.path));
    if (current !== src.sha256 && !force) {
      fail(`${project.displayPath(src.path)} changed since it was imported (hash mismatch). Re-import it, or pass force: true to overwrite.`);
    }
  } else if (!force) fail(`${project.displayPath(src.path)} no longer exists; pass force: true to write it anyway.`);
  const dir = path.dirname(src.path);
  const base = path.basename(src.path).replace(/\.[^.]+$/, "");
  const target: ExportTarget = { dir, base, assetName: src.assetName ?? doc.name };
  let result: ExportResult;
  if (src.format === "png") {
    const cfg: ExportConfig = src.exportConfig ?? { type: "png" };
    const scale = src.scale ?? 1;
    switch (cfg.type) {
      case "png":
        result = scale > 1
          ? exportToRects(project, doc, { type: "rects", width: doc.width, height: doc.height, rects: [{ x: 0, y: 0, w: doc.width, h: doc.height, offsetX: 0, offsetY: 0 }] }, target, scale)
          : exportSinglePng(project, doc, { frame: 0, target });
        break;
      case "rects":
        result = exportToRects(project, doc, cfg, target, scale);
        break;
      case "spritesheet":
        result = exportSpritesheet(project, doc, { target });
        break;
      case "tileset":
        result = exportTileset(project, doc, { target });
        break;
      case "icons":
        result = exportIconAtlas(project, doc, { target });
        break;
      case "character":
        result = exportCharacter(project, doc, { target, mode: "atlas" });
        break;
    }
  } else {
    // Writing .aseprite is out of scope: export PNG + metadata next to the source instead.
    if (doc.rig) result = exportCharacter(project, doc, { target, mode: "atlas" });
    else if (doc.tileset) result = exportTileset(project, doc, { target });
    else if (doc.kind === "icon") result = exportIconAtlas(project, doc, { target });
    else if (doc.frames.length === 1) result = exportSinglePng(project, doc, { frame: 0, target });
    else result = exportSpritesheet(project, doc, { target, layout: "row" });
  }
  const written = writeExport(project, result);
  if (src.format === "png") src.sha256 = sha256(fs.readFileSync(src.path));
  return { ...written, sourceFormat: src.format, wroteOverSource: src.format === "png" };
}
