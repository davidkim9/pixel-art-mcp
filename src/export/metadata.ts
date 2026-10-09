import type { DocKind, Point, Rect, SheetLayout, TagDirection } from "../types.js";

export const METADATA_VERSION = 1;
/** PNG tEXt keyword for embedded metadata. */
export const METADATA_KEYWORD = "pixelmcp";

export interface UvRect {
  offsetX: number;
  offsetY: number;
  repeatX: number;
  repeatY: number;
}

export interface FrameMeta {
  name: string;
  /** Image space: origin top-left, y down. */
  rect: Rect;
  /** Three.js texture space (flipY = true): plug into texture.offset / texture.repeat. */
  uv: UvRect;
  durationMs: number;
  /** Pivot relative to rect's top-left, image space. */
  pivotPx: Point;
  /** THREE.Sprite.center: (0,0) bottom-left, (1,1) top-right of the frame. */
  center: Point;
  /** Where the rect's top-left sits in the source canvas (trimmed frames and character parts). */
  offsetPx?: Point;
  /** Separate image for this frame (character "parts" export). */
  image?: string;
  [extra: string]: unknown;
}

export interface TagMeta {
  name: string;
  from: number;
  to: number;
  direction: TagDirection;
}

export type LayoutMeta =
  | { type: "png" }
  | { type: "spritesheet"; layout: SheetLayout; padding: number; extrude: number; columns?: number; tag?: string }
  | { type: "tileset"; padding: number; extrude: number; columns: number }
  | { type: "icons"; padding: number; extrude: number; columns: number }
  | { type: "character"; mode: "atlas" | "parts"; padding: number; extrude: number };

export interface AssetMetadata {
  version: number;
  name: string;
  kind: DocKind;
  /** Main image, relative to this metadata file. Absent for character "parts" exports. */
  image?: string;
  /** Additive glow image with the same frame layout. */
  glow?: string;
  size: { w: number; h: number };
  /** Canvas size of the source document. */
  sourceSize: { w: number; h: number };
  pixelsPerUnit: number;
  paletteId: string;
  layout: LayoutMeta;
  frames: FrameMeta[];
  tags: TagMeta[];
  tileset?: Record<string, unknown>;
  icons?: Record<string, number>;
  icon?: { size: number; margin: number };
  character?: Record<string, unknown>;
}

export interface ExportFrame {
  name: string;
  pixels: Uint8Array;
  glow?: Uint8Array;
  w: number;
  h: number;
  durationMs: number;
  /** Pivot relative to this frame image's top-left. */
  pivot: Point;
  offset?: Point;
  extra?: Record<string, unknown>;
}

export function uvFor(rect: Rect, W: number, H: number): UvRect {
  return {
    offsetX: rect.x / W,
    offsetY: (H - rect.y - rect.h) / H, // = 1 - (rect.y + rect.h) / H
    repeatX: rect.w / W,
    repeatY: rect.h / H,
  };
}

export function centerFor(pivot: Point, rect: Rect): Point {
  return {
    x: rect.w === 0 ? 0.5 : pivot.x / rect.w,
    y: rect.h === 0 ? 0.5 : (rect.h - pivot.y) / rect.h, // = 1 - pivotPx.y / rect.h
  };
}

export function frameMeta(f: ExportFrame, pos: Point, W: number, H: number): FrameMeta {
  const rect = { x: pos.x, y: pos.y, w: f.w, h: f.h };
  const meta: FrameMeta = {
    name: f.name,
    rect,
    uv: uvFor(rect, W, H),
    durationMs: f.durationMs,
    pivotPx: { x: f.pivot.x, y: f.pivot.y },
    center: centerFor(f.pivot, rect),
  };
  if (f.offset) meta.offsetPx = { x: f.offset.x, y: f.offset.y };
  if (f.extra) Object.assign(meta, f.extra);
  return meta;
}
