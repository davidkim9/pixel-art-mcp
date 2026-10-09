/**
 * Minimal, deterministic PNG codec.
 *
 * pngjs (suggested by the spec) can only *write* grayscale/RGB/RGBA and ignores
 * text chunks, so exports use this encoder: 8-bit indexed PNGs with the palette
 * embedded (PLTE), index 0 transparent via tRNS, and optional tEXt chunks.
 * The decoder handles every standard PNG (all color types, bit depths, Adam7)
 * and keeps raw palette indices for indexed images.
 */
import { deflateSync, inflateSync } from "node:zlib";
import type { RGB } from "./color.js";
import { fail } from "./util/errors.js";

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crcUpdate(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return crc;
}

export function crc32(data: Uint8Array): number {
  return (crcUpdate(0xffffffff, data) ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  const crc = (crcUpdate(crcUpdate(0xffffffff, out.subarray(4, 8)), data) ^ 0xffffffff) >>> 0;
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

export interface PngText {
  keyword: string;
  text: string;
}

function textChunk(t: PngText): Buffer {
  if (!/^[\x20-\x7e]{1,79}$/.test(t.keyword)) fail(`Invalid PNG text keyword "${t.keyword}"`);
  return makeChunk("tEXt", Buffer.concat([Buffer.from(t.keyword, "latin1"), Buffer.from([0]), Buffer.from(t.text, "latin1")]));
}

function ihdr(width: number, height: number, bitDepth: number, colorType: number): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    fail(`Invalid PNG size ${width}x${height}`);
  }
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colorType;
  return makeChunk("IHDR", data); // compression 0, filter 0, interlace 0
}

function idat(filtered: Uint8Array): Buffer {
  return makeChunk("IDAT", deflateSync(filtered, { level: 9, memLevel: 9 }));
}

export interface IndexedPngInput {
  width: number;
  height: number;
  indices: Uint8Array;
  /** PLTE entries, index-aligned (1–256 entries). */
  palette: RGB[];
  /** The only transparent index (default 0); null for a fully opaque image. */
  transparentIndex?: number | null;
  texts?: PngText[];
}

/** 8-bit indexed PNG. Rows use filter type 0, as recommended for palette images. */
export function encodeIndexedPng(input: IndexedPngInput): Buffer {
  const { width, height, indices, palette } = input;
  if (palette.length < 1 || palette.length > 256) fail(`PNG palette must have 1–256 entries (got ${palette.length})`);
  if (indices.length !== width * height) fail("Index buffer size does not match the image size");
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
  });
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const v = indices[y * width + x]!;
      if (v >= palette.length) fail(`Pixel (${x},${y}) uses index ${v}, outside the ${palette.length}-entry palette`);
      raw[rowStart + 1 + x] = v;
    }
  }
  const chunks: Buffer[] = [Buffer.from(SIGNATURE), ihdr(width, height, 8, 3), makeChunk("PLTE", plte)];
  const t = input.transparentIndex === undefined ? 0 : input.transparentIndex;
  if (t !== null) {
    const trns = Buffer.alloc(t + 1, 255);
    trns[t] = 0;
    chunks.push(makeChunk("tRNS", trns));
  }
  for (const text of input.texts ?? []) chunks.push(textChunk(text));
  chunks.push(idat(raw), makeChunk("IEND", new Uint8Array(0)));
  return Buffer.concat(chunks);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Adaptive filtering (minimum sum of absolute differences), deterministic. */
function filterAdaptive(data: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  let prev: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const dst = cand[f]!;
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        const up = prev[i]!;
        const upLeft = i >= bpp ? prev[i - bpp]! : 0;
        let v: number;
        switch (f) {
          case 0: v = row[i]!; break;
          case 1: v = row[i]! - left; break;
          case 2: v = row[i]! - up; break;
          case 3: v = row[i]! - ((left + up) >> 1); break;
          default: v = row[i]! - paeth(left, up, upLeft); break;
        }
        v &= 0xff;
        dst[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    out.set(cand[best]!, y * (stride + 1) + 1);
    prev = row;
  }
  return out;
}

