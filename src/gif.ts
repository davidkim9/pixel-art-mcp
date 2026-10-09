/** Minimal animated GIF89a encoder for indexed frames (used by export_gif). */
import type { RGB } from "./color.js";
import { fail } from "./util/errors.js";

export interface GifFrame {
  indices: Uint8Array;
  delayMs: number;
}

export interface GifInput {
  width: number;
  height: number;
  /** Global color table (≤ 256 entries). */
  palette: RGB[];
  /** Palette index rendered as transparent, or null. */
  transparentIndex: number | null;
  frames: GifFrame[];
  /** Loop forever (default true). */
  loop?: boolean;
}

class ByteWriter {
  private chunks: number[] = [];
  byte(v: number) {
    this.chunks.push(v & 0xff);
  }
  word(v: number) {
    this.byte(v);
    this.byte(v >> 8);
  }
  bytes(values: ArrayLike<number>) {
    for (let i = 0; i < values.length; i++) this.chunks.push(values[i]! & 0xff);
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  toBuffer(): Buffer {
    return Buffer.from(this.chunks);
  }
}

/** GIF-flavoured LZW (variable code size, clear code when the table fills). */
export function lzwEncode(minCodeSize: number, indices: Uint8Array): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out: number[] = [];
  let cur = 0;
  let curBits = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let table = new Map<number, number>();

  const emit = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>>= 8;
      curBits -= 8;
    }
  };

  emit(clearCode);
  if (indices.length === 0) {
    emit(eoiCode);
    if (curBits > 0) out.push(cur & 0xff);
    return Uint8Array.from(out);
  }
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      table = new Map();
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      table.set(key, nextCode++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (curBits > 0) out.push(cur & 0xff);
  return Uint8Array.from(out);
}

export function encodeGif(input: GifInput): Buffer {
  const { width, height, palette, frames } = input;
  if (palette.length === 0 || palette.length > 256) fail("GIF palette must have 1–256 colors");
  if (frames.length === 0) fail("GIF needs at least one frame");
  let tableBits = 1;
  while (1 << tableBits < palette.length) tableBits++;
  const tableSize = 1 << tableBits;
  const minCodeSize = Math.max(2, tableBits);

  const w = new ByteWriter();
  w.ascii("GIF89a");
  w.word(width);
  w.word(height);
  w.byte(0x80 | ((tableBits - 1) << 4) | (tableBits - 1)); // global table, color resolution, size
  w.byte(0); // background color index
  w.byte(0); // pixel aspect ratio
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] ?? { r: 0, g: 0, b: 0 };
    w.byte(c.r);
    w.byte(c.g);
    w.byte(c.b);
  }
  if (input.loop !== false && frames.length > 1) {
    w.byte(0x21);
    w.byte(0xff);
    w.byte(11);
    w.ascii("NETSCAPE2.0");
    w.byte(3);
    w.byte(1);
    w.word(0); // loop forever
    w.byte(0);
  }
  for (const frame of frames) {
    if (frame.indices.length !== width * height) fail("GIF frame size does not match the image size");
    const transparent = input.transparentIndex;
    // Graphic control extension: disposal 2 (restore to background) so transparency doesn't accumulate.
    w.byte(0x21);
    w.byte(0xf9);
    w.byte(4);
    w.byte((2 << 2) | (transparent !== null ? 1 : 0));
    w.word(Math.max(0, Math.round(frame.delayMs / 10)));
    w.byte(transparent ?? 0);
    w.byte(0);
    // Image descriptor
    w.byte(0x2c);
    w.word(0);
    w.word(0);
    w.word(width);
    w.word(height);
    w.byte(0);
    w.byte(minCodeSize);
    const data = lzwEncode(minCodeSize, frame.indices);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.subarray(i, i + 255);
      w.byte(block.length);
      w.bytes(block);
    }
    w.byte(0);
  }
  w.byte(0x3b);
  return w.toBuffer();
}
