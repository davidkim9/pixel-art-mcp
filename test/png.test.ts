import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { crc32, decodePng, encodeIndexedPng, encodeRgbaPng, readPngInfo } from "../src/png.js";
import { pngjsDecode } from "./helpers.js";

/** Deterministic pseudo-random numbers for fixtures. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Test-only PNG writer for any color type / bit depth / interlace, cycling
 * through all five filter types so the decoder's unfiltering is exercised.
 */
function encodeRaw(o: {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  interlace: boolean;
  sample: (x: number, y: number, c: number) => number;
  plte?: Buffer;
  trns?: Buffer;
}): Buffer {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[o.colorType]!;
  const bpp = Math.max(1, (channels * o.bitDepth) >> 3);
  const passes = o.interlace ? ADAM7 : [[0, 0, 1, 1]];
  const raw: number[] = [];
  let filterType = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((o.width - x0!) / dx!);
    const ph = Math.ceil((o.height - y0!) / dy!);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * channels * o.bitDepth) / 8);
    let prev = new Array<number>(rowBytes).fill(0);
    for (let r = 0; r < ph; r++) {
      const row = new Array<number>(rowBytes).fill(0);
      let bit = 0;
      for (let i = 0; i < pw; i++) {
        for (let c = 0; c < channels; c++) {
          const v = o.sample(x0! + i * dx!, y0! + r * dy!, c);
          if (o.bitDepth === 16) {
            row[bit >> 3] = v >> 8;
            row[(bit >> 3) + 1] = v & 255;
          } else if (o.bitDepth === 8) row[bit >> 3] = v;
          else row[bit >> 3]! |= v << (8 - o.bitDepth - (bit & 7));
          bit += o.bitDepth;
        }
      }
      const f = filterType++ % 5;
      raw.push(f);
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        const up = prev[i]!;
        const ul = i >= bpp ? prev[i - bpp]! : 0;
        const pred = [0, left, up, (left + up) >> 1, paeth(left, up, ul)][f]!;
        raw.push((row[i]! - pred) & 255);
      }
      prev = row;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0);
  ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = o.bitDepth;
  ihdr[9] = o.colorType;
  ihdr[12] = o.interlace ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(o.plte ? [chunk("PLTE", o.plte)] : []),
    ...(o.trns ? [chunk("tRNS", o.trns)] : []),
    chunk("IDAT", deflateSync(Buffer.from(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Zero RGB where alpha is 0 (pngjs clears RGB for tRNS-transparent pixels). */
function normalize(rgba: Uint8Array): number[] {
  const out = Array.from(rgba);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out[i] = out[i + 1] = out[i + 2] = 0;
  return out;
}

describe("PNG decoder vs pngjs", () => {
  const combos: Array<[number, number]> = [
    [0, 1], [0, 2], [0, 4], [0, 8], [0, 16],
    [2, 8], [2, 16],
    [3, 1], [3, 2], [3, 4], [3, 8],
    [4, 8], [4, 16],
    [6, 8], [6, 16],
  ];
  for (const [colorType, bitDepth] of combos) {
    for (const interlace of [false, true]) {
      for (const [w, h] of [[13, 7], [1, 1], [3, 2], [9, 17]] as const) {
        it(`color type ${colorType}, ${bitDepth}-bit, ${interlace ? "interlaced" : "progressive"}, ${w}x${h}`, () => {
          const rand = rng(colorType * 1000 + bitDepth * 10 + w + h * 31 + (interlace ? 7 : 0));
          const max = (1 << bitDepth) - 1;
          const paletteSize = colorType === 3 ? Math.min(1 << bitDepth, 20) : 0;
          const values = new Map<string, number>();
          const sample = (x: number, y: number, c: number) => {
            const key = `${x},${y},${c}`;
            if (!values.has(key)) values.set(key, colorType === 3 ? Math.floor(rand() * paletteSize) : Math.floor(rand() * (max + 1)));
            return values.get(key)!;
          };
          let plte: Buffer | undefined;
          let trns: Buffer | undefined;
          if (colorType === 3) {
            plte = Buffer.from(Array.from({ length: paletteSize * 3 }, () => Math.floor(rand() * 256)));
            trns = Buffer.from([0, 128, 255].slice(0, paletteSize));
          } else if (colorType === 0) {
            trns = Buffer.alloc(2);
            trns.writeUInt16BE(sample(0, 0, 0));
          } else if (colorType === 2) {
            trns = Buffer.alloc(6);
            trns.writeUInt16BE(sample(0, 0, 0), 0);
            trns.writeUInt16BE(sample(0, 0, 1), 2);
            trns.writeUInt16BE(sample(0, 0, 2), 4);
          }
          const buf = encodeRaw({ width: w, height: h, colorType, bitDepth, interlace, sample, plte, trns });
          const mine = decodePng(buf);
          const ref = pngjsDecode(buf);
          expect(mine.width).toBe(ref.width);
          expect(mine.height).toBe(ref.height);
          expect(normalize(mine.rgba)).toEqual(normalize(ref.data));
          if (colorType === 3) {
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect(mine.indices![y * w + x]).toBe(sample(x, y, 0));
          }
        });
      }
    }
  }
});

describe("PNG encoder", () => {
  const palette = [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 0, b: 77 },
    { r: 41, g: 173, b: 255 },
    { r: 255, g: 241, b: 232 },
  ];
  const indices = Uint8Array.from([0, 1, 2, 3, 3, 2, 1, 0, 1, 1, 0, 0]);

  it("writes indexed PNGs that pngjs reads, with index 0 transparent", () => {
    const buf = encodeIndexedPng({ width: 4, height: 3, indices, palette });
    const ref = pngjsDecode(buf);
    for (let i = 0; i < indices.length; i++) {
      const c = palette[indices[i]!]!;
      if (indices[i] === 0) expect(ref.data[i * 4 + 3]).toBe(0);
      else expect([...ref.data.subarray(i * 4, i * 4 + 4)]).toEqual([c.r, c.g, c.b, 255]);
    }
  });

  it("round-trips indices, palette and text chunks through the decoder", () => {
    const texts = [{ keyword: "pixelmcp", text: '{"a":1,"name":"caf\\u00e9"}' }];
    const buf = encodeIndexedPng({ width: 4, height: 3, indices, palette, texts });
    const dec = decodePng(buf);
    expect(dec.colorType).toBe(3);
    expect(dec.bitDepth).toBe(8);
    expect([...dec.indices!]).toEqual([...indices]);
    expect(dec.palette!.map((e) => [e.r, e.g, e.b, e.a])).toEqual(palette.map((c, i) => [c.r, c.g, c.b, i === 0 ? 0 : 255]));
    expect(dec.texts).toEqual(texts);
    expect(readPngInfo(buf).texts).toEqual(texts);
    expect(dec.chunkTypes).toEqual(["IHDR", "PLTE", "tRNS", "tEXt", "IDAT", "IEND"]);
  });

  it("is deterministic", () => {
    const a = encodeIndexedPng({ width: 4, height: 3, indices, palette });
    const b = encodeIndexedPng({ width: 4, height: 3, indices: indices.slice(), palette: palette.map((c) => ({ ...c })) });
    expect(a.equals(b)).toBe(true);
  });

  it("writes RGBA PNGs that pngjs reads back exactly", () => {
    const rand = rng(42);
    const w = 37;
    const h = 11;
    const rgba = Uint8Array.from({ length: w * h * 4 }, () => Math.floor(rand() * 256));
    const ref = pngjsDecode(encodeRgbaPng(w, h, rgba));
    expect([...ref.data]).toEqual([...rgba]);
  });

  it("decodes PNGs written by pngjs", () => {
    const png = new PNG({ width: 5, height: 4 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = (i * 37) & 255;
    const buf = PNG.sync.write(png);
    expect([...decodePng(buf).rgba]).toEqual([...png.data]);
  });

  it("rejects corrupt data", () => {
    const buf = encodeIndexedPng({ width: 4, height: 3, indices, palette });
    const bad = Buffer.from(buf);
    bad[bad.length - 20] ^= 0xff;
    expect(() => decodePng(bad)).toThrow(/CRC|Corrupt/);
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/signature/);
  });
});
