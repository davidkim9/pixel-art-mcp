import type { Document } from "./types.js";

export interface KindOptions {
  parts?: string[];
  directions?: string[];
}

/** Kind-specific setup for a freshly created document. Returns notes for the caller. */
export function setupDocumentKind(doc: Document, _opts: KindOptions = {}): string[] {
  const notes: string[] = [];
  if (doc.kind === "tileset") {
    doc.tileset = { tileSize: Math.min(doc.width, doc.height), wrapDrawing: false };
    if (doc.width !== doc.height) notes.push("Tiles are square: tileSize is the smaller side. Each frame holds one tile.");
    else notes.push("Each frame holds one tile. Use set_wrap_mode to draw across tile edges.");
  } else if (doc.kind === "icon") {
    doc.icon = { size: Math.min(doc.width, doc.height), margin: 1 };
    notes.push("Each frame holds one icon. create_icon_set also adds a safe-area guide layer.");
  }
  return notes;
}
