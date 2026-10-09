import fs from "node:fs";
import path from "node:path";
import type { Project } from "../project.js";
import type { ExportResult } from "./exporters.js";
import { writeManifest } from "./manifest.js";

export interface WrittenExport {
  asset: string;
  files: string[];
  manifest?: string;
  warnings: string[];
}

/** Writes an export's files and regenerates the TypeScript manifest. */
export function writeExport(project: Project, result: ExportResult): WrittenExport {
  for (const f of result.files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.data);
  }
  let manifest: string | undefined;
  if (project.settings.emitTsManifest) manifest = project.displayPath(writeManifest(project).path);
  return {
    asset: result.name,
    files: result.files.map((f) => project.displayPath(f.path)),
    manifest,
    warnings: result.warnings,
  };
}
