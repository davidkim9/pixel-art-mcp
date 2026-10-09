import type { DocKind, Point, Rect, SheetLayout, TagDirection } from "../types.js";

export const METADATA_VERSION = 1;
/** PNG tEXt keyword for embedded metadata. */
export const METADATA_KEYWORD = "pixelmcp";

export interface FrameMeta {
  name: string;
  /** Pixel rectangle in the image: origin top-left, y down. */
  rect: Rect;
  durationMs: number;
  /** Pivot relative to rect's top-left, in pixels. */
  pivotPx: Point;
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
  | { type: "character"; mode: "atlas" | "parts"; padding: number; extrude: number }
  /** Frames written back to the rects of an imported third-party sheet. */
  | { type: "source" };

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

export function frameMeta(f: ExportFrame, pos: Point): FrameMeta {
  const rect = { x: pos.x, y: pos.y, w: f.w, h: f.h };
  const meta: FrameMeta = {
    name: f.name,
    rect,
    durationMs: f.durationMs,
    pivotPx: { x: f.pivot.x, y: f.pivot.y },
  };
  if (f.offset) meta.offsetPx = { x: f.offset.x, y: f.offset.y };
  if (f.extra) Object.assign(meta, f.extra);
  return meta;
}

/** True for pixel-art-mcp metadata (sidecar JSON or embedded tEXt). */
export function isAssetMetadata(value: unknown): value is AssetMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === "number" && Array.isArray(v.frames) && typeof v.size === "object" && (typeof v.image === "string" || v.image === undefined);
}
