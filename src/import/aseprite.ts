/**
 * .aseprite / .ase decoder, written against the official format spec
 * (aseprite/docs/ase-file-specs.md). Handles legacy and new chunk counts,
 * old and new palette chunks, layer groups and UUIDs, raw / linked /
 * compressed cels, tilemap cels and tilesets, tags (with repeat), slices
 * (9-patch and pivot). Cross-checked against the ase-parser package in tests.
 */
import { inflateSync } from "node:zlib";
import { fail } from "../util/errors.js";

export interface AseLayer {
  index: number;
  flags: number;
  /** 0 = image, 1 = group, 2 = tilemap */
  type: number;
  childLevel: number;
  blendMode: number;
  opacity: number;
  name: string;
  tilesetIndex?: number;
  visible: boolean;
  background: boolean;
  reference: boolean;
}

export interface AseTilemap {
  /** Size in tiles. */
  w: number;
  h: number;
  bitsPerTile: number;
  idMask: number;
  xFlipMask: number;
  yFlipMask: number;
  dFlipMask: number;
  tiles: Uint32Array;
}

export interface AseCel {
  layerIndex: number;
  x: number;
  y: number;
  opacity: number;
  /** 0 raw, 1 linked, 2 compressed image, 3 compressed tilemap */
  type: number;
  zIndex: number;
  w: number;
  h: number;
  /** Pixels in the file's color depth (4, 2 or 1 bytes per pixel). */
  pixels?: Uint8Array;
  linkFrame?: number;
  tilemap?: AseTilemap;
}

export interface AseFrame {
  duration: number;
  cels: AseCel[];
}

export interface AseTag {
  from: number;
  to: number;
  /** 0 forward, 1 reverse, 2 ping-pong, 3 ping-pong reverse */
  direction: number;
  repeat: number;
  name: string;
}

export interface AseSliceKey {
  frame: number;
  x: number;
  y: number;
  w: number;
  h: number;
  center?: { x: number; y: number; w: number; h: number };
  pivot?: { x: number; y: number };
}

export interface AseSlice {
  name: string;
  flags: number;
  keys: AseSliceKey[];
}

export interface AseTileset {
  id: number;
  flags: number;
  count: number;
  tileW: number;
  tileH: number;
  baseIndex: number;
  name: string;
  /** Vertical strip of tiles (tileW × tileH·count) in the file's color depth. */
  pixels?: Uint8Array;
}

export interface AsePaletteEntry {
  r: number;
  g: number;
  b: number;
  a: number;
  name?: string;
}

export interface AsepriteFile {
  width: number;
  height: number;
  colorDepth: 8 | 16 | 32;
  flags: number;
  transparentIndex: number;
  numColors: number;
  frames: AseFrame[];
  layers: AseLayer[];
  palette: AsePaletteEntry[];
  tags: AseTag[];
  slices: AseSlice[];
  tilesets: AseTileset[];
  hasColorProfile: boolean;
  warnings: string[];
}

