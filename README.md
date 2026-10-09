# pixel-art-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI model make pixel art the way a person uses Aseprite: an indexed-color canvas with layers, frames, selections and live previews. The output is indexed PNG files, plus JSON metadata describing frames, tags and pivots.

It handles:

- **Sprites and effects**: frames, tags, onion skin, radial gradients, dithering, glow layers, and spritesheets.
- **Layered characters**: one layer per body part, plus pivots, attach points, per-direction draw order, poses and `mirror_rig`.
- **Seamless tilesets**: wrap-around drawing, seam checks, and corner15 / blob47 transition sets with autotile generation.
- **Icons**: a shared size, outline and shadow, exported as an atlas.
- **Palettes**: one enforced palette with named shading ramps.

Every pixel is a palette index (`0` = transparent), so off-palette colors can't happen. The model sees its work through upscaled preview images with a pixel grid and coordinate rulers.

## Setup

Requires Node.js 20+.

```sh
git clone git@github.com:davidkim9/pixel-art-mcp.git
cd pixel-art-mcp
npm install    # also builds dist/
npm link       # puts a `pixel-art-mcp` command on your PATH
claude mcp add --scope user pixel-art -- pixel-art-mcp
```

Then run `claude` in your project's folder. The server works in the project folder Claude Code gives it, falling back to the directory it was started in, so exports go to `./assets` there. You can change that with `configure_project({ outputDir })`.

If you'd rather not use `npm link`, register the server with `claude mcp add --scope user pixel-art -- node /path/to/pixel-art-mcp/dist/index.js`. With other MCP clients, `--root <dir>` sets the project folder explicitly.

## Concepts

| | |
|---|---|
| **Indexed color** | Pixels are palette indices. Index 0 is the only transparency, and there is no partial alpha. Layers marked `blend: "additive"` export to a separate `_glow.png`. |
| **Palettes** | `load_palette` accepts a hex list, Lospec `.hex` or GIMP `.gpl` text, a `.png`/`.aseprite`/`.gpl`/`.hex` file, or `builtin:pico8`. Index 0 is inserted as transparent, so the first color becomes index 1. Ramps go dark → light. |
| **Documents** | `kind` is one of `sprite`, `character`, `tileset`, `effect` or `icon`. Layers are listed bottom → top, and frames carry a duration, tag, pivot and label. |
| **Coordinates** | Integer pixels with the origin at the top-left, y pointing down. Pivots are continuous: `(w/2, h)` is the bottom-center. |
| **Drawing** | `draw_grid` is the main tool. Each row is a string, the legend maps characters to indices, `.` leaves a pixel unchanged and `_` makes it transparent. `read_grid` reads pixels back in the same format, and its output can be fed straight back into `draw_grid`. |
| **Feedback** | Every pixel-changing tool accepts `preview: true`. The `render_*` tools return PNG images, and `export_gif` writes an animated GIF for people to review. |
| **Undo** | `undo` reverts the last change to a document, up to 30 steps. A tool that fails partway leaves its document unchanged. |
| **Persistence** | `save_project` / `load_project` use `outputDir/.pixelmcp/project.json`. |
| **File access** | Reads are limited to the project folder, `outputDir`, the configured `importRoots`, and folders the client shares with the session (MCP roots, e.g. added with `/add-dir`). |

## Tools (85)

| Area | Tools |
|---|---|
| Project | `configure_project` `create_document` `list_documents` `get_document_info` `duplicate_document` `delete_document` `resize_canvas` `undo` `save_project` `load_project` |
| Palette | `load_palette` `list_palettes` `get_palette` `render_palette`🖼 `define_ramp` `remap_palette` |
| Layers & frames | `add_layer` `remove_layer` `rename_layer` `reorder_layer` `set_layer_visibility` `duplicate_layer` `set_layer_properties` `add_frame` `remove_frame` `duplicate_frame` `move_frame` `set_frame_duration` `tag_frames` `set_pivot` |
| Drawing | `draw_grid` `read_grid` `set_pixels` `draw_line` `draw_rect` `draw_ellipse` `flood_fill` `replace_color` `clear` `set_symmetry` |
| Selection & transform | `select_rect` `select_by_color` `select_layer_content` `deselect` `move_selection` `copy_selection` `paste` `flip_selection` `rotate_selection_90` `offset_layer` |
| Shading & effects | `auto_outline` `drop_shadow` `shade_with_ramp` `radial_gradient` `dither_region` `find_orphan_pixels` |
| Previews 🖼 | `render_preview` `render_frames` `render_onion` `render_tiled` `render_assembled` `render_in_context` `export_gif` |
| Characters | `define_rig_part` `set_draw_order` `define_pose` `mirror_rig` `render_assembled`🖼 `export_character` |
| Tilesets | `set_wrap_mode` `check_seams`🖼 `create_transition_set` `generate_autotile` `check_transition_set`🖼 `render_terrain_preview`🖼 `export_tileset` |
| Icons | `create_icon_set` `apply_icon_style` `export_icon_atlas` |
| Export & validation | `export_png` `export_spritesheet` `validate_document` |
| Import | `inspect_file` `import_png` `import_aseprite` `export_to_source` |

