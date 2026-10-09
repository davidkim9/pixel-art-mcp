import fs from "node:fs";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { cloneDocument } from "./document.js";
import type { Document, Palette, ProjectSettings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";
import { check, fail } from "./util/errors.js";

export interface Clipboard {
  width: number;
  height: number;
  /** Selected pixels (0 = transparent / not selected). */
  pixels: Uint8Array;
  paletteId: string;
  sourceDocId: string;
}

const HISTORY_LIMIT = 30;
const STATE_DIR = ".pixelmcp";
const PROJECT_FILE = "project.json";

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** All in-memory state of one project: settings, palettes, documents, selections, clipboard. */
export class Project {
  readonly root: string;
  settings: ProjectSettings;
  palettes = new Map<string, Palette>();
  docs = new Map<string, Document>();
  docCounter = 0;
  selections = new Map<string, Uint8Array>();
  clipboard?: Clipboard;
  /** Directories the MCP client shares with the server (roots/list), also readable. */
  clientRoots: string[] = [];
  private history = new Map<string, Document[]>();

  constructor(root: string, settings: Partial<ProjectSettings> = {}) {
    this.root = realpathOrSelf(path.resolve(root));
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...settings };
  }

  // -------------------------------------------------------------------------
  // Documents

  getDoc(id: string): Document {
    const doc = this.docs.get(id);
    if (!doc) {
      const ids = [...this.docs.values()].map((d) => `${d.id} ("${d.name}")`);
      fail(`No document "${id}". Documents: ${ids.length ? ids.join(", ") : "(none — use create_document or an import tool)"}.`);
    }
    return doc;
  }

  newDocId(): string {
    let id: string;
    do id = `doc_${++this.docCounter}`;
    while (this.docs.has(id));
    return id;
  }

  addDoc(doc: Document): Document {
    check(!this.docs.has(doc.id), `Document id ${doc.id} already exists`);
    this.docs.set(doc.id, doc);
    return doc;
  }

  removeDoc(id: string): void {
    this.getDoc(id);
    this.docs.delete(id);
    this.selections.delete(id);
    this.history.delete(id);
  }

  // -------------------------------------------------------------------------
  // Palettes

  getPalette(id: string): Palette {
    const p = this.palettes.get(id);
    if (!p) {
      const ids = [...this.palettes.keys()];
      fail(`No palette "${id}". Palettes: ${ids.length ? ids.join(", ") : "(none — use load_palette)"}.`);
    }
    return p;
  }

  paletteFor(doc: Document): Palette {
    return this.getPalette(doc.paletteId);
  }

  /** Explicit id, else the project default, else the only loaded palette. */
  resolvePaletteId(id?: string): string {
    if (id) return this.getPalette(id).id;
    if (this.settings.defaultPaletteId) return this.getPalette(this.settings.defaultPaletteId).id;
    if (this.palettes.size === 1) return [...this.palettes.keys()][0]!;
    if (this.palettes.size === 0) fail("No palette loaded. Call load_palette first (e.g. source \"builtin:pico8\" or a list of hex colors).");
    fail(`Several palettes are loaded (${[...this.palettes.keys()].join(", ")}); pass paletteId or set defaultPaletteId with configure_project.`);
  }

  // -------------------------------------------------------------------------
  // Selection

  getSelection(doc: Document): Uint8Array | undefined {
    const sel = this.selections.get(doc.id);
    if (sel && sel.length !== doc.width * doc.height) {
      this.selections.delete(doc.id);
      return undefined;
    }
    return sel;
  }

  // -------------------------------------------------------------------------
  // Paths

  get outputDir(): string {
    return path.resolve(this.root, this.settings.outputDir);
  }

  get stateDir(): string {
    return path.join(this.outputDir, STATE_DIR);
  }

  /** Directories files may be read from: project root, outputDir, importRoots and the client's roots. */
  readRoots(): string[] {
    return [this.root, this.outputDir, ...this.settings.importRoots.map((r) => path.resolve(this.root, r)), ...this.clientRoots].map(realpathOrSelf);
  }

  /** Resolves a path for reading; it must exist inside an allowed root. */
  resolveReadPath(p: string): string {
    const abs = path.resolve(this.root, p);
    if (!fs.existsSync(abs)) fail(`File not found: ${p}`);
    const real = fs.realpathSync(abs);
    if (!this.readRoots().some((r) => isWithin(real, r))) {
      fail(`Access denied: ${p} is outside the project directory, importRoots and the session's directories (${this.readRoots().join(", ")}).`);
    }
    return real;
  }

  /** Absolute path inside outputDir for an export-relative path. */
  outputPath(rel: string): string {
    const abs = path.resolve(this.outputDir, rel);
    check(isWithin(abs, this.outputDir), `Export path ${rel} escapes the output directory`);
    return abs;
  }

  /** Path relative to the project root with forward slashes (for reports). */
  displayPath(abs: string): string {
    const rel = path.relative(this.root, abs);
    return (rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel).split(path.sep).join("/");
  }

  // -------------------------------------------------------------------------
  // Undo history

  snapshot(docId: string): void {
    const doc = this.docs.get(docId);
    if (!doc) return;
    const stack = this.history.get(docId) ?? [];
    stack.push(cloneDocument(doc));
    if (stack.length > HISTORY_LIMIT) stack.shift();
    this.history.set(docId, stack);
  }

  /** Restores the most recent snapshot without consuming history (used when a tool fails midway). */
  rollback(docId: string): void {
    const stack = this.history.get(docId);
    const last = stack?.pop();
    if (last) this.docs.set(docId, last);
  }

  undo(docId: string): number {
    this.getDoc(docId);
    const stack = this.history.get(docId);
    const last = stack?.pop();
    if (!last) fail(`Nothing to undo for ${docId}.`);
    this.docs.set(docId, last);
    this.selections.delete(docId);
    return stack!.length;
  }

  // -------------------------------------------------------------------------
  // Persistence (outputDir/.pixelmcp/project.json)

  save(): string {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, PROJECT_FILE);
    const docs = [...this.docs.values()].map((doc) => {
      const cels: Record<string, string> = {};
      for (const key of Object.keys(doc.cels).sort()) {
        cels[key] = "deflate:" + deflateRawSync(doc.cels[key]!, { level: 9 }).toString("base64");
      }
      return { ...doc, cels };
    });
    const data = {
      format: "pixel-art-mcp-project",
      version: 1,
      settings: this.settings,
      docCounter: this.docCounter,
      palettes: [...this.palettes.values()],
      documents: docs,
    };
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
    fs.renameSync(tmp, file);
    return file;
  }

  /** Loads project state, replacing what is in memory. `dir` may be an outputDir or its .pixelmcp folder. */
  load(dir?: string): string {
    const base = dir ? path.resolve(this.root, dir) : this.outputDir;
    const candidates = [path.join(base, STATE_DIR, PROJECT_FILE), path.join(base, PROJECT_FILE)];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) fail(`No saved project found in ${this.displayPath(base)} (looked for ${STATE_DIR}/${PROJECT_FILE}).`);
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
      format?: string;
      settings: ProjectSettings;
      docCounter: number;
      palettes: Palette[];
      documents: Array<Omit<Document, "cels"> & { cels: Record<string, string> }>;
    };
    check(data.format === "pixel-art-mcp-project", `${file} is not a pixel-art-mcp project file`);
    // Keep only known settings (older project files may carry removed ones).
    const known = Object.fromEntries(Object.entries(data.settings ?? {}).filter(([k]) => k in DEFAULT_SETTINGS || k === "defaultPaletteId"));
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...known };
    this.docCounter = data.docCounter ?? 0;
    this.palettes = new Map(data.palettes.map((p) => [p.id, p]));
    this.docs = new Map();
    for (const d of data.documents) {
      const cels: Record<string, Uint8Array> = {};
      for (const [key, value] of Object.entries(d.cels)) {
        const raw = value.startsWith("deflate:")
          ? inflateRawSync(Buffer.from(value.slice(8), "base64"))
          : Buffer.from(value, "base64");
        cels[key] = new Uint8Array(raw);
      }
      this.docs.set(d.id, { ...d, cels } as Document);
    }
    this.selections.clear();
    this.history.clear();
    this.clipboard = undefined;
    return file;
  }
}
