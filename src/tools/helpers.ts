import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { checkFrame, ensureCel, findLayer, resolveLayerId } from "../document.js";
import { paletteRgb } from "../palette.js";
import type { Project } from "../project.js";
import { composeFrame } from "../render/compose.js";
import { autoScale, renderCanvasView, renderSheet } from "../render/previews.js";
import type { Document, Rect } from "../types.js";
import { ToolError, fail } from "../util/errors.js";

export interface ToolOutput {
  data: unknown;
  images?: Buffer[];
}

export interface ToolDef<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  /** Deletes or overwrites data outside the undo history (MCP destructiveHint). */
  destructive?: boolean;
  /** Returns the id of the document this call modifies (snapshotted for undo, restored on failure). */
  mutates?: (args: z.infer<z.ZodObject<S>>) => string | undefined;
  handler: (args: z.infer<z.ZodObject<S>>) => ToolOutput | Promise<ToolOutput>;
}

export type Register = <S extends z.ZodRawShape>(def: ToolDef<S>) => void;

export function toResult(out: ToolOutput): CallToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(out.data ?? { ok: true }) },
      ...(out.images ?? []).map((png) => ({ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" })),
    ],
  };
}

export function errorResult(e: unknown): CallToolResult {
  const message = e instanceof Error ? e.message : String(e);
  const details = e instanceof ToolError ? e.details : undefined;
  if (!(e instanceof ToolError)) console.error("[pixel-art-mcp] unexpected error:", e);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(details === undefined ? { error: message } : { error: message, details }) }],
  };
}

export function makeRegister(server: McpServer, project: Project, names?: string[]): Register {
  return <S extends z.ZodRawShape>(def: ToolDef<S>) => {
    names?.push(def.name);
    const callback = async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
      const docId = def.mutates?.(args);
      const snap = docId !== undefined && project.docs.has(docId);
      if (snap) project.snapshot(docId!);
      try {
        return toResult(await def.handler(args));
      } catch (e) {
        if (snap) project.rollback(docId!);
        return errorResult(e);
      }
    };
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: def.readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: def.destructive === true },
      },
      callback as never,
    );
  };
}

// ---------------------------------------------------------------------------
// Common schemas

export const zDocId = z.string().describe("Document id, e.g. \"doc_1\"");
export const zLayerId = z.string().optional().describe("Layer id (optional when the document has a single drawable layer)");
export const zFrame = z.number().int().min(0).optional().describe("Frame index (default 0)");
export const zPreview = z.boolean().optional().describe("Also return a preview image of the frame after the change");
export const zColor = z.number().int().min(0).max(255).describe("Palette index (0 = transparent)");
export const zRect = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export const zRegion = z
  .union([zRect, z.literal("selection")])
  .optional()
  .describe("Rectangle {x,y,w,h}, \"selection\", or omitted for the whole canvas");
export const zPoint = z.object({ x: z.number(), y: z.number() });

// ---------------------------------------------------------------------------
// Drawing context

export interface DrawTarget {
  doc: Document;
  layerId: string;
  frame: number;
  cel: Uint8Array;
}

/** Resolves doc/layer/frame for a pixel-writing tool and checks the layer is unlocked. */
export function drawTarget(project: Project, args: { docId: string; layerId?: string; frame?: number }): DrawTarget {
  const doc = project.getDoc(args.docId);
  const layerId = resolveLayerId(doc, args.layerId);
  const layer = findLayer(doc, layerId);
  if (layer.locked) fail(`Layer "${layer.id}" is locked${layer.guide ? " (it is a guide layer)" : ""}. Unlock it with set_layer_properties.`);
  const frame = args.frame ?? 0;
  checkFrame(doc, frame);
  return { doc, layerId, frame, cel: ensureCel(doc, layerId, frame) };
}

/** Validates a palette index against the document's palette. */
export function checkColor(project: Project, doc: Document, c: number, what = "color"): void {
  const p = project.paletteFor(doc);
  if (!Number.isInteger(c) || c < 0 || c >= p.colors.length) {
    fail(`${what} ${c} is outside palette "${p.id}" (valid 0–${p.colors.length - 1}; 0 = transparent).`);
  }
}

/** Mask for a region spec (null = whole canvas). */
export function regionMask(project: Project, doc: Document, region: Rect | "selection" | undefined): Uint8Array | null {
  if (region === undefined) return null;
  if (region === "selection") {
    const sel = project.getSelection(doc);
    if (!sel) fail("No active selection in this document (use select_rect, select_by_color or select_layer_content).");
    return sel;
  }
  const mask = new Uint8Array(doc.width * doc.height);
  for (let y = Math.max(0, region.y); y < Math.min(doc.height, region.y + region.h); y++) {
    for (let x = Math.max(0, region.x); x < Math.min(doc.width, region.x + region.w); x++) mask[y * doc.width + x] = 1;
  }
  return mask;
}

/** Standard preview of one frame: auto scale, pixel grid and coordinate rulers. */
export function framePreview(project: Project, doc: Document, frame: number, opts: { scale?: number; grid?: boolean; layers?: string[] } = {}): Buffer {
  const palette = paletteRgb(project.paletteFor(doc));
  const buf = composeFrame(doc, palette, frame, { layers: opts.layers });
  const scale = opts.scale ?? autoScale(doc.width, doc.height);
  const grid = opts.grid ?? true;
  return renderCanvasView(buf, { scale, grid, rulers: grid, majorEvery: Math.max(doc.width, doc.height) > 16 ? 8 : 0 }).toPng();
}

/** One frame (single-frame documents) or a contact sheet of every frame. */
export function docPreview(project: Project, doc: Document): Buffer {
  if (doc.frames.length === 1) return framePreview(project, doc, 0);
  const palette = paletteRgb(project.paletteFor(doc));
  const cells = doc.frames.map((f, i) => ({ buf: composeFrame(doc, palette, i), title: `#${i}`, subtitle: f.label ?? f.tag }));
  return renderSheet(cells, autoScale(doc.width, doc.height, 128)).toPng();
}

export function withPreview(project: Project, doc: Document, frame: number, preview: boolean | undefined, data: unknown): ToolOutput {
  return preview ? { data, images: [framePreview(project, doc, frame)] } : { data };
}