class Reader {
  pos = 0;
  private readonly view: DataView;
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  need(n: number) {
    if (this.pos + n > this.buf.length) fail("Truncated .aseprite file");
  }
  byte() {
    this.need(1);
    return this.buf[this.pos++]!;
  }
  word() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  short() {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  dword() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  long() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytes(n: number) {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(n: number) {
    this.need(n);
    this.pos += n;
  }
  string() {
    const n = this.word();
    return new TextDecoder("utf-8").decode(this.bytes(n));
  }
}

function inflate(data: Uint8Array, what: string): Uint8Array {
  try {
    return new Uint8Array(inflateSync(data));
  } catch (e) {
    fail(`Corrupt .aseprite file: cannot decompress ${what} (${(e as Error).message})`);
  }
}

export function parseAseprite(buf: Uint8Array): AsepriteFile {
  const r = new Reader(buf);
  if (buf.length < 128) fail("Not an .aseprite file (too short)");
  r.dword(); // file size
  if (r.word() !== 0xa5e0) fail("Not an .aseprite file (bad magic number)");
  const frameCount = r.word();
  const width = r.word();
  const height = r.word();
  const depth = r.word();
  if (depth !== 8 && depth !== 16 && depth !== 32) fail(`Unsupported .aseprite color depth ${depth}`);
  const flags = r.dword();
  r.word(); // deprecated speed
  r.skip(8);
  const transparentIndex = r.byte();
  r.skip(3);
  const numColors = r.word();
  r.pos = 128;

  const file: AsepriteFile = {
    width,
    height,
    colorDepth: depth as 8 | 16 | 32,
    flags,
    transparentIndex,
    numColors,
    frames: [],
    layers: [],
    palette: [],
    tags: [],
    slices: [],
    tilesets: [],
    hasColorProfile: false,
    warnings: [],
  };
  const bpp = depth / 8;
  let oldPalette: AsePaletteEntry[] | undefined;
  let newPalette = false;

  for (let f = 0; f < frameCount; f++) {
    const frameStart = r.pos;
    const frameBytes = r.dword();
    if (r.word() !== 0xf1fa) fail(`Corrupt .aseprite file: bad frame magic in frame ${f}`);
    const oldChunks = r.word();
    const duration = r.word();
    r.skip(2);
    const newChunks = r.dword();
    const chunkCount = newChunks !== 0 ? newChunks : oldChunks;
    const frame: AseFrame = { duration, cels: [] };
    for (let c = 0; c < chunkCount; c++) {
      const chunkStart = r.pos;
      const size = r.dword();
      const type = r.word();
      const chunkEnd = chunkStart + size;
      if (size < 6 || chunkEnd > buf.length) fail(`Corrupt .aseprite file: bad chunk size in frame ${f}`);
      switch (type) {
        case 0x0004:
        case 0x0011: {
          const packets = r.word();
          const entries: AsePaletteEntry[] = oldPalette ?? [];
          let index = 0;
          for (let p = 0; p < packets; p++) {
            index += r.byte();
            const n = r.byte() || 256;
            for (let k = 0; k < n; k++) {
              const scale = type === 0x0011 ? (v: number) => Math.round((v * 255) / 63) : (v: number) => v;
              entries[index++] = { r: scale(r.byte()), g: scale(r.byte()), b: scale(r.byte()), a: 255 };
            }
          }
          oldPalette = entries;
          break;
        }
        case 0x2004: {
          const layerFlags = r.word();
          const layerType = r.word();
          const childLevel = r.word();
          r.word();
          r.word();
          const blendMode = r.word();
          const opacity = r.byte();
          r.skip(3);
          const name = r.string();
          const layer: AseLayer = {
            index: file.layers.length,
            flags: layerFlags,
            type: layerType,
            childLevel,
            blendMode,
            opacity: flags & 1 ? opacity : 255,
            name,
            visible: (layerFlags & 1) !== 0,
            background: (layerFlags & 8) !== 0,
            reference: (layerFlags & 64) !== 0,
          };
          if (layerType === 2) layer.tilesetIndex = r.dword();
          file.layers.push(layer);
          break;
        }
        case 0x2005: {
          const cel: AseCel = {
            layerIndex: r.word(),
            x: r.short(),
            y: r.short(),
            opacity: r.byte(),
            type: r.word(),
            zIndex: r.short(),
            w: 0,
            h: 0,
          };
          r.skip(5);
          if (cel.type === 0 || cel.type === 2) {
            cel.w = r.word();
            cel.h = r.word();
            const raw = cel.type === 0 ? r.bytes(cel.w * cel.h * bpp) : inflate(r.bytes(chunkEnd - r.pos), "cel pixels");
            if (raw.length < cel.w * cel.h * bpp) fail(`Corrupt .aseprite file: cel data too short in frame ${f}`);
            cel.pixels = raw.slice(0, cel.w * cel.h * bpp);
          } else if (cel.type === 1) {
            cel.linkFrame = r.word();
          } else if (cel.type === 3) {
            const w = r.word();
            const h = r.word();
            const bitsPerTile = r.word();
            const idMask = r.dword();
            const xFlipMask = r.dword();
            const yFlipMask = r.dword();
            const dFlipMask = r.dword();
            r.skip(10);
            const raw = inflate(r.bytes(chunkEnd - r.pos), "tilemap");
            const bytesPerTile = bitsPerTile / 8;
            const tiles = new Uint32Array(w * h);
            const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
            for (let i = 0; i < tiles.length && (i + 1) * bytesPerTile <= raw.length; i++) {
              tiles[i] = bytesPerTile === 4 ? dv.getUint32(i * 4, true) : bytesPerTile === 2 ? dv.getUint16(i * 2, true) : raw[i]!;
            }
            cel.tilemap = { w, h, bitsPerTile, idMask, xFlipMask, yFlipMask, dFlipMask, tiles };
          } else {
            file.warnings.push(`Unknown cel type ${cel.type} in frame ${f} was skipped.`);
            break;
          }
          frame.cels.push(cel);
          break;
        }
        case 0x2007:
          file.hasColorProfile = true;
          break;
        case 0x2018: {
          const count = r.word();
          r.skip(8);
          for (let t = 0; t < count; t++) {
            const from = r.word();
            const to = r.word();
            const direction = r.byte();
            const repeat = r.word();
            r.skip(6);
            r.skip(3);
            r.skip(1);
            file.tags.push({ from, to, direction, repeat, name: r.string() });
          }
          break;
        }
        case 0x2019: {
          const size2 = r.dword();
          const from = r.dword();
          const to = r.dword();
          r.skip(8);
          if (!newPalette) file.palette = [];
          newPalette = true;
          file.palette.length = Math.max(file.palette.length, size2);
          for (let i = from; i <= to; i++) {
            const entryFlags = r.word();
            const entry: AsePaletteEntry = { r: r.byte(), g: r.byte(), b: r.byte(), a: r.byte() };
            if (entryFlags & 1) entry.name = r.string();
            file.palette[i] = entry;
          }
          break;
        }
        case 0x2022: {
          const keyCount = r.dword();
          const sliceFlags = r.dword();
          r.dword();
          const slice: AseSlice = { name: r.string(), flags: sliceFlags, keys: [] };
          for (let k = 0; k < keyCount; k++) {
            const key: AseSliceKey = { frame: r.dword(), x: r.long(), y: r.long(), w: r.dword(), h: r.dword() };
            if (sliceFlags & 1) key.center = { x: r.long(), y: r.long(), w: r.dword(), h: r.dword() };
            if (sliceFlags & 2) key.pivot = { x: r.long(), y: r.long() };
            slice.keys.push(key);
          }
          file.slices.push(slice);
          break;
        }
        case 0x2023: {
          const tileset: AseTileset = {
            id: r.dword(),
            flags: r.dword(),
            count: r.dword(),
            tileW: r.word(),
            tileH: r.word(),
            baseIndex: r.short(),
            name: "",
          };
          r.skip(14);
          tileset.name = r.string();
          if (tileset.flags & 1) r.skip(8);
          if (tileset.flags & 2) {
            const len = r.dword();
            tileset.pixels = inflate(r.bytes(len), "tileset");
          }
          file.tilesets.push(tileset);
          break;
        }
        default:
          // 0x2006 cel extra, 0x2008 external files, 0x2016 mask, 0x2017 path, 0x2020 user data: not needed.
          break;
      }
      r.pos = chunkEnd;
    }
    file.frames.push(frame);
    r.pos = frameStart + frameBytes;
  }

  if (!newPalette && oldPalette) file.palette = oldPalette;
  for (let i = 0; i < file.palette.length; i++) file.palette[i] ??= { r: 0, g: 0, b: 0, a: 255 };

  // Resolve linked cels (follow chains) into copies.
  file.frames.forEach((frame, f) => {
    frame.cels = frame.cels.map((cel) => {
      let target = cel;
      for (let hops = 0; target.type === 1 && hops < file.frames.length; hops++) {
        const linked: AseCel | undefined = file.frames[target.linkFrame!]?.cels.find((c) => c.layerIndex === cel.layerIndex);
        if (!linked) {
          file.warnings.push(`Linked cel in frame ${f} points to a missing cel; skipped.`);
          return cel;
        }
        target = linked;
      }
      return target === cel ? cel : { ...target, layerIndex: cel.layerIndex, pixels: target.pixels?.slice() };
    }).filter((c) => c.type !== 1);
  });
  return file;
}

/** Renders a tilemap cel into pixels (file color depth) using its tileset. */
export function renderTilemapCel(file: AsepriteFile, layer: AseLayer, cel: AseCel): { w: number; h: number; pixels: Uint8Array } | undefined {
  const tm = cel.tilemap;
  const ts = file.tilesets.find((t) => t.id === layer.tilesetIndex) ?? file.tilesets[layer.tilesetIndex ?? -1];
  if (!tm || !ts?.pixels) return undefined;
  const bpp = file.colorDepth / 8;
  const w = tm.w * ts.tileW;
  const h = tm.h * ts.tileH;
  const out = new Uint8Array(w * h * bpp);
  if (file.colorDepth === 8) out.fill(file.transparentIndex); // empty tiles are transparent
  // Flag 4: tile ID 0 is the empty tile (current format); otherwise the all-ones ID is.
  const empty = ts.flags & 4 ? 0 : (0xffffffff & tm.idMask) >>> 0;
  for (let ty = 0; ty < tm.h; ty++) {
    for (let tx = 0; tx < tm.w; tx++) {
      const v = tm.tiles[ty * tm.w + tx]!;
      const id = v & tm.idMask;
      if (id === empty || id >= ts.count) continue;
      const xf = (v & tm.xFlipMask) !== 0;
      const yf = (v & tm.yFlipMask) !== 0;
      const df = (v & tm.dFlipMask) !== 0;
      for (let v2 = 0; v2 < ts.tileH; v2++) {
        for (let u = 0; u < ts.tileW; u++) {
          let sx = u;
          let sy = v2;
          if (df) [sx, sy] = [sy, sx];
          if (xf) sx = ts.tileW - 1 - sx;
          if (yf) sy = ts.tileH - 1 - sy;
          if (sx >= ts.tileW || sy >= ts.tileH) continue;
          const src = ((id * ts.tileH + sy) * ts.tileW + sx) * bpp;
          const dst = ((ty * ts.tileH + v2) * w + tx * ts.tileW + u) * bpp;
          for (let k = 0; k < bpp; k++) out[dst + k] = ts.pixels[src + k]!;
        }
      }
    }
  }
  return { w, h, pixels: out };
}

export const ASE_BLEND_NAMES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color dodge", "color burn", "hard light",
  "soft light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "addition", "subtract", "divide",
];

export const ASE_TAG_DIRECTIONS = ["forward", "reverse", "pingpong", "pingpong_reverse"] as const;
