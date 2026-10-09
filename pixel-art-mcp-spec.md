# Pixel Art MCP Server — Scope & Specification

## 1. Purpose

Build an MCP (Model Context Protocol) server that lets an AI model create pixel art the way a human uses Aseprite: on an indexed-color canvas with layers, frames, selections, and live previews. The output is PNG assets (plus metadata) for a **TypeScript + Three.js game that renders sprites as billboards**.

The server must support five asset categories:

1. **Layered character sprites** — separate parts (head, body, left hand, right hand, left foot, right foot) with pivot/attach metadata, assembled and animated in-engine.
2. **Seamless tilesets** — including wrap-around editing, seam checking, and autotile generation.
3. **Animated effects** — fireballs, explosions, etc., exported as spritesheets.
4. **Icons** — consistent size, outline, and shadow; exported as an atlas.
5. **Palettes** — a shared, enforced palette that every asset uses.

## 2. Tech Stack

- **Language:** TypeScript (Node.js 20+), so types can be shared with the game.
- **MCP SDK:** `@modelcontextprotocol/sdk`, stdio transport.
- **PNG encoding:** `pngjs` (supports indexed/palette PNGs and `tEXt` chunks). `sharp` is optional for upscaled previews.
- **State:** documents held in memory, with save/load to a project directory as JSON (native format) so work survives restarts.
- **No GUI.** The model's only view of the canvas is through preview images returned by tools.

## 3. Core Principles

1. **Indexed color only.** Every pixel is a palette index (`0–255`), never a raw RGB value. Tools take `color: number` (an index). This makes off-palette colors impossible.
2. **Index 0 is transparent.** It is the only transparent value. No partial alpha anywhere (the game uses `alphaTest`, see §11). Additive glow effects are the only exception and are handled as a separate layer flagged `blend: "additive"`, exported to a separate PNG.
3. **Visual feedback is mandatory.** Any tool that changes pixels can optionally return a preview image (`preview: true`). Preview tools return PNG images the model can see. This feedback loop is the single most important feature.
4. **Text-friendly drawing.** The model draws most reliably with a character grid (see `draw_grid` in §6.4). Every pixel-writing tool must also have a text-readable counterpart for reading pixels back.
5. **Deterministic.** Same inputs produce byte-identical outputs.
6. **Coordinates:** integer pixels, origin top-left, x right, y down. Conversions to Three.js conventions happen only at export (see §11).

## 4. Data Model

```ts
type PaletteIndex = number; // 0 = transparent

interface Palette {
  id: string;
  name: string;
  colors: string[];              // "#rrggbb", index-aligned; colors[0] ignored (transparent)
  ramps: Record<string, PaletteIndex[]>; // e.g. { skin: [12,13,14,15] } dark → light
}

interface Document {
  id: string;
  name: string;
  kind: "sprite" | "character" | "tileset" | "effect" | "icon";
  width: number;
  height: number;
  paletteId: string;
  layers: Layer[];               // bottom → top
  frames: Frame[];
  cels: Record<string, Uint8Array>; // key `${layerId}:${frameIndex}`, length width*height
  rig?: Rig;                     // character documents only
  tileset?: TilesetConfig;       // tileset documents only
  source?: { path: string; format: "png" | "aseprite"; importedAt: string; sha256: string }; // set by imports
}

interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  blend: "normal" | "additive";
}

interface Frame {
  durationMs: number;
  tag?: string;                  // e.g. "walk", "idle", "explode"
}
```

## 5. Project Settings

Set once per project with `configure_project`:

| Setting | Default | Notes |
|---|---|---|
| `pixelsPerUnit` | 16 | World-space scale; all sprites share it. |
| `outputDir` | `./assets` | Where exports are written. |
| `defaultPaletteId` | — | Used when a document doesn't specify one. |
| `atlasPadding` | 2 | Pixels between frames in sheets/atlases. |
| `atlasExtrude` | 1 | Edge pixels duplicated into padding (prevents bleeding). |
| `metadataMode` | `"sidecar"` | `"sidecar"` (JSON next to PNG), `"embedded"` (PNG `tEXt` chunk), or `"both"`. |
| `emitTsManifest` | true | Generates a typed `.ts` manifest of all exported assets. |
| `importRoots` | `[outputDir]` | Directories the server may read existing assets from. |

## 6. Tools

All tools return a short JSON result. Tools marked 🖼 return an image.

### 6.1 Project & Documents

