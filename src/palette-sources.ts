import fs from "node:fs";
import path from "node:path";
import { rgbKey, toHex } from "./color.js";
import { BUILTIN_PALETTES, MAX_PALETTE_COLORS, parsePaletteText } from "./palette.js";
import { decodePng } from "./png.js";
import type { Project } from "./project.js";
import { fail } from "./util/errors.js";

export interface PaletteSourceResult {
  colors: string[];
  /** How the colors were obtained, for the tool report. */
  origin: string;
  name?: string;
}

const FILE_EXT = /\.(png|aseprite|ase|gpl|hex|txt)$/i;

export function looksLikePath(source: string): boolean {
  return !source.includes("\n") && FILE_EXT.test(source.trim());
}

/** Opaque colors of a PNG: its PLTE (index-aligned) for indexed images, else unique colors in scan order. */
export function paletteFromPng(buf: Uint8Array): PaletteSourceResult {
  const png = decodePng(buf);
  if (png.colorType === 3 && png.palette) {
    const entries = png.palette;
    if (entries[0] && entries[0].a === 0) {
      return { colors: entries.slice(1).map((e) => toHex(e)), origin: "indexed PNG palette (entry 0 transparent; indices preserved)" };
    }
    return { colors: entries.map((e) => toHex(e)), origin: "indexed PNG palette (shifted by one: index 0 is reserved for transparency)" };
  }
  const seen = new Set<number>();
  const colors: string[] = [];
  for (let i = 0; i < png.width * png.height; i++) {
    if (png.rgba[i * 4 + 3]! < 128) continue;
    const key = rgbKey(png.rgba[i * 4]!, png.rgba[i * 4 + 1]!, png.rgba[i * 4 + 2]!);
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push(toHex({ r: png.rgba[i * 4]!, g: png.rgba[i * 4 + 1]!, b: png.rgba[i * 4 + 2]! }));
    if (colors.length > MAX_PALETTE_COLORS) fail(`Image has more than ${MAX_PALETTE_COLORS} opaque colors; it can't be a palette.`);
  }
  return { colors, origin: "unique opaque colors of the image, in scan order" };
}

/** Pluggable reader for .aseprite palettes (registered by the import module). */
let asepritePaletteReader: ((buf: Uint8Array) => PaletteSourceResult) | undefined;

export function setAsepritePaletteReader(reader: (buf: Uint8Array) => PaletteSourceResult): void {
  asepritePaletteReader = reader;
}

export function resolvePaletteSource(project: Project, source: string | string[]): PaletteSourceResult {
  if (Array.isArray(source)) return { colors: parsePaletteText(source.join("\n")).colors, origin: "hex color list" };
  const s = source.trim();
  const builtin = /^builtin:(.+)$/i.exec(s);
  if (builtin) {
    const colors = BUILTIN_PALETTES[builtin[1]!.toLowerCase()];
    if (!colors) fail(`Unknown builtin palette "${builtin[1]}". Available: ${Object.keys(BUILTIN_PALETTES).join(", ")}.`);
    return { colors, origin: `builtin palette ${builtin[1]}` };
  }
  if (looksLikePath(s)) {
    const file = project.resolveReadPath(s);
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    if (ext === ".png") return paletteFromPng(buf);
    if (ext === ".aseprite" || ext === ".ase") {
      if (!asepritePaletteReader) fail("Aseprite support is not available.");
      return asepritePaletteReader(buf);
    }
    const parsed = parsePaletteText(buf.toString("utf8"));
    return { colors: parsed.colors, origin: `${parsed.format === "gpl" ? "GIMP .gpl" : "hex"} file ${path.basename(file)}`, name: parsed.name };
  }
  const parsed = parsePaletteText(s);
  return { colors: parsed.colors, origin: parsed.format === "gpl" ? "GIMP .gpl text" : "hex text", name: parsed.name };
}
