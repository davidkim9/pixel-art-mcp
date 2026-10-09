import fs from "node:fs";
import path from "node:path";
import type { Project } from "../project.js";
import type { ExportResult } from "./exporters.js";

export interface WrittenExport {
  asset: string;
  files: string[];
  warnings: string[];
}

/** Writes an export's files (PNGs and metadata). */
export function writeExport(project: Project, result: ExportResult): WrittenExport {
  for (const f of result.files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.data);
  }
  return {
    asset: result.name,
    files: result.files.map((f) => project.displayPath(f.path)),
    warnings: result.warnings,
  };
}
