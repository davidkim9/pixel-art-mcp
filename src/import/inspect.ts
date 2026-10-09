/** inspect_file: what a PNG or .aseprite file contains, without importing it. */
import fs from "node:fs";
import path from "node:path";
import { rgbKey, toHex } from "../color.js";
import { PaletteMatcher } from "../palette.js";
import { decodePng } from "../png.js";
import type { Project } from "../project.js";
import { fail } from "../util/errors.js";
import { ASE_BLEND_NAMES, ASE_TAG_DIRECTIONS, parseAseprite } from "./aseprite.js";
import { findMetadata, targetPalette } from "./png-import.js";
import { detectScale, rgbaComparator } from "./scale.js";
import { detectGrid } from "./slicing.js";

const COLOR_TYPES: Record<number, string> = { 0: "grayscale", 2: "truecolor (RGB)", 3: "indexed", 4: "grayscale + alpha", 6: "truecolor + alpha (RGBA)" };

export function inspectFile(project: Project, filePath: string): Record<string, unknown> {
  const file = project.resolveReadPath(filePath);
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return inspectPng(project, file, buf);
  if (ext === ".aseprite" || ext === ".ase") return inspectAseprite(project, file, buf);
  fail(`Can't inspect ${ext || "this"} files (supported: .png, .aseprite, .ase).`);
}

function inspectPng(project: Project, file: string, buf: Buffer): Record<string, unknown> {
  const png = decodePng(buf);
  const threshold = 128;
  const colors = new Map<number, number>();
  let partial = 0;
  let transparent = 0;
  for (let i = 0; i < png.width * png.height; i++) {
    const a = png.rgba[i * 4 + 3]!;
    if (a > 0 && a < 255) partial++;
    if (a < threshold) {
      transparent++;
      continue;
    }
    const key = rgbKey(png.rgba[i * 4]!, png.rgba[i * 4 + 1]!, png.rgba[i * 4 + 2]!);
    colors.set(key, (colors.get(key) ?? 0) + 1);
  }
  const scale = detectScale(png.width, png.height, rgbaComparator(png.rgba, threshold));
  const found = findMetadata(file, png);
  const palette = targetPalette(project, {});
  let offPalette: number | undefined;
  if (palette) {
    const m = new PaletteMatcher(palette);
    offPalette = [...colors.keys()].filter((k) => m.exact((k >> 16) & 255, (k >> 8) & 255, k & 255) === undefined).length;
  }
  const opaque = (x: number, y: number) => png.rgba[((y * scale) * png.width + x * scale) * 4 + 3]! >= threshold;
  const grid = found.meta ? undefined : detectGrid(opaque, png.width / scale, png.height / scale);
  const info: Record<string, unknown> = {
    format: "png",
    path: project.displayPath(file),
    width: png.width,
    height: png.height,
    colorMode: COLOR_TYPES[png.colorType] ?? `type ${png.colorType}`,
    bitDepth: png.bitDepth,
    interlaced: png.interlaced,
    opaqueColors: colors.size,
    transparentPixels: transparent,
    partialAlphaPixels: partial,
    detectedScale: scale,
    textChunks: png.texts.map((t) => t.keyword),
    mcpMetadata: found.meta
      ? {
          where: found.where,
          name: found.meta.name,
          kind: found.meta.kind,
          layout: found.meta.layout?.type,
          frames: found.meta.frames.length,
          tags: found.meta.tags?.map((t) => t.name) ?? [],
          paletteId: found.meta.paletteId,
          glow: found.meta.glow ?? null,
        }
      : null,
  };
  if (png.palette) {
    info.embeddedPalette = {
      entries: png.palette.length,
      transparentEntries: png.palette.map((e, i) => (e.a < 255 ? i : -1)).filter((i) => i >= 0),
      colors: png.palette.slice(0, 64).map((e) => toHex(e)),
    };
  }
  if (palette) info.againstPalette = { paletteId: palette.id, offPaletteColors: offPalette };
  if (grid) info.autoSlicing = { confident: grid.confident, proposal: grid.proposal, alternatives: grid.alternatives, reason: grid.reason, note: scale > 1 ? `in ${scale}x-downscaled pixels` : undefined };
  return info;
}

function inspectAseprite(project: Project, file: string, buf: Buffer): Record<string, unknown> {
  const ase = parseAseprite(buf);
  const paths: string[] = [];
  const stack: number[] = [];
  for (const l of ase.layers) {
    stack.length = l.childLevel;
    const parent = l.childLevel > 0 ? stack[l.childLevel - 1] : undefined;
    paths[l.index] = parent !== undefined ? `${paths[parent]}/${l.name}` : l.name;
    stack[l.childLevel] = l.index;
  }
  const durations = ase.frames.map((f) => f.duration);
  return {
    format: "aseprite",
    path: project.displayPath(file),
    width: ase.width,
    height: ase.height,
    colorMode: ase.colorDepth === 8 ? "indexed" : ase.colorDepth === 16 ? "grayscale" : "rgba",
    transparentIndex: ase.colorDepth === 8 ? ase.transparentIndex : undefined,
    paletteSize: ase.palette.length,
    palette: ase.palette.slice(0, 64).map((c) => toHex(c)),
    frames: ase.frames.length,
    durationsMs: durations.every((d) => d === durations[0]) ? durations[0] : durations,
    layers: ase.layers.map((l) => ({
      name: paths[l.index],
      type: l.type === 1 ? "group" : l.type === 2 ? "tilemap" : "image",
      visible: l.visible,
      ...(l.blendMode ? { blend: ASE_BLEND_NAMES[l.blendMode] ?? l.blendMode } : {}),
      ...(l.opacity < 255 ? { opacity: l.opacity } : {}),
      ...(l.background ? { background: true } : {}),
      ...(l.reference ? { reference: true } : {}),
    })),
    tags: ase.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: ASE_TAG_DIRECTIONS[t.direction] ?? t.direction, ...(t.repeat ? { repeat: t.repeat } : {}) })),
    slices: ase.slices.map((s) => ({ name: s.name, keys: s.keys.length, bounds: s.keys[0] ? { x: s.keys[0].x, y: s.keys[0].y, w: s.keys[0].w, h: s.keys[0].h } : null, pivot: s.keys[0]?.pivot ?? null, nineSlice: Boolean(s.flags & 1) })),
    tilesets: ase.tilesets.map((t) => ({ name: t.name, tiles: t.count, tileSize: { w: t.tileW, h: t.tileH } })),
    hasColorProfile: ase.hasColorProfile,
    mcpMetadata: null,
    warnings: ase.warnings,
  };
}