| Tool | Description |
|---|---|
| `configure_project(settings)` | Set project settings from §5. |
| `create_document(name, kind, width, height, paletteId?)` | Creates a document with one layer and one frame. Warn if dimensions aren't a multiple of 8. |
| `list_documents()` | Ids, names, kinds, sizes. |
| `get_document_info(docId)` | Layers, frames, tags, rig/tileset config. |
| `duplicate_document(docId, newName)` | Deep copy. |
| `resize_canvas(docId, width, height, anchor)` | Anchor: `"top-left"`, `"center"`, `"bottom-center"`, etc. |
| `save_project()` / `load_project()` | Persist to/from `outputDir/.pixelmcp/`. |

### 6.2 Palette

| Tool | Description |
|---|---|
| `load_palette(name, source)` | `source` is a list of hex colors, or the text content of a Lospec `.hex` or GIMP `.gpl` file. Index 0 is inserted as transparent. |
| `list_palettes()` / `get_palette(id)` | Returns colors and ramps. |
| `render_palette(id)` 🖼 | Swatch image labelled with indices and ramp names. |
| `define_ramp(paletteId, name, indices)` | Named shading ramp, ordered dark → light. Used by shading helpers. |
| `remap_palette(docId, mapping, newDocName?)` | Index-to-index remap (e.g. `{12: 30, 13: 31}`) to make color variants: enemy recolors, team colors, an ice version of a fireball. Writes to a new document if `newDocName` is set. |

### 6.3 Layers & Frames

| Tool | Description |
|---|---|
| `add_layer(docId, name, blend?)`, `remove_layer`, `rename_layer`, `reorder_layer(docId, layerId, newIndex)`, `set_layer_visibility`, `duplicate_layer` | Standard layer ops. |
| `add_frame(docId, durationMs?, copyFrom?)`, `remove_frame`, `duplicate_frame`, `move_frame` | Standard frame ops. |
| `set_frame_duration(docId, frame, ms)` | Per-frame timing. |
| `tag_frames(docId, tag, from, to)` | Names an animation range ("idle", "walk", "explode"). |

### 6.4 Drawing

All drawing tools take `docId`, `layerId`, `frame`, and optional `preview: boolean`.

| Tool | Description |
|---|---|
| `draw_grid(x, y, rows, legend)` | **Primary drawing tool.** `rows` is an array of equal-length strings; `legend` maps characters to palette indices. `.` always means "leave unchanged", `_` means transparent (index 0). Example below. |
| `read_grid(x?, y?, w?, h?)` | Returns the region as text rows using single-character codes, plus the legend used. Lets the model inspect and edit precisely. |
| `set_pixels(pixels: {x, y, c}[])` | For scattered edits. |
| `draw_line(x0, y0, x1, y1, c)` | Pixel-perfect Bresenham line (no doubled corners). |
| `draw_rect(x, y, w, h, c, filled)` | |
| `draw_ellipse(cx, cy, rx, ry, c, filled)` | Pixel-perfect ellipse. |
| `flood_fill(x, y, c, contiguous = true)` | |
| `replace_color(from, to, region?)` | |
| `clear(region?)` | Sets to index 0. |
| `set_symmetry(docId, mode, axis?)` | `"none" \| "horizontal" \| "vertical" \| "both"`. Applies to all subsequent drawing tools until changed. |

`draw_grid` example:

```json
{
  "x": 4, "y": 2,
  "legend": { "o": 1, "s": 13, "h": 15 },
  "rows": [
    "_ooo_",
    "osssh",
    "osssh",
    "_ooo_"
  ]
}
```

### 6.5 Selection & Transform

| Tool | Description |
|---|---|
| `select_rect(x, y, w, h)` | |
| `select_by_color(index, contiguous)` | Magic wand. |
| `select_layer_content(layerId)` | Selects all non-transparent pixels. |
| `move_selection(dx, dy)` / `copy_selection()` / `paste(docId, layerId, frame, x, y)` | Clipboard works across documents. |
| `flip_selection(axis)` / `rotate_selection_90(times)` | Lossless only. Arbitrary-angle rotation is out of scope (see §13). |
| `offset_layer(dx, dy, wrap = false)` | With `wrap: true`, pixels leaving one edge enter the opposite edge (essential for tiles). |

### 6.6 Shading & Effects Helpers

