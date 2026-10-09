import { describe, expect, it } from "vitest";
import { encodeGif } from "../src/gif.js";
import { createPalette, parsePaletteText, PaletteMatcher } from "../src/palette.js";
import { Painter, ellipsePoints, floodRegion, linePoints } from "../src/raster.js";
import { offsetCel, rotateSelected, flipSelected, moveSelected, rectMask } from "../src/selection.js";

/** Minimal GIF decoder (global color table, full-frame images) used to verify the encoder. */
function decodeGif(buf: Buffer) {
  let p = 0;
  const byte = () => buf[p++]!;
  const word = () => byte() | (byte() << 8);
  expect(buf.subarray(0, 6).toString("latin1")).toBe("GIF89a");
  p = 6;
  const width = word();
  const height = word();
  const packed = byte();
  p += 2;
  const tableSize = 2 << (packed & 7);
  p += tableSize * 3;
  const frames: Array<{ indices: number[]; delay: number; transparent: number | null }> = [];
  let delay = 0;
  let transparent: number | null = null;
  for (;;) {
    const b = byte();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        byte();
        const flags = byte();
        delay = word();
        const t = byte();
        transparent = flags & 1 ? t : null;
        byte();
      } else {
        for (let size = byte(); size > 0; size = byte()) p += size;
      }
      continue;
    }
    expect(b).toBe(0x2c);
    p += 8;
    byte();
    const minCodeSize = byte();
    const data: number[] = [];
    for (let size = byte(); size > 0; size = byte()) for (let i = 0; i < size; i++) data.push(byte());
    // LZW decode
    const clear = 1 << minCodeSize;
    const eoi = clear + 1;
    let codeSize = minCodeSize + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = [];
      for (let i = 0; i < clear; i++) dict[i] = [i];
      dict[clear] = [];
      dict[eoi] = [];
      codeSize = minCodeSize + 1;
    };
    reset();
    const out: number[] = [];
    let bitPos = 0;
    let prev: number[] | null = null;
    for (;;) {
      let code = 0;
      for (let i = 0; i < codeSize; i++) {
        code |= ((data[(bitPos + i) >> 3]! >> ((bitPos + i) & 7)) & 1) << i;
      }
      bitPos += codeSize;
      if (code === clear) {
        reset();
        prev = null;
        continue;
      }
      if (code === eoi) break;
      let entry: number[];
      if (code < dict.length) entry = dict[code]!;
      else entry = [...prev!, prev![0]!];
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]!]);
      prev = entry;
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    frames.push({ indices: out, delay, transparent });
  }
  return { width, height, frames };
}

describe("GIF encoder", () => {
  it("round-trips frames through LZW, including table resets", () => {
    const w = 97;
    const h = 61;
    let seed = 7;
    const noise = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 200;
    const frames = [0, 1, 2].map((k) => ({
      indices: Uint8Array.from({ length: w * h }, (_, i) => (k === 0 ? noise() : (i * (k + 3)) % 200)),
      delayMs: 80 + k * 10,
    }));
    const palette = Array.from({ length: 200 }, (_, i) => ({ r: i, g: 255 - i, b: (i * 7) & 255 }));
    const gif = encodeGif({ width: w, height: h, palette, transparentIndex: 0, frames });
    const dec = decodeGif(gif);
    expect(dec.width).toBe(w);
    expect(dec.height).toBe(h);
    expect(dec.frames.length).toBe(3);
    dec.frames.forEach((f, k) => {
      expect(f.indices).toEqual([...frames[k]!.indices]);
      expect(f.delay).toBe(Math.round(frames[k]!.delayMs / 10));
      expect(f.transparent).toBe(0);
    });
  });

  it("handles tiny palettes", () => {
    const gif = encodeGif({ width: 3, height: 1, palette: [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }], transparentIndex: null, frames: [{ indices: Uint8Array.from([1, 0, 1]), delayMs: 100 }] });
    expect(decodeGif(gif).frames[0]!.indices).toEqual([1, 0, 1]);
  });
});

describe("palette parsing", () => {
  it("parses GIMP palettes", () => {
    const p = parsePaletteText("GIMP Palette\nName: Test\nColumns: 4\n#\n255   0   0\tRed\n  0 255   0 Green\n0 0 255\n");
    expect(p).toEqual({ colors: ["#ff0000", "#00ff00", "#0000ff"], format: "gpl", name: "Test" });
  });
  it("parses Lospec .hex files and hex lists", () => {
    expect(parsePaletteText("ff0000\n00ff00\r\n0000ff\n").colors).toEqual(["#ff0000", "#00ff00", "#0000ff"]);
    expect(parsePaletteText("#abc, #123456").colors).toEqual(["#aabbcc", "#123456"]);
  });
  it("inserts transparent index 0 and rejects partial alpha", () => {
    const p = createPalette("t", "T", ["#ff0000"]);
    expect(p.colors).toEqual(["#000000", "#ff0000"]);
    expect(() => createPalette("t", "T", ["#ff000080"])).toThrow(/alpha/);
    expect(() => createPalette("t", "T", Array.from({ length: 256 }, () => "#000000"))).toThrow(/maximum is 255/);
  });
  it("matches colors exactly and by OKLab distance", () => {
    const m = new PaletteMatcher(createPalette("t", "T", ["#000000", "#ff0000", "#00ff00", "#ff0000"]));
    expect(m.exact(255, 0, 0)).toBe(2);
    expect(m.exact(1, 2, 3)).toBeUndefined();
    expect(m.nearest(250, 10, 10)).toBe(2);
    expect(m.nearest(10, 10, 10)).toBe(1);
  });
});

