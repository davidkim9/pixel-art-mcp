/** Test-only .aseprite writer used to build fixtures (validated against ase-parser in tests). */
import { deflateSync } from "node:zlib";

export interface WLayer {
  name: string;
  type?: 0 | 1 | 2;
  childLevel?: number;
  visible?: boolean;
  background?: boolean;
  reference?: boolean;
  blend?: number;
  opacity?: number;
  tilesetIndex?: number;
}

export interface WCel {
  layer: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Raw pixels in the file's color depth. */
  pixels?: ArrayLike<number>;
  opacity?: number;
  link?: number;
  raw?: boolean;
  zIndex?: number;
  tilemap?: { w: number; h: number; tiles: number[] };
}

export interface WFrame {
  duration: number;
  cels: WCel[];
}

export interface WFile {
  width: number;
  height: number;
  depth: 8 | 16 | 32;
  transparentIndex?: number;
  palette: Array<[number, number, number, number?]>;
  layers: WLayer[];
  frames: WFrame[];
  tags?: Array<{ from: number; to: number; dir?: number; repeat?: number; name: string }>;
  slices?: Array<{ name: string; keys: Array<{ frame: number; x: number; y: number; w: number; h: number; pivot?: { x: number; y: number } }> }>;
  tilesets?: Array<{ id: number; tileW: number; tileH: number; count: number; pixels: ArrayLike<number> }>;
  /** Write only the legacy 16-bit chunk count (new count = 0). */
  legacyChunkCount?: boolean;
  /** Also write an old-style 0x0004 palette chunk. */
  oldPalette?: boolean;
  layerUuids?: boolean;
}

class W {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 255);
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
    this.u16(b.length);
    for (const v of b) this.u8(v);
    return this;
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.u8(b[i]!);
    return this;
  }
  get length() {
    return this.parts.length;
  }
  buffer() {
    return Buffer.from(this.parts);
  }
}

function chunk(type: number, body: W): Buffer {
  const head = new W().u32(body.length + 6).u16(type);
  return Buffer.concat([head.buffer(), body.buffer()]);
}

export function writeAseprite(f: WFile): Buffer {
  const frames: Buffer[] = [];
  f.frames.forEach((frame, fi) => {
    const chunks: Buffer[] = [];
    if (fi === 0) {
      if (f.oldPalette) {
        const b = new W().u16(1).u8(0).u8(f.palette.length === 256 ? 0 : f.palette.length);
        for (const [r, g, bl] of f.palette) b.u8(r).u8(g).u8(bl);
        chunks.push(chunk(0x0004, b));
      }
      for (const l of f.layers) {
        const flags = (l.visible === false ? 0 : 1) | 2 | (l.background ? 8 : 0) | (l.reference ? 64 : 0);
        const b = new W().u16(flags).u16(l.type ?? 0).u16(l.childLevel ?? 0).u16(0).u16(0).u16(l.blend ?? 0).u8(l.opacity ?? 255).zeros(3).str(l.name);
        if ((l.type ?? 0) === 2) b.u32(l.tilesetIndex ?? 0);
        if (f.layerUuids) b.zeros(16);
        chunks.push(chunk(0x2004, b));
      }
      if (f.tags?.length) {
        const b = new W().u16(f.tags.length).zeros(8);
        for (const t of f.tags) b.u16(t.from).u16(t.to).u8(t.dir ?? 0).u16(t.repeat ?? 0).zeros(6).u8(0).u8(0).u8(0).u8(0).str(t.name);
        chunks.push(chunk(0x2018, b));
      }
      const pb = new W().u32(f.palette.length).u32(0).u32(f.palette.length - 1).zeros(8);
      for (const [r, g, b, a] of f.palette) pb.u16(0).u8(r).u8(g).u8(b).u8(a ?? 255);
      chunks.push(chunk(0x2019, pb));
      for (const s of f.slices ?? []) {
        const hasPivot = s.keys.some((k) => k.pivot);
        const b = new W().u32(s.keys.length).u32(hasPivot ? 2 : 0).u32(0).str(s.name);
        for (const k of s.keys) {
          b.u32(k.frame).i32(k.x).i32(k.y).u32(k.w).u32(k.h);
          if (hasPivot) b.i32(k.pivot?.x ?? 0).i32(k.pivot?.y ?? 0);
        }
        chunks.push(chunk(0x2022, b));
      }
      for (const t of f.tilesets ?? []) {
        const data = deflateSync(Buffer.from(Array.from(t.pixels)));
        const b = new W().u32(t.id).u32(2 | 4).u32(t.count).u16(t.tileW).u16(t.tileH).i16(1).zeros(14).str(`tileset${t.id}`).u32(data.length).bytes(data);
        chunks.push(chunk(0x2023, b));
      }
    }
    for (const c of frame.cels) {
      const type = c.link !== undefined ? 1 : c.tilemap ? 3 : c.raw ? 0 : 2;
      const b = new W().u16(c.layer).i16(c.x ?? 0).i16(c.y ?? 0).u8(c.opacity ?? 255).u16(type).i16(c.zIndex ?? 0).zeros(5);
      if (type === 1) b.u16(c.link!);
      else if (type === 3) {
        const tiles = new W();
        for (const t of c.tilemap!.tiles) tiles.u32(t);
        b.u16(c.tilemap!.w).u16(c.tilemap!.h).u16(32).u32(0x1fffffff).u32(0x20000000).u32(0x40000000).u32(0x80000000).zeros(10).bytes(deflateSync(tiles.buffer()));
      } else {
        b.u16(c.w!).u16(c.h!);
        const px = Buffer.from(Array.from(c.pixels!));
        b.bytes(type === 0 ? px : deflateSync(px));
      }
      chunks.push(chunk(0x2005, b));
    }
    const body = Buffer.concat(chunks);
    const head = new W()
      .u32(16 + body.length)
      .u16(0xf1fa)
      .u16(f.legacyChunkCount ? chunks.length : Math.min(chunks.length, 0xffff))
      .u16(frame.duration)
      .zeros(2)
      .u32(f.legacyChunkCount ? 0 : chunks.length);
    frames.push(Buffer.concat([head.buffer(), body]));
  });
  const body = Buffer.concat(frames);
  const header = new W()
    .u32(128 + body.length)
    .u16(0xa5e0)
    .u16(f.frames.length)
    .u16(f.width)
    .u16(f.height)
    .u16(f.depth)
    .u32(1 | (f.layerUuids ? 4 : 0))
    .u16(100)
    .zeros(8)
    .u8(f.transparentIndex ?? 0)
    .zeros(3)
    .u16(f.palette.length)
    .u8(1)
    .u8(1)
    .i16(0)
    .i16(0)
    .u16(16)
    .u16(16)
    .zeros(84);
  return Buffer.concat([header.buffer(), body]);
}