Each tool's description in the MCP schema explains its parameters. The server also sends workflow guidance as MCP instructions.

## Workflows

**Effect (fireball)**: `load_palette` → `define_ramp` (fire: dark → light) → `create_document(kind: "effect")` → block out silhouettes per frame (`draw_ellipse`, `draw_grid`) → `render_frames` → color them with `radial_gradient(onlyOpaque: true, dither: "bayer4")` → refine with `draw_grid` → `render_onion` → `tag_frames` → `export_spritesheet`.

**Character**: `create_document(kind: "character", width: 32, height: 32)` creates layers `foot_l foot_r body hand_l hand_r head` and one frame per direction (`down up left right`). Draw each part in place on frames 0 (down), 1 (up) and 3 (right). Then `define_rig_part` sets pivots, parents and attach points, `mirror_rig(right → left)` builds the left view, and `define_pose` (`idle_0`, `walk_0`…) adds poses. Review with `render_assembled(pose: "walk_*")` and finish with `export_character`. Pose offsets follow the parent chain and mirror automatically for mirrored directions, and the server warns when a part stops overlapping its parent.

**Transition tileset (grass over dirt)**: `create_transition_set(tileSize: 16, terrains: {lower: "dirt", upper: "grass"}, overlay: true)` gives 16 frames where **frame index = corner mask** (`TL*1 + TR*2 + BR*4 + BL*8`), plus a faint guide layer. Draw tile 15 (full), an edge (3), an outer corner (1) and an inner corner (7), then run `generate_autotile`. Hand-draw diagonals 5 and 10 if the generated ones look off, then run `check_transition_set` and `render_terrain_preview` (the built-in map covers every corner combination) and `export_tileset`.

**Icons**: `create_icon_set(size: 16, count: 8, names: [...])` → draw inside the safe area → `apply_icon_style(outline: 1, shadow: 2)`. Re-run it after edits; it regenerates its own layers. Finish with `export_icon_atlas`.

**Editing an existing asset**: `inspect_file` → `import_png` / `import_aseprite` (colorMode `exact`) → `read_grid` + `render_preview` → change only the pixels the edit needs → `export_to_source`.

## Output

Exports are 8-bit **indexed PNGs**. The palette is embedded and index 0 is transparent through a one-entry `tRNS`. Guide layers and hidden layers are never exported. Sheets and atlases separate frames with `atlasPadding` (default 2) and duplicate each frame's edge pixels `atlasExtrude` pixels (default 1) into that padding. Output is deterministic, so the same inputs give byte-identical files.

| Export | Files |
|---|---|
| `export_png` | `name.png` (one frame) |
| `export_spritesheet` | `name.png` sheet, plus `name_glow.png` when there are additive layers |
| `export_character` | `name.png` atlas of every part × direction, or `name_<part>_<direction>.png` per part (`characterExport: "parts"`) |
| `export_tileset` / `export_icon_atlas` | `name.png` atlas |
| Metadata | `name.json` next to the PNG and/or a PNG `tEXt` chunk keyed `pixelmcp` (`metadataMode`) |

```jsonc
{
  "version": 1,
  "name": "fireball",
  "kind": "effect",
  "image": "fireball.png",
  "glow": "fireball_glow.png",
  "size": { "w": 162, "h": 34 },        // image size
  "sourceSize": { "w": 30, "h": 30 },   // canvas size of the document
  "pixelsPerUnit": 16,
  "paletteId": "pico8",
  "layout": { "type": "spritesheet", "layout": "row", "padding": 2, "extrude": 1 },
  "frames": [
    { "name": "fireball_0", "rect": { "x": 2, "y": 2, "w": 30, "h": 30 }, "durationMs": 80, "pivotPx": { "x": 15, "y": 15 } }
  ],
  "tags": [{ "name": "loop", "from": 0, "to": 4, "direction": "forward" }]
}
```