/** 8-bit RGBA PNG (used for previews). */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array, texts: PngText[] = []): Buffer {
  if (rgba.length !== width * height * 4) fail("RGBA buffer size does not match the image size");
  const filtered = filterAdaptive(rgba, width * 4, height, 4);
  const chunks: Buffer[] = [Buffer.from(SIGNATURE), ihdr(width, height, 8, 6)];
  for (const text of texts) chunks.push(textChunk(text));
  chunks.push(idat(filtered), makeChunk("IEND", new Uint8Array(0)));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Decoding

export interface PngPaletteEntry {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
}

export interface DecodedPng extends PngHeader {
  /** RGBA, 8 bits per channel. */
  rgba: Uint8Array;
  /** Raw palette indices (color type 3 only). */
  indices?: Uint8Array;
  /** PLTE with tRNS alpha applied (color type 3), or a suggested palette (PLTE in truecolor files). */
  palette?: PngPaletteEntry[];
  texts: PngText[];
  chunkTypes: string[];
}

interface RawChunk {
  type: string;
  data: Uint8Array;
}

function readChunks(buf: Uint8Array, stopAtIdat = false): RawChunk[] {
  if (buf.length < 8 || SIGNATURE.some((v, i) => buf[i] !== v)) fail("Not a PNG file (bad signature)");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const chunks: RawChunk[] = [];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4]!, buf[pos + 5]!, buf[pos + 6]!, buf[pos + 7]!);
    if (pos + 12 + length > buf.length) fail(`Truncated PNG chunk ${type}`);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    const expected = view.getUint32(pos + 8 + length);
    const actual = (crcUpdate(crcUpdate(0xffffffff, buf.subarray(pos + 4, pos + 8)), data) ^ 0xffffffff) >>> 0;
    if (expected !== actual) fail(`Corrupt PNG: CRC mismatch in ${type} chunk`);
    chunks.push({ type, data });
    pos += 12 + length;
    if (type === "IEND") break;
    if (stopAtIdat && type === "IDAT") break;
  }
  return chunks;
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