function render(points: Array<[number, number]>, w: number, h: number): string[] {
  const rows = Array.from({ length: h }, () => new Array<string>(w).fill("."));
  for (const [x, y] of points) rows[y]![x] = "#";
  return rows.map((r) => r.join(""));
}

describe("raster primitives", () => {
  it("draws Bresenham lines without doubled corners, direction-independent", () => {
    const pts = linePoints(0, 0, 5, 2);
    expect(pts).toEqual([[0, 0], [1, 0], [2, 1], [3, 1], [4, 2], [5, 2]]);
    expect(linePoints(5, 2, 0, 0)).toEqual(pts);
    for (const [x1, y1] of [[7, 3], [3, 7], [-6, 4], [5, -5], [0, 6], [6, 0]] as const) {
      const line = linePoints(0, 0, x1, y1);
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1]!;
        const [bx, by] = line[i]!;
        expect(Math.max(Math.abs(bx - ax), Math.abs(by - ay))).toBe(1);
      }
      // no L-shapes: a step never moves only in the minor axis
      for (let i = 2; i < line.length; i++) {
        const [ax, ay] = line[i - 2]!;
        const [cx, cy] = line[i]!;
        expect(Math.abs(cx - ax) + Math.abs(cy - ay)).toBeGreaterThan(1);
      }
    }
  });

  it("draws pixel-perfect ellipses of odd and even sizes", () => {
    expect(render(ellipsePoints(0, 0, 2, 2, false), 3, 3)).toEqual([".#.", "#.#", ".#."]);
    expect(render(ellipsePoints(0, 0, 3, 3, false), 4, 4)).toEqual([".##.", "#..#", "#..#", ".##."]);
    expect(render(ellipsePoints(0, 0, 4, 4, false), 5, 5)).toEqual([".###.", "#...#", "#...#", "#...#", ".###."]);
    expect(render(ellipsePoints(0, 0, 3, 3, true), 4, 4)).toEqual([".##.", "####", "####", ".##."]);
    expect(render(ellipsePoints(0, 0, 0, 4, false), 1, 5)).toEqual(["#", "#", "#", "#", "#"]);
    expect(render(ellipsePoints(0, 0, 1, 1, false), 2, 2)).toEqual(["##", "##"]);
    const big = render(ellipsePoints(0, 0, 15, 9, false), 16, 10);
    for (const row of big) expect(row).toBe([...row].reverse().join("")); // horizontally symmetric
    expect(big).toEqual([...big].reverse()); // vertically symmetric
  });

  it("flood fills across wrapped edges", () => {
    const cel = Uint8Array.from([1, 0, 1, 0, 0, 0]);
    expect(floodRegion(cel, 3, 2, 0, 0, false)).toEqual([0]);
    expect(floodRegion(cel, 3, 2, 0, 0, true)).toEqual([0, 2]);
    expect(floodRegion(Uint8Array.from([1, 0, 1, 1, 0, 1, 1, 1, 1]), 3, 3, 0, 0, false)).toEqual([0, 2, 3, 5, 6, 7, 8]);
  });

  it("applies symmetry with explicit pixels winning", () => {
    const cel = new Uint8Array(8);
    const painter = new Painter(cel, 8, 1, { wrap: false, symmetry: { mode: "horizontal", axisX: 4, axisY: 0.5 } });
    painter.plot(0, 0, 1);
    painter.plot(7, 0, 2);
    painter.plot(2, 0, 3);
    painter.commit();
    expect([...cel]).toEqual([1, 0, 3, 0, 0, 3, 0, 2]);
  });

  it("wraps writes when wrap mode is on and counts clipped pixels otherwise", () => {
    const cel = new Uint8Array(4);
    const wrap = new Painter(cel, 2, 2, { wrap: true });
    wrap.plot(2, -1, 5);
    expect(wrap.commit()).toEqual({ changed: 1, outOfBounds: 0 });
    expect(cel[2]).toBe(5);
    const clip = new Painter(cel, 2, 2, { wrap: false });
    clip.plot(2, 0, 1);
    expect(clip.commit()).toEqual({ changed: 0, outOfBounds: 1 });
  });
});

describe("selection transforms", () => {
  const cel = Uint8Array.from([
    1, 2, 0, 0,
    3, 4, 0, 0,
    0, 0, 0, 0,
  ]);
  const mask = rectMask(4, 3, { x: 0, y: 0, w: 2, h: 2 });

  it("moves selected pixels and the mask", () => {
    const r = moveSelected(cel, mask, 4, 3, 2, 1, false);
    expect([...r.cel]).toEqual([0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 3, 4]);
    expect([...r.mask]).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);
  });

  it("flips and rotates within the selection bounds", () => {
    expect([...flipSelected(cel, mask, 4, 3, "horizontal").cel].slice(0, 6)).toEqual([2, 1, 0, 0, 4, 3]);
    expect([...rotateSelected(cel, mask, 4, 3, 1, false).cel].slice(0, 6)).toEqual([3, 1, 0, 0, 4, 2]);
    expect([...rotateSelected(cel, mask, 4, 3, 4, false).cel]).toEqual([...cel]);
  });

  it("offsets layers with wrap-around", () => {
    expect([...offsetCel(Uint8Array.from([1, 2, 3]), 3, 1, 1, 0, true)]).toEqual([3, 1, 2]);
    expect([...offsetCel(Uint8Array.from([1, 2, 3]), 3, 1, 1, 0, false)]).toEqual([0, 1, 2]);
  });
});