`rect` is in image pixels (origin top-left), and `pivotPx` is relative to the rect. Trimmed frames (packed layout) and character parts add `offsetPx`, the rect's position on the original canvas. Tilesets add each tile's `mask` and a `tileset` block (for blob47, a 256-entry `maskToFrame` table). Characters add `part`/`direction` per frame and a `character` block with parts, parents, attach points, draw orders and poses. Icon atlases add `icons: { name: frameIndex }`.

## Import

- **`import_png`**: when pixel-art-mcp metadata is present, re-import is **lossless**. Frames, durations, tags, pivots, trims, tile masks, icon names and character rigs all come back, and extruded pixels are discarded. Exporting again produces byte-identical files.
  - Other slicing modes: `"none"`, a grid `{frameWidth, frameHeight, margin?, spacing?, count?}` (source-image pixels), `{asepriteJson}` for Aseprite sheet JSON in hash or array format, and `"auto"`. Auto detects a grid from transparent gutters, and when more than one grid fits it refuses and returns the candidates.
  - Integer upscaling is detected (`scale: "auto"`) and reported.
- **Color modes**:
  - `exact` (default) fails if any color is off-palette. The report lists every such color with its pixel count and sample coordinates, and nothing is imported.
  - `nearest` snaps colors in OKLab and reports each substitution.
  - `extract` builds and registers a new palette.
  - Alpha below `alphaThreshold` (default 128) becomes transparent, and the report counts pixels whose alpha changed. Indexed PNGs whose palette matches the project palette keep their indices exactly.
- **`import_aseprite`**: reads `.aseprite`/`.ase` files, keeping layers (groups as `group/child` names, or `layerGroups: "merge"`), visibility, frames, durations, tags with direction, and slices. A slice pivot becomes the frame pivot, and slices named like rig parts are reported as candidates.
  - Linked cels become copies, and tilemap layers are rendered to pixels.
  - Indexed files keep their palette mapping, with the transparent index remapped to 0.
  - Other blend modes and opacity are flattened with a warning; addition and lighten become `additive`.
- **`export_to_source`**: overwrites PNG sources in place with their original layout, including third-party sheet rects and upscale factor, and regenerates metadata. It refuses if the file changed since import unless `force: true`. For `.aseprite` sources it writes `name.png` + metadata next to the file.

## Differences from the original spec

- **Metadata only describes the images:** frame rects, pivots, durations, tags and asset-specific data. No engine- or language-specific files are generated.
- **PNG encoding is in-house** (`src/png.ts`). pngjs can't write indexed PNGs or `tEXt` chunks. The decoder handles every color type, bit depth and Adam7 interlacing, and tests cross-check it against pngjs.
- **The Aseprite decoder is in-house** (`src/import/aseprite.ts`), following the official format spec. The `ase-parser` package and its sample file serve as a test oracle.
- **Transition sets have 16 frames** (frame index = mask, frame 0 empty in overlay mode) rather than 15.
- **Character frames are directions** (frame *i* = `rig.directions[i]`).
- **`.aseprite` imports default to `scale: 1`.**
- **Additions:** `undo`, `delete_document`, `set_layer_properties`, `set_pivot`, `deselect`, `export_png` and `export_character`; selection modes (add, subtract, intersect).

## Development

```sh
npm test            # vitest: unit, integration (in-memory MCP client), stdio smoke test, end-to-end scenario
npm run typecheck
npm run build       # → dist/
npm run dev         # run from source with tsx
```

```
src/
  index.ts, server.ts          stdio entry point and tool registration
  tools/                       MCP tool definitions (zod schemas)
  document.ts raster.ts selection.ts shading.ts palette.ts color.ts
  png.ts gif.ts                codecs
  render/                      previews (compositing, contact sheets, bitmap font)
  export/                      atlas layouts, metadata, file writer
  tileset/ character*.ts icons.ts validate.ts
  import/                      PNG/Aseprite import, slicing, color mapping, export_to_source
test/                          vitest suites
```