function parseText(chunk: RawChunk): PngText | undefined {
  const d = chunk.data;
  const nul = d.indexOf(0);
  if (nul < 1) return undefined;
  const keyword = latin1.decode(d.subarray(0, nul));
  try {
    if (chunk.type === "tEXt") return { keyword, text: latin1.decode(d.subarray(nul + 1)) };
    if (chunk.type === "zTXt") return { keyword, text: latin1.decode(inflateSync(d.subarray(nul + 2))) };
    if (chunk.type === "iTXt") {
      const compressed = d[nul + 1] === 1;
      let p = nul + 3;
      const langEnd = d.indexOf(0, p);
      if (langEnd < 0) return undefined;
      const transEnd = d.indexOf(0, langEnd + 1);
      if (transEnd < 0) return undefined;
      p = transEnd + 1;
      const body = compressed ? inflateSync(d.subarray(p)) : d.subarray(p);
      return { keyword, text: utf8.decode(body) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseHeader(chunks: RawChunk[]): PngHeader {
  const h = chunks[0];
  if (!h || h.type !== "IHDR" || h.data.length !== 13) fail("Corrupt PNG: missing IHDR");
  const v = new DataView(h.data.buffer, h.data.byteOffset, 13);
  const header: PngHeader = {
    width: v.getUint32(0),
    height: v.getUint32(4),
    bitDepth: h.data[8]!,
    colorType: h.data[9]!,
    interlaced: h.data[12] === 1,
  };
  const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!allowed[header.colorType]?.includes(header.bitDepth)) {
    fail(`Unsupported PNG color type ${header.colorType} / bit depth ${header.bitDepth}`);
  }
  if (header.width === 0 || header.height === 0) fail("PNG has zero size");
  return header;
}

/** Reads header and text chunks without decoding pixels. */
export function readPngInfo(buf: Uint8Array): PngHeader & { texts: PngText[]; chunkTypes: string[] } {
  const chunks = readChunks(buf);
  const header = parseHeader(chunks);
  const texts = chunks.map(parseText).filter((t): t is PngText => t !== undefined);
  return { ...header, texts, chunkTypes: chunks.map((c) => c.type) };
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

export function decodePng(buf: Uint8Array): DecodedPng {
  const chunks = readChunks(buf);
  const header = parseHeader(chunks);
  const { width, height, bitDepth, colorType, interlaced } = header;
  let plte: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idats: Uint8Array[] = [];
  const texts: PngText[] = [];
  for (const c of chunks) {
    if (c.type === "PLTE") plte = c.data;
    else if (c.type === "tRNS") trns = c.data;
    else if (c.type === "IDAT") idats.push(c.data);
    else if (c.type === "tEXt" || c.type === "zTXt" || c.type === "iTXt") {
      const t = parseText(c);
      if (t) texts.push(t);
    }
  }
  if (colorType === 3 && !plte) fail("Corrupt PNG: indexed image without PLTE");
  if (idats.length === 0) fail("Corrupt PNG: no image data");

  let palette: PngPaletteEntry[] | undefined;
  if (plte) {
    palette = [];
    for (let i = 0; i + 2 < plte.length; i += 3) {
      const idx = i / 3;
      const a = colorType === 3 && trns && idx < trns.length ? trns[idx]! : 255;
      palette.push({ r: plte[i]!, g: plte[i + 1]!, b: plte[i + 2]!, a });
    }
  }

  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idats));
  } catch (e) {
    fail(`Corrupt PNG: cannot inflate image data (${(e as Error).message})`);
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!;
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const rgba = new Uint8Array(width * height * 4);
  const indices = colorType === 3 ? new Uint8Array(width * height) : undefined;
  const maxSample = (1 << bitDepth) - 1;
  const trnsView = trns ? new DataView(trns.buffer, trns.byteOffset, trns.byteLength) : undefined;
  const trnsGray = colorType === 0 && trnsView && trns!.length >= 2 ? trnsView.getUint16(0) : undefined;
  const trnsRgb =
    colorType === 2 && trnsView && trns!.length >= 6
      ? [trnsView.getUint16(0), trnsView.getUint16(2), trnsView.getUint16(4)]
      : undefined;
  const to8 = (v: number) => (bitDepth === 8 ? v : Math.floor((v * 255) / maxSample + 0.5));

  const passes = interlaced ? ADAM7 : ([[0, 0, 1, 1]] as const);
  let offset = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    let prev: Uint8Array = new Uint8Array(rowBytes);
    for (let r = 0; r < ph; r++) {
      if (offset + 1 + rowBytes > raw.length) fail("Corrupt PNG: image data too short");
      const filter = raw[offset]!;
      const row = raw.slice(offset + 1, offset + 1 + rowBytes);
      offset += 1 + rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        const up = prev[i]!;
        const upLeft = i >= bpp ? prev[i - bpp]! : 0;
        switch (filter) {
          case 0: break;
          case 1: row[i] = (row[i]! + left) & 0xff; break;
          case 2: row[i] = (row[i]! + up) & 0xff; break;
          case 3: row[i] = (row[i]! + ((left + up) >> 1)) & 0xff; break;
          case 4: row[i] = (row[i]! + paeth(left, up, upLeft)) & 0xff; break;
          default: fail(`Corrupt PNG: unknown filter type ${filter}`);
        }
      }
      prev = row;
      const y = y0 + r * dy;
      const sample = (i: number, c: number): number => {
        const s = i * channels + c;
        if (bitDepth === 8) return row[s]!;
        if (bitDepth === 16) return (row[s * 2]! << 8) | row[s * 2 + 1]!;
        const bit = s * bitDepth;
        return (row[bit >> 3]! >> (8 - bitDepth - (bit & 7))) & maxSample;
      };
      for (let i = 0; i < pw; i++) {
        const x = x0 + i * dx;
        const p = y * width + x;
        const o = p * 4;
        switch (colorType) {
          case 0: {
            const v = sample(i, 0);
            const g = to8(v);
            rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
            rgba[o + 3] = trnsGray !== undefined && v === trnsGray ? 0 : 255;
            break;
          }
          case 2: {
            const rv = sample(i, 0);
            const gv = sample(i, 1);
            const bv = sample(i, 2);
            rgba[o] = to8(rv);
            rgba[o + 1] = to8(gv);
            rgba[o + 2] = to8(bv);
            rgba[o + 3] = trnsRgb && rv === trnsRgb[0] && gv === trnsRgb[1] && bv === trnsRgb[2] ? 0 : 255;
            break;
          }
          case 3: {
            const idx = sample(i, 0);
            const e = palette![idx];
            if (!e) fail(`Corrupt PNG: pixel uses index ${idx} beyond the ${palette!.length}-entry palette`);
            indices![p] = idx;
            rgba[o] = e.r;
            rgba[o + 1] = e.g;
            rgba[o + 2] = e.b;
            rgba[o + 3] = e.a;
            break;
          }
          case 4: {
            const g = to8(sample(i, 0));
            rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
            rgba[o + 3] = to8(sample(i, 1));
            break;
          }
          default: {
            rgba[o] = to8(sample(i, 0));
            rgba[o + 1] = to8(sample(i, 1));
            rgba[o + 2] = to8(sample(i, 2));
            rgba[o + 3] = to8(sample(i, 3));
          }
        }
      }
    }
  }
  return { ...header, rgba, indices, palette, texts, chunkTypes: chunks.map((c) => c.type) };
}
