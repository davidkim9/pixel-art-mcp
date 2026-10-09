import { encodeRgbaPng } from "../png.js";
import { GLYPH_H, GLYPH_W, glyph, textWidth } from "./font.js";

export type Color = [number, number, number, number?];

/** Straight-alpha RGBA raster used to build preview images. */
export class RgbaImage {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    fill: Color = [0, 0, 0, 0],
  ) {
    this.data = new Uint8Array(width * height * 4);
    if (fill.some((v) => (v ?? 255) !== 0)) this.fillRect(0, 0, width, height, fill);
  }

  set(x: number, y: number, c: Color): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 4;
    this.data[o] = c[0];
    this.data[o + 1] = c[1];
    this.data[o + 2] = c[2];
    this.data[o + 3] = c[3] ?? 255;
  }

  /** Blends an opaque color over the pixel with the given opacity (0–1). */
  blend(x: number, y: number, c: Color, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 4;
    const d = this.data;
    const a0 = d[o + 3]! / 255;
    const outA = alpha + a0 * (1 - alpha);
    if (outA <= 0) return;
    for (let i = 0; i < 3; i++) d[o + i] = Math.round((c[i]! * alpha + d[o + i]! * a0 * (1 - alpha)) / outA);
    d[o + 3] = Math.round(outA * 255);
  }

  fillRect(x: number, y: number, w: number, h: number, c: Color): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) this.set(xx, yy, c);
    }
  }

  blendRect(x: number, y: number, w: number, h: number, c: Color, alpha: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) this.blend(xx, yy, c, alpha);
    }
  }

  strokeRect(x: number, y: number, w: number, h: number, c: Color, thickness = 1): void {
    this.fillRect(x, y, w, thickness, c);
    this.fillRect(x, y + h - thickness, w, thickness, c);
    this.fillRect(x, y, thickness, h, c);
    this.fillRect(x + w - thickness, y, thickness, h, c);
  }

  /** Draws text with its top-left corner at (x, y). */
  text(x: number, y: number, text: string, c: Color, scale = 2): void {
    let cx = x;
    for (const ch of text) {
      const g = glyph(ch);
      for (let gy = 0; gy < GLYPH_H; gy++) {
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (g[gy]![gx]) this.fillRect(cx + gx * scale, y + gy * scale, scale, scale, c);
        }
      }
      cx += (GLYPH_W + 1) * scale;
    }
  }

  /** Text on a solid backing box, for labels drawn over artwork. */
  label(x: number, y: number, text: string, fg: Color, bg: Color, scale = 2): void {
    const pad = scale;
    this.fillRect(x, y, textWidth(text, scale) + pad * 2, 5 * scale + pad * 2, bg);
    this.text(x + pad, y + pad, text, fg, scale);
  }

  /** Copies another image (alpha-composited) with its top-left at (dx, dy). */
  draw(src: RgbaImage, dx: number, dy: number): void {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const o = (y * src.width + x) * 4;
        const a = src.data[o + 3]!;
        if (a === 0) continue;
        const c: Color = [src.data[o]!, src.data[o + 1]!, src.data[o + 2]!];
        if (a === 255) this.set(dx + x, dy + y, c);
        else this.blend(dx + x, dy + y, c, a / 255);
      }
    }
  }

  toPng(): Buffer {
    return encodeRgbaPng(this.width, this.height, this.data);
  }
}

/** Truncates text so it fits in `maxWidth` pixels at `scale`. */
export function fitText(text: string, maxWidth: number, scale: number): string {
  let t = text;
  while (t.length > 0 && textWidth(t, scale) > maxWidth) t = t.slice(0, -1);
  return t;
}
