import { compositeIndexed, getCel, getTagRanges } from "./document.js";
import type { Project } from "./project.js";
import { isWrapEnabled } from "./raster.js";
import { rigWarnings } from "./character.js";
import { findOrphans } from "./shading.js";
import { paletteRgb } from "./palette.js";
import { checkTransitionSet, templateFrameCount, tileImages } from "./tileset/check.js";
import { analyzeSeams } from "./tileset/seams.js";
import type { Document } from "./types.js";

export interface Issue {
  check: string;
  message: string;
  details?: unknown;
}

export interface ValidationReport {
  errors: Issue[];
  warnings: Issue[];
}

const MAX_LISTED = 20;

export function validateDocument(project: Project, doc: Document): ValidationReport {
  const report: ValidationReport = { errors: [], warnings: [] };
  const palette = project.palettes.get(doc.paletteId);
  if (!palette) {
    report.errors.push({ check: "palette", message: `Palette "${doc.paletteId}" is not loaded.` });
    return report;
  }

  // Index outside palette range (error)
  const outside: Array<{ layer: string; frame: number; x: number; y: number; index: number }> = [];
  let outsideCount = 0;
  for (const layer of doc.layers) {
    for (let f = 0; f < doc.frames.length; f++) {
      const cel = getCel(doc, layer.id, f);
      if (!cel) continue;
      for (let p = 0; p < cel.length; p++) {
        if (cel[p]! >= palette.colors.length) {
          outsideCount++;
          if (outside.length < MAX_LISTED) outside.push({ layer: layer.id, frame: f, x: p % doc.width, y: Math.floor(p / doc.width), index: cel[p]! });
        }
      }
    }
  }
  if (outsideCount > 0) {
    report.errors.push({
      check: "palette-range",
      message: `${outsideCount} pixel(s) use indices outside palette "${palette.id}" (0–${palette.colors.length - 1}).`,
      details: outside,
    });
  }

  // Partial alpha (error): palette colors must be opaque; index 0 is the only transparency.
  const badColors = palette.colors.slice(1).filter((c) => !/^#[0-9a-f]{6}$/i.test(c));
  if (badColors.length) {
    report.errors.push({ check: "partial-alpha", message: `Palette has non-opaque or malformed colors: ${badColors.join(", ")}` });
  }

  // Canvas size (warning)
  if (doc.width % 8 !== 0 || doc.height % 8 !== 0) {
    report.warnings.push({ check: "canvas-size", message: `Canvas ${doc.width}x${doc.height} is not a multiple of 8.` });
  }

  // Orphan pixels (warning)
  const wrap = isWrapEnabled(doc);
  const orphanSummary: Array<{ layer: string; frame: number; pixels: Array<{ x: number; y: number }> }> = [];
  let orphanCount = 0;
  for (const layer of doc.layers) {
    if (layer.guide) continue;
    for (let f = 0; f < doc.frames.length; f++) {
      const cel = getCel(doc, layer.id, f);
      if (!cel) continue;
      const orphans = findOrphans(cel, doc.width, doc.height, wrap);
      if (orphans.length) {
        orphanCount += orphans.length;
        if (orphanSummary.length < MAX_LISTED) orphanSummary.push({ layer: layer.id, frame: f, pixels: orphans.slice(0, 8).map(({ x, y }) => ({ x, y })) });
      }
    }
  }
  if (orphanCount > 0) {
    report.warnings.push({ check: "orphan-pixels", message: `${orphanCount} isolated single pixel(s) (no opaque neighbors).`, details: orphanSummary });
  }

  // Frame durations and tag gaps (warning)
  const badDurations = doc.frames.map((f, i) => (!(f.durationMs > 0) ? i : -1)).filter((i) => i >= 0);
  if (badDurations.length) {
    report.warnings.push({ check: "frame-duration", message: `Frames without a positive duration: ${badDurations.join(", ")}.` });
  }
  const ranges = getTagRanges(doc);
  const seen = new Map<string, number>();
  for (const r of ranges) seen.set(r.name, (seen.get(r.name) ?? 0) + 1);
  for (const [name, count] of seen) {
    if (count > 1) report.warnings.push({ check: "tag-gaps", message: `Tag "${name}" is split into ${count} non-contiguous ranges.` });
  }
  if (ranges.length > 0 && doc.kind !== "character") {
    const first = Math.min(...ranges.map((r) => r.from));
    const last = Math.max(...ranges.map((r) => r.to));
    const untagged = doc.frames.map((f, i) => (!f.tag && i > first && i < last ? i : -1)).filter((i) => i >= 0);
    if (untagged.length) {
      report.warnings.push({ check: "tag-gaps", message: `Untagged frames between tagged ranges: ${untagged.join(", ")}.` });
    }
  }

  validateTileset(project, doc, report);
  if (doc.icon) {
    const outside = safeAreaViolations(doc);
    if (outside.length) {
      report.warnings.push({
        check: "icon-safe-area",
        message: `Icon content outside the ${doc.icon.margin}px safe area in frame(s) ${outside.map((o) => o.frame).join(", ")}.`,
        details: outside,
      });
    }
  }
  if (doc.rig) {
    for (const message of rigWarnings(doc).slice(0, MAX_LISTED)) report.warnings.push({ check: "rig-overlap", message });
  }
  return report;
}

/** Frames with exported pixels outside an icon set's safe area. */
export function safeAreaViolations(doc: Document): Array<{ frame: number; pixels: number }> {
  if (!doc.icon) return [];
  const m = doc.icon.margin;
  const out: Array<{ frame: number; pixels: number }> = [];
  for (let f = 0; f < doc.frames.length; f++) {
    const pixels = compositeIndexed(doc, f, (l) => l.visible && !l.guide);
    let n = 0;
    for (let y = 0; y < doc.height; y++) {
      for (let x = 0; x < doc.width; x++) {
        if (pixels[y * doc.width + x] && (x < m || y < m || x >= doc.width - m || y >= doc.height - m)) n++;
      }
    }
    if (n) out.push({ frame: f, pixels: n });
  }
  return out;
}

function validateTileset(project: Project, doc: Document, report: ValidationReport): void {
  if (!doc.tileset) return;
  const template = doc.tileset.template;
  if (!template) {
    // Plain seamless tiles: every non-empty frame should repeat without visible seams.
    const palette = paletteRgb(project.paletteFor(doc));
    const seams: Array<{ frame: number; verdict: string; flagged: number }> = [];
    tileImages(doc).forEach((pixels, frame) => {
      if (!pixels.some((v) => v)) return;
      const r = analyzeSeams(pixels, doc.width, doc.height, palette);
      if (r.verdict !== "seamless") seams.push({ frame, verdict: r.verdict, flagged: r.horizontal.flagged.length + r.vertical.flagged.length });
    });
    if (seams.length) {
      report.warnings.push({ check: "tile-seams", message: `Tile seams may be visible in frame(s) ${seams.map((s) => s.frame).join(", ")} (see check_seams).`, details: seams });
    }
    return;
  }
  if (doc.frames.length !== templateFrameCount(template)) {
    report.errors.push({ check: "transition-set", message: `A ${template} set needs exactly ${templateFrameCount(template)} frames; this one has ${doc.frames.length}.` });
    return;
  }
  const result = checkTransitionSet(project, doc);
  if (result.missing.length) {
    const level = template === "corner15" ? report.errors : report.warnings;
    level.push({ check: "transition-set", message: `Missing tiles (masks): ${result.missing.join(", ")}.` });
  }
  if (result.mismatches.length) {
    report.errors.push({
      check: "transition-set",
      message: `${result.mismatches.length} edge(s) break the corner edge-matching rule (see check_transition_set).`,
      details: result.mismatches.slice(0, MAX_LISTED),
    });
  }
  if (result.seamWarnings.length) {
    report.warnings.push({
      check: "tile-seams",
      message: `Possible visible seams where tiles repeat: ${result.seamWarnings.map((w) => `tile ${w.tile} (${w.axis})`).join(", ")}.`,
    });
  }
  if (result.baseNotEmpty) {
    report.warnings.push({ check: "transition-set", message: "Overlay mode: frame 0 (all lower terrain) should be empty; it is exported to atlas slot 0." });
  }
}

export function formatIssues(report: ValidationReport): string {
  return report.errors.map((e) => `[${e.check}] ${e.message}`).join("\n");
}