| Tool | Description |
|---|---|
| `auto_outline(layerId, c, mode)` | `mode`: `"outside" \| "inside"`, `connectivity`: 4 or 8. Optional `selective: true` uses the darker ramp neighbor instead of a flat color. |
| `drop_shadow(layerId, dx, dy, c)` | Writes the shadow to a new layer below. |
| `shade_with_ramp(region, rampName, lightDir)` | Basic directional shading of a filled shape using a named ramp. A starting point the model then refines. |
| `radial_gradient(cx, cy, radius, rampName, dither)` | Gradient quantized to ramp steps; `dither: "none" \| "bayer2" \| "bayer4" \| "checker"`. Core tool for glows and explosions. |
| `dither_region(region, c1, c2, pattern, ratio)` | Ordered dithering between two indices. |
| `find_orphan_pixels(layerId)` | Reports isolated single pixels (usually noise). |

### 6.7 Previews 🖼

All previews return an upscaled PNG (nearest-neighbor) with an optional pixel grid and checkerboard background for transparency.

| Tool | Description |
|---|---|
| `render_preview(docId, frame?, scale = 8, grid = true, layers?)` | Current state of one frame. |
| `render_frames(docId, tag?, scale)` | All frames side by side in a labelled contact sheet with durations. (The model can't watch an animation, so this is how it reviews motion.) |
| `render_onion(docId, frame, before = 1, after = 1)` | Current frame with adjacent frames tinted underneath. |
| `render_tiled(docId, frame?, repeat = 3)` | Tile repeated N×N, for spotting seams. |
| `render_assembled(docId, pose?, direction?)` | Character rig assembled from parts (see §7). |
| `render_in_context(docIds[], layout)` | Several assets side by side at the same scale, to check that sizes and styles match. |
| `export_gif(docId, tag?, scale)` | Writes an animated GIF to disk for the **human** to review. Returns the path, not an image. |

### 6.8 Opening Existing Assets (PNG and Aseprite)

Imported assets become normal documents: every other tool works on them. Imports never modify the source file.

| Tool | Description |
|---|---|
| `inspect_file(path)` | Reports what a file contains without importing it: dimensions, color mode, embedded palette, layers, frames, tags, slices, and whether MCP metadata (sidecar JSON or `tEXt` chunk) is present. Lets the model plan an import. |
| `import_png(path, options)` | Opens a PNG as a document. Options below. Returns an import report. |
| `import_aseprite(path, options)` | Opens an `.aseprite` / `.ase` file as a document, preserving layers, frames, durations, tags, and slices. Options below. Returns an import report. |
| `export_to_source(docId)` | Re-exports an imported document to its original location (PNG sources only), regenerating its metadata. Refuses if the source file changed since import (hash mismatch) unless `force: true`. For `.aseprite` sources, exports PNG + metadata next to the source file instead (writing `.aseprite` is out of scope). |

`load_palette` also accepts a file path to a `.png`, `.aseprite`, `.gpl`, or `.hex` file, so an existing asset's palette can become the project palette.

**Shared import options:**

```ts
interface ImportOptions {
  name?: string;                     // defaults to file name
  kind?: Document["kind"];           // defaults to "sprite", or inferred from MCP metadata
  paletteId?: string;                // palette to map into; defaults to project palette
  colorMode?: "exact" | "nearest" | "extract"; // default "exact"
  alphaThreshold?: number;           // 0–255, default 128; below → transparent, at/above → opaque
  scale?: "auto" | number;           // default "auto" (detect integer upscaling)
}
```

**Color mapping:**
- `"exact"` (default): every opaque color must exist in the palette. If any don't, the import fails and the report lists each off-palette color with pixel count and sample coordinates. Nothing is ever silently changed.
- `"nearest"`: snaps off-palette colors to the closest palette color (perceptual distance, e.g. OKLab) and reports every substitution.
- `"extract"`: builds a new palette from the image's colors (fails above 255 colors) and registers it.
- Partial alpha is thresholded by `alphaThreshold`; the report lists how many pixels changed.
- Aseprite files in indexed mode keep their palette mapping. If the file's transparent index isn't 0, indices are remapped so transparent becomes 0, and the report says so.

**Scale detection:** with `scale: "auto"`, the importer finds the largest integer factor N where every N×N block is a single color, and downsamples by N. The report states the detected factor so the model can override it if wrong.

**PNG-specific options:**

```ts
interface PngImportOptions extends ImportOptions {
  slicing?:
    | "none"                         // one frame
    | "metadata"                     // use MCP sidecar JSON or tEXt chunk (default when present)
    | { asepriteJson: string }       // path to an Aseprite-exported sheet JSON (hash or array format)
    | { frameWidth: number; frameHeight: number; margin?: number; spacing?: number; count?: number }
    | "auto";                        // detect a uniform grid from transparent gutters; report the guess
}
```

When MCP metadata is present, import is lossless: frames, durations, tags, pivots, rig data, corner masks, and atlas padding/extrusion are all reconstructed (extruded edge pixels are discarded, not imported as art). `"auto"` slicing never proceeds silently on an ambiguous guess; it returns the proposed grid in the report and requires the model to re-run with explicit dimensions if unsure.

**Aseprite-specific behavior:**

```ts
interface AsepriteImportOptions extends ImportOptions {
  layerGroups?: "flatten-names" | "merge"; // default "flatten-names": "arm/upper" becomes layer "arm/upper"
  includeHidden?: boolean;                 // default true (kept hidden)
}
```

- Layers, layer visibility, frames, frame durations, and tags (including direction: forward, reverse, ping-pong) are preserved.
- Cel positions are applied; linked cels become copies.
- Slices are imported; a slice's pivot becomes a frame pivot, and slices named after rig parts (e.g. `head`, `hand_l`) are offered as rig parts in the report.
- Layer blend modes other than normal, and layer/cel opacity below 100%, can't be represented exactly. They're flattened to normal at full opacity with a warning per layer, except an `addition`/`lighten` layer, which maps to `blend: "additive"`.
- Tilemap layers (Aseprite 1.3+) are imported as rendered pixels, with a warning.
- RGBA and grayscale files go through the same color mapping as PNGs.

**Import report** (returned by both import tools):

```json
{
  "docId": "doc_12",
  "source": { "path": "assets/goblin.aseprite", "format": "aseprite" },
  "size": { "w": 32, "h": 32 },
  "detectedScale": 1,
  "frames": 6,
  "layers": ["body", "head", "hand_l", "hand_r"],
  "tags": ["idle", "walk"],
  "colorMapping": { "mode": "exact", "offPalette": [], "substitutions": [] },
  "alphaThresholded": 0,
  "warnings": ["Layer 'shadow' had 50% opacity; flattened to 100%"]
}
```

**Implementation notes:**
- PNG decoding: `pngjs` (handles indexed, truecolor, grayscale, and reads `tEXt` chunks).
- Aseprite decoding: an npm parser such as `ase-parser`, validated against the official format spec (`docs/ase-file-specs.md` in the Aseprite GitHub repo). If the library doesn't cover a chunk type (e.g. tilemaps, newer versions), fall back to a small in-house decoder for that chunk; cel data is zlib-compressed and straightforward to read.
- File access is restricted to the project directory and explicitly configured asset directories (`configure_project({ importRoots: [...] })`).
- Imported documents record `source: { path, format, importedAt, sha256 }` for `export_to_source`.

## 7. Layered Characters (Cutout / Paper-Doll)

A `character` document has one layer per body part. A rig describes how they connect.

```ts
interface Rig {
  parts: RigPart[];
  directions: Direction[];       // e.g. ["down", "up", "left", "right"] or 8-way
  drawOrder: Record<Direction, string[]>; // layerIds back → front, per direction
}

interface RigPart {
  layerId: string;               // "head", "body", "hand_l", "hand_r", "foot_l", "foot_r"
  parent?: string;               // e.g. hand_l → body
  pivot: { x: number; y: number };       // rotation/anchor point, in canvas pixels
  attachPoint?: { x: number; y: number }; // where this part sits on its parent, in parent's pixels
}

interface Pose {
  name: string;                  // "idle_0", "walk_1", ...
  parts: Record<string, { dx: number; dy: number; flipX?: boolean; hidden?: boolean }>;
}
```

| Tool | Description |
|---|---|
| `define_rig_part(docId, layerId, pivot, parent?, attachPoint?)` | |
| `set_draw_order(docId, direction, layerIds[])` | Far-side limbs go behind the body. |
| `define_pose(docId, pose)` | Integer offsets only, so pixels stay crisp. |
| `mirror_rig(docId, fromDirection, toDirection)` | Generates e.g. `left` from `right`: flips parts, swaps `_l`/`_r` layers, mirrors pivots, reverses draw order. |
| `render_assembled(docId, pose, direction)` 🖼 | |

**Rules the server should enforce or warn about:**
- Each part must overlap its parent by at least 1–2 pixels at the attach point, so gaps don't appear when parts move.
- Parts should be drawn per direction (one frame per direction, or one document per direction; pick one and be consistent).
- Rotation is not supported at runtime by default (see §13). Animation is translation, flipping, and swapping part frames.

## 8. Seamless Tilesets

```ts
interface TilesetConfig {
  tileSize: number;              // e.g. 16
  wrapDrawing: boolean;          // drawing tools wrap at tile edges
  template?: "corner15" | "blob47";
  terrains?: { lower: string; upper: string }; // e.g. { lower: "dirt", upper: "grass" }
  overlay?: boolean;             // true: "lower" corners are transparent (index 0), drawn over a separate base
}
```

| Tool | Description |
|---|---|
| `set_wrap_mode(docId, enabled)` | When on, every drawing tool wraps around canvas edges. |
| `check_seams(docId, frame?)` 🖼 | Compares opposite edges; returns a list of mismatched or high-contrast edge pixels and a highlighted preview. |
| `create_transition_set(name, tileSize, template, terrains, paletteId, overlay?)` | Creates a tileset document with one frame per tile in the template, each frame labelled with its corner mask and a faint guide layer showing which corners are upper/lower terrain. |
| `generate_autotile(docId, template, sources)` | `template`: `"corner15"` (default, see §8.1) or `"blob47"`. `sources` are small hand-drawn pieces (fill, edge, outer corner, inner corner). Fills in the remaining tiles as a starting point the model then refines. |
| `check_transition_set(docId)` 🖼 | Verifies that every pair of tiles that can sit next to each other has matching pixels along the shared edge (see §8.1), and that all tiles exist. Returns mismatches and a highlighted preview. |
| `render_terrain_preview(docId, map, scale)` 🖼 | Renders a sample map using the set. `map` is an array of strings where each character is a terrain cell (e.g. `"g"` grass, `"d"` dirt), rendered with the dual grid. If `map` is omitted, a built-in test map containing every corner combination (including diagonals and 1-cell strips) is used. |
| `export_tileset(docId, columns?)` | Single PNG atlas with padding + extrusion, plus metadata listing each tile's rect and its corner mask or blob bitmask. |

### 8.1 Corner15 Template and the Dual Grid

**Corner masks.** Each tile is identified by which of its four corners are the *upper* terrain (e.g. grass) versus the *lower* terrain (e.g. dirt):

```
mask = TL*1 + TR*2 + BR*4 + BL*8      // each corner is 1 if upper terrain
```

Mask 0 (all lower) is not drawn: it's the base tile, or nothing at all in overlay mode. That leaves 15 tiles:

| Masks | Shape |
|---|---|
| 1, 2, 4, 8 | Outer corners (one corner upper) |
| 3, 6, 12, 9 | Edges (two adjacent corners upper) |
| 7, 14, 13, 11 | Inner corners (three corners upper) |
| 5, 10 | Diagonals (opposite corners upper) |
| 15 | Full upper terrain |

The atlas is exported in mask order (1–15) in a 4×4 grid with slot 0 left empty, so `frameIndex === mask` at runtime. The bit order is written into the metadata (`"cornerOrder": ["TL","TR","BR","BL"]`) so the game never has to guess.

**Edge-matching rule (what `check_transition_set` enforces).** Along any tile edge, the pixels are determined only by the two corners at its ends. So any two tiles whose shared edge has the same pair of corner values must have identical pixels along that edge. For example, the right edge of every tile with TR=1, BR=0 must match the left edge of every tile with TL=1, BL=0. Inner pixels can vary freely.

**Dual grid (runtime, implemented in the game).** The map stores one terrain value per world cell. Visual tiles are rendered on a second grid offset by half a tile, so each visual tile sits over four world cells and those cells are its four corners. A map of W×H cells renders (W+1)×(H+1) visual tiles. Collision and gameplay remain on the world grid. With this setup, the 15 tiles cover every possible cell arrangement.

**Multiple terrains.** Two supported approaches; the project picks one:
- **Overlay (recommended):** terrains have a priority order (e.g. water < sand < dirt < grass). Each terrain above the lowest gets one overlay set, where lower-terrain corners are transparent. The game draws one dual-grid layer per terrain, bottom to top. Sets grow linearly with terrain count.
- **Per pair:** one set per specific transition (grass→dirt, dirt→water). More control, but the number of sets grows with every pair.

**Guidance for the model.** Draw tile 15 (full) first, then one edge, then one outer and one inner corner; derive the rest with `flip_selection`/`rotate_selection_90` where the art style allows (lighting direction may require hand adjustments). Hand-draw the two diagonals (5, 10); generated diagonals usually look wrong. Always run `check_transition_set` and `render_terrain_preview` before exporting.

## 9. Animated Effects

Effects are `effect` documents using frames and tags.

| Tool | Description |
|---|---|
| `export_spritesheet(docId, tag?, layout, padding?, extrude?)` | `layout`: `"row" \| "grid" \| "packed"`. Writes PNG + metadata (frame rects, durations, tags, pivot). |

Recommended effect workflow for the model: block out the silhouette per frame at low detail → check `render_frames` → color with `radial_gradient` + ramps → refine with `draw_grid` → `render_onion` to check frame-to-frame continuity.

Additive glow layers (`blend: "additive"`) export as a separate `*_glow.png` with the same frame layout.

## 10. Icons

| Tool | Description |
|---|---|
| `create_icon_set(name, size, count, paletteId)` | One document, one frame per icon, with a guide layer marking a safe area (e.g. 1px margin). |
| `apply_icon_style(docId, outline, shadow)` | Applies the same outline color and drop shadow to every frame, for consistency. |
| `export_icon_atlas(docId, names[])` | PNG atlas + metadata mapping names to rects. |

## 11. Export & Three.js Integration

### 11.1 Files

All exports are **indexed PNGs** (palette embedded) written to `outputDir`. Guide layers and hidden layers are never exported.

| Asset | Files |
|---|---|
| Single sprite | `name.png` |
| Character | `name_<part>_<direction>.png` per part, or one atlas `name.png` with all parts (configurable) |
| Effect | `name.png` (sheet), optional `name_glow.png` |
| Tileset | `name.png` (atlas) |
| Icons | `name.png` (atlas) |
| Metadata | `name.json` (sidecar) and/or embedded `tEXt` chunk keyed `pixelmcp` |
| Manifest | `assets.generated.ts` |

### 11.2 Metadata Schema

```json
{
  "version": 1,
  "image": "fireball.png",
  "size": { "w": 160, "h": 34 },
  "pixelsPerUnit": 16,
  "frames": [
    {
      "name": "fireball_0",
      "rect": { "x": 2, "y": 2, "w": 30, "h": 30 },
      "uv": { "offsetX": 0.0125, "offsetY": 0.0588, "repeatX": 0.1875, "repeatY": 0.8824 },
      "durationMs": 80,
      "pivotPx": { "x": 15, "y": 15 },
      "center": { "x": 0.5, "y": 0.5 }
    }
  ],
  "tags": [{ "name": "loop", "from": 0, "to": 4, "direction": "forward" }]
}
```

**Coordinate conventions (important):**
- `rect` and `pivotPx` use image space: origin top-left, y down.
- `uv` uses Three.js texture space with `texture.flipY = true` (the default): origin bottom-left. `offsetY = 1 - (rect.y + rect.h) / imageHeight`.
- `center` matches `THREE.Sprite.center`: (0,0) bottom-left, (1,1) top-right of the frame. `center.y = 1 - pivotPx.y / rect.h`. A feet pivot is typically `(0.5, 0)`.
- Characters additionally include per-part `attachPoint`, `parent`, per-direction `drawOrder`, and named poses with integer pixel offsets (convert to world units by dividing by `pixelsPerUnit`).

### 11.3 Generated TypeScript Manifest

```ts
// assets.generated.ts — do not edit
export const assets = {
  fireball: {
    url: "assets/fireball.png",
    frames: [/* ...as in metadata... */],
    tags: { loop: [0, 4] },
  },
} as const;
export type AssetName = keyof typeof assets;
```

### 11.4 Runtime Setup (for reference, implemented in the game, not the MCP)

```ts
tex.magFilter = THREE.NearestFilter;
tex.minFilter = THREE.NearestFilter;
tex.generateMipmaps = false;
tex.colorSpace = THREE.SRGBColorSpace;

new THREE.SpriteMaterial({ map: tex, alphaTest: 0.5, transparent: false, toneMapped: false });
```

- `toneMapped: false` + `SRGBColorSpace` keep palette colors exact.
- Binary alpha + `alphaTest` avoids transparent sorting issues; glow layers use a separate additive, transparent material.
- Corner15 tilesets use the dual grid (§8.1): offset the tile layer by half a tile in both axes and pick each tile with `frameIndex = mask`.
- `SpriteMaterial` shares texture `offset`/`repeat` across instances; many simultaneously animating effects need cloned textures or an `InstancedMesh` with a per-instance frame attribute.
- Layered characters: either one camera-facing group with a quad per part ordered by `renderOrder` (not small z-offsets, which z-fight), or runtime compositing to a `CanvasTexture`.

## 12. Validation

`validate_document(docId)` and every export run these checks. Errors block export; warnings are reported.

| Check | Level |
|---|---|
| Any index outside palette range | Error |
| Partial alpha in source data | Error |
| Canvas size not a multiple of 8 | Warning |
| Orphan single pixels | Warning |
| Tile seams mismatched (tilesets) | Warning |
| Corner15 set missing tiles or failing the edge-matching rule | Error |
| Rig part not overlapping parent at attach point | Warning |
| Frame missing duration or tag gaps | Warning |
| Icon content outside safe area | Warning |

## 13. Out of Scope (v1)

- Arbitrary-angle rotation of pixel art (a RotSprite-style pre-render could be added later for cutout characters).
- AI image generation or importing/tracing photos.
- Writing `.aseprite` files (reading is supported, see §6.8).
- Normal maps and lighting.
- A graphical editor UI.

## 14. Milestones

1. **Core:** documents, palette loading, layers, `draw_grid`/`read_grid`, primitives, `render_preview`, single PNG export, validation.
2. **Animation:** frames, tags, onion skin, `render_frames`, spritesheet export with padding/extrusion, metadata, TS manifest.
3. **Effects polish:** ramps, `radial_gradient`, dithering, outline, drop shadow, additive glow layer export.
4. **Tilesets:** wrap mode, `render_tiled`, `check_seams`, corner15 transition sets with `check_transition_set` and dual-grid `render_terrain_preview`, overlay mode, blob47 generation, tileset export.
5. **Characters:** rig, poses, draw order, `mirror_rig`, `render_assembled`, part export.
6. **Icons:** icon sets, shared style, atlas export.
7. **Import:** `inspect_file`, PNG import (all slicing modes, color mapping, scale detection), lossless re-import of MCP exports, `.aseprite` import, `export_to_source`. PNG import with `"metadata"` slicing can be pulled into milestone 2 if editing existing assets is needed early.

## 15. Acceptance Criteria

- A model using only these tools can produce, end to end: a 16-color palette with ramps, a 5-frame fireball spritesheet, a 32×32 character with 6 parts in 4 directions plus an idle and walk pose set, a 16×16 grass-over-dirt corner15 transition set (overlay mode) that passes `check_transition_set` and renders the built-in test map without visible seams, and 8 matching 16×16 icons.
- Every exported PNG is indexed, has no partial alpha, and loads in Three.js with the settings in §11.4 with no visible bleeding or color shift.
- Metadata `uv` and `center` values plug directly into `texture.offset`/`texture.repeat` and `Sprite.center` without manual conversion.
- Exports are byte-identical across repeated runs with the same inputs.
- Round trip: exporting any asset, importing it with `"metadata"` slicing, and exporting again produces byte-identical PNGs and metadata.
- Importing an `.aseprite` file with layers, tags, and varying frame durations yields frames pixel-identical to Aseprite's own PNG export of that file (for files using only normal blend at full opacity).
- Importing a truecolor PNG with off-palette colors in `"exact"` mode fails with a complete list of offending colors and changes nothing.

## 16. Guidance for the Model Using This Server

- Load or define the palette and ramps first; never pick colors outside them.
- Block out silhouettes before detail. Check `render_preview` after every significant change, not just at the end.
- Prefer `draw_grid` for anything detailed; use `read_grid` before editing existing work.
- For animation, review with `render_frames` and `render_onion` every time frames change.
- For tiles, always check `render_tiled` and `check_seams` before exporting; for transition sets, also `check_transition_set` and `render_terrain_preview`.
- Use `render_in_context` to confirm new assets match the scale and style of existing ones.
- When editing an existing asset: `inspect_file` first, import with `"exact"` color mode, then `read_grid` and `render_preview` before changing anything. Edit only the pixels the change requires, and use `export_to_source` so the asset keeps its path.
