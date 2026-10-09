import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Project } from "./project.js";
import type { ProjectSettings } from "./types.js";
import { makeRegister } from "./tools/helpers.js";
import { registerDrawingTools } from "./tools/drawing.js";
import { registerExportTools } from "./tools/export.js";
import { registerLayerFrameTools } from "./tools/layers.js";
import { registerPaletteTools } from "./tools/palette.js";
import { registerPreviewTools } from "./tools/preview.js";
import { registerProjectTools } from "./tools/project.js";
import { registerSelectionTools } from "./tools/selection.js";
import { registerShadingTools } from "./tools/shading.js";

export const SERVER_NAME = "pixel-art-mcp";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = `Pixel art editor for indexed-color game assets (sprites, layered characters, seamless tilesets, effects, icons) exported as PNG + metadata for a Three.js billboard game.

Every pixel is a palette index (0 = transparent). Your only view of the canvas is the preview images the tools return, so look often.

Workflow:
- Load or define the palette and ramps first (load_palette, define_ramp); never use colors outside them.
- Block out silhouettes before detail. Check render_preview after every significant change (or pass preview: true to drawing tools).
- Prefer draw_grid for anything detailed; use read_grid before editing existing work.
- Animation: review with render_frames and render_onion every time frames change.
- Tiles: check render_tiled and check_seams before exporting; transition sets also need check_transition_set and render_terrain_preview.
- Use render_in_context to confirm new assets match the scale and style of existing ones.
- Editing an existing asset: inspect_file first, import with colorMode "exact", then read_grid and render_preview before changing anything. Change only the pixels the edit requires and use export_to_source so the asset keeps its path.
- undo reverts the last change to a document. save_project persists everything.`;

export interface ServerHandle {
  server: McpServer;
  project: Project;
  tools: string[];
}

export function createServer(root: string, settings: Partial<ProjectSettings> = {}): ServerHandle {
  const project = new Project(root, settings);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const tools: string[] = [];
  const register = makeRegister(server, project, tools);
  registerProjectTools(register, project);
  registerPaletteTools(register, project);
  registerLayerFrameTools(register, project);
  registerDrawingTools(register, project);
  registerSelectionTools(register, project);
  registerShadingTools(register, project);
  registerPreviewTools(register, project);
  registerExportTools(register, project);
  return { server, project, tools };
}
