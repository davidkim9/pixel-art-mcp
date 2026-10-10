/**
 * .aseprite encoder (indexed, 8 bits per pixel), the inverse of
 * src/import/aseprite.ts. Writes layers (visibility, lock, additive blend,
 * guides as reference layers), frames with durations, compressed cels trimmed
 * to their content, tags with direction, the palette (index 0 transparent),
 * and frame pivots as a "pivot" slice that import_aseprite reads back.
 */
import { deflateSync } from "node:zlib";
import { parseHexColor } from "../color.js";
import { framePivot, getCel, getTagRanges } from "../document.js";
import type { Project } from "../project.js";
import { contentBounds } from "../selection.js";
import { TAG_DIRECTIONS } from "../types.js";
import type { Document } from "../types.js";
import { fail } from "../util/errors.js";
import { sanitizeAssetName } from "../util/ids.js";
import { validateDocument } from "../validate.js";
import { crop } from "./layout.js";

const ADDITION_BLEND = 16;

class ByteWriter {
  private bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 255);
    return this;
  }
  u16(v: number) {
    return this.u8(v).u8(v >> 8);
  }
  i16(v: number) {
    return this.u16(v & 0xffff);
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }
  i32(v: number) {
    return this.u32(v >>> 0);
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  str(s: string) {
    const b = Buffer.from(s, "utf8");
    return this.u16(b.length).append(b);
  }
  append(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i]!);
    return this;
  }
  get length() {
    return this.bytes.length;
  }
  buffer() {
    return Buffer.from(this.bytes);
  }
}

function chunk(type: number, body: ByteWriter): Buffer {
  return Buffer.concat([new ByteWriter().u32(body.length + 6).u16(type).buffer(), body.buffer()]);
}

export interface AsepriteEncoding {
  data: Buffer;
  warnings: string[];
}

/** Encodes a document as an indexed .aseprite file. */
export function encodeAseprite(project: Project, doc: Document): AsepriteEncoding {
  const warnings: string[] = [];
  const report = validateDocument(project, doc);
  for (const e of report.errors) warnings.push(`[${e.check}] ${e.message}`);

  const colors = project.paletteFor(doc).colors;
  if (colors.length > 256) fail(`Palette has ${colors.length} colors; .aseprite indexed files hold at most 256.`);
  let maxIndex = 0;
  for (const cel of Object.values(doc.cels)) for (let i = 0; i < cel.length; i++) if (cel[i]! > maxIndex) maxIndex = cel[i]!;
  const paletteSize = Math.max(colors.length, maxIndex + 1, 2);
  if (maxIndex >= colors.length) warnings.push(`Pixels use index ${maxIndex}, beyond the palette (${colors.length} colors); padded with black.`);

  if (doc.rig) warnings.push("Rig data (parts, poses, per-direction draw order) is not stored in .aseprite; layers keep the document's stack order.");
  if (doc.frames.some((f) => f.label)) warnings.push("Frame labels are not stored in .aseprite.");

  const first: Buffer[] = [];

  // Layers (bottom → top, matching Aseprite's order).
  for (const l of doc.layers) {
    const flags = (l.visible ? 1 : 0) | (l.locked ? 0 : 2) | (l.guide ? 64 : 0);
    const blend = l.blend === "additive" ? ADDITION_BLEND : 0;
    first.push(chunk(0x2004, new ByteWriter().u16(flags).u16(0).u16(0).u16(0).u16(0).u16(blend).u8(255).zeros(3).str(l.name)));
  }

  // Tags.
  const tags = getTagRanges(doc);
  if (tags.length) {
    const b = new ByteWriter().u16(tags.length).zeros(8);
    for (const t of tags) {
      b.u16(t.from).u16(t.to).u8(TAG_DIRECTIONS.indexOf(t.direction)).u16(0).zeros(6).zeros(3).u8(0).str(t.name);
    }
    first.push(chunk(0x2018, b));
  }

  // Palette (entry 0 fully transparent).
  const pal = new ByteWriter().u32(paletteSize).u32(0).u32(paletteSize - 1).zeros(8);
  for (let i = 0; i < paletteSize; i++) {
    if (i === 0) pal.u16(0).u8(0).u8(0).u8(0).u8(0);
    else {
      const { r, g, b } = i < colors.length ? parseHexColor(colors[i]!) : { r: 0, g: 0, b: 0 };
      pal.u16(0).u8(r).u8(g).u8(b).u8(255);
    }
  }
  first.push(chunk(0x2019, pal));

  // Frame pivots → one "pivot" slice with a key per frame (only when some frame sets one).
  if (doc.frames.some((f) => f.pivot)) {
    const b = new ByteWriter().u32(doc.frames.length).u32(2).u32(0).str("pivot");
    let rounded = false;
    doc.frames.forEach((_, i) => {
      const p = framePivot(doc, i);
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (x !== p.x || y !== p.y) rounded = true;
      b.u32(i).i32(0).i32(0).u32(doc.width).u32(doc.height).i32(x).i32(y);
    });
    if (rounded) warnings.push("Fractional pivots were rounded to whole pixels (Aseprite slice pivots are integers).");
    first.push(chunk(0x2022, b));
  }

  const frames = doc.frames.map((frame, fi) => {
    const chunks = fi === 0 ? [...first] : [];
    doc.layers.forEach((l, li) => {
      const cel = getCel(doc, l.id, fi);
      if (!cel) return;
      const bounds = contentBounds(cel, doc.width, doc.height);
      if (!bounds) return;
      const pixels = crop(cel, doc.width, bounds);
      const b = new ByteWriter().u16(li).i16(bounds.x).i16(bounds.y).u8(255).u16(2).i16(0).zeros(5).u16(bounds.w).u16(bounds.h).append(deflateSync(pixels));
      chunks.push(chunk(0x2005, b));
    });
    const duration = Math.min(Math.max(Math.round(frame.durationMs), 1), 0xffff);
    const body = Buffer.concat(chunks);
    const head = new ByteWriter()
      .u32(16 + body.length)
      .u16(0xf1fa)
      .u16(Math.min(chunks.length, 0xffff))
      .u16(duration)
      .zeros(2)
      .u32(chunks.length);
    return Buffer.concat([head.buffer(), body]);
  });

  const body = Buffer.concat(frames);
  const header = new ByteWriter()
    .u32(128 + body.length)
    .u16(0xa5e0)
    .u16(doc.frames.length)
    .u16(doc.width)
    .u16(doc.height)
    .u16(8)
    .u32(1) // layer opacity is valid
    .u16(100) // deprecated speed
    .zeros(8)
    .u8(0) // transparent index
    .zeros(3)
    .u16(paletteSize === 256 ? 0 : paletteSize)
    .u8(1) // pixel ratio 1:1
    .u8(1)
    .i16(0) // grid
    .i16(0)
    .u16(doc.tileset?.tileSize ?? 16)
    .u16(doc.tileset?.tileSize ?? 16)
    .zeros(84);
  return { data: Buffer.concat([header.buffer(), body]), warnings };
}

/** outputDir/<name>.aseprite (default name: the document's export name). */
export function asepritePath(project: Project, doc: Document, name?: string): string {
  const base = sanitizeAssetName((name ?? doc.source?.assetName ?? doc.name).replace(/\.(aseprite|ase)$/i, ""));
  return project.outputPath(`${base}.aseprite`);
}
