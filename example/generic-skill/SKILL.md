---
name: pixel-art-guide
description: Art direction and pixel-art MCP workflow for <GAME> — the palette and its material ramps, shading and lighting rules, colour budgets, canvas sizes and pivots for characters, tiles, props, icons, effects and UI, animation timing, and how an export gets into the game. Load before creating, editing, or reviewing any pixel art with the pixel-art MCP.
---

<!--
  TEMPLATE. Copy this file to .claude/skills/pixel-art-guide/SKILL.md in your game's repo and
  fill in every <PLACEHOLDER>. Delete any section your game doesn't use (no tiles? drop §4.3),
  delete these comments, and keep the rest short: this whole file is loaded into context.

  The defaults below are sensible for most small-palette, flat-shaded games. Change them freely,
  but write down *your* rule, measured from your own art, rather than leaving a default you
  don't actually follow. A rule the existing assets break is worse than no rule.
-->

# Pixel Art Guide (<GAME>)

Every asset should look like it came from the same hand, at the same scale, under the same light. When this guide and an existing asset disagree, this guide wins and the asset goes on the legacy list (§8).

**Authorities.** <`src/assets/manifest.ts`, the level editor, a design doc…> defines which assets exist and what each must show. Read the entry before drawing. Engine-side sizes live in <`src/render/constants.ts`>; if they change, update §4.

**Game at a glance** — the facts every drawing decision depends on:

| | |
|---|---|
| Camera | <side-view platformer / top-down / 3/4 top-down / isometric / fixed-screen UI> |
| Pixels per world unit | <16 / 32> (`pixelsPerUnit`) |
| On-screen scale | art is shown at <2×–4×>, integer scaling only, never at the 10× previews |
| Base resolution | <320×180 / 480×270 / …> — the size the player sees one screen at |
| Facings | <right only, engine flips for left / 4 directions / 8 directions> |

## 1. Palette: one palette, nothing else

- `<palette-file>` (<name>, <N> colours) is the only source of colour. Never invent a hex value or pick a "close enough" colour. <Optionally: no pure `#000000` or `#ffffff`.>
- Index 0 is transparent, so colour *n* in the file is MCP index *n* (1–<N>).
- Hard alpha only: every pixel is fully opaque or fully transparent. No anti-aliasing, no soft edges. Glows and light are additive layers (§4.5), not translucent pixels.
- Ramps run dark → light within one hue family. List them here once and refer to them by name:

| Ramp | Indices (dark → light) | Typical use |
|---|---|---|
| <neutral> | <1–8> | outlines (darkest), stone, metal |
| <skin> | <…> | |
| <foliage> | <…> | |
| <…> | | |

**Material ramps in use.** Reuse these instead of choosing new tones. Add a row whenever a new material is settled, so the next asset made of it matches.

| Material | Indices (dark → light) | Used by |
|---|---|---|
| <wood> | <…> | <crates, doors> |
| <metal> | <…> | <weapons, armour> |
| <…> | | |

**Reserved colours.** Keep a few indices out of the environment so gameplay reads at a glance: <player accent>, <hazard / damage>, <pickup / interactable>, <UI highlight>. A background that uses the hazard red teaches the player to ignore it.

<If the game has palette swaps, themes, or team colours, say here how they work: which indices get swapped, and that things which must stay distinct need distinct indices in the master palette.>

## 2. Style

- **Flat cel tones.** One base tone per surface, at most one shadow and one highlight from the same ramp, as hard-edged shapes. No pillow shading (darkening every edge evenly). <Change this if the game is deliberately richer: e.g. "up to two shadow steps; ordered dither only on skies and large backgrounds".>
- **Darken by stepping down the same ramp**, never by borrowing another family's dark. Hue shifting comes from the ramp.
- **Light direction depends on whether the art flips.** Anything the engine mirrors (characters, mobs, projectiles) is lit from straight above so the light doesn't swap sides when it turns. Art that never flips (tiles, props, icons, UI) is lit from the top-left.
- **Outlines.** <Pick one and keep it:> characters and effects get a 1-px outline in the darkest tone of each part's own ramp; use index <1> when a neutral dark is needed. <Tiles: no outline, shapes are tone breaks. Icons: selective outline — dark on shadowed sides, lighter on lit sides.>
- **Texture is sparse single pixels** one tone from the base. Never noise.
- **Pixel-perfect lines** everywhere a line is 1 px wide. See the fundamentals below.
- **No orphan pixels** unless deliberate (a sparkle, an eye). `find_orphan_pixels` finds them.
- **Read at 1×.** Chunky silhouettes, no 1-px wisps the player can't see. Squint at the 1× preview: if the shape doesn't read, detail won't save it.

### Pixel-art fundamentals

These hold for any style. Check them on every asset before calling it done.

**1. Pixel-perfect lines: drop the L-corners (almost always).** An L-corner is a pixel where a 1-px line turns: its two neighbours sit orthogonally to it and diagonally to each other. It reads as a thick lump in the line and makes curves look jagged. Remove the corner pixel so the line steps diagonally.

```
L-corners (avoid)      pixel-perfect
##                     #
 ##                     #
  ###                    ##
     ##                    ##
```

This applies to outlines, hair strands, cracks, cables and the edges of curves. An outline drawn as the inner boundary of a filled shape (fill pixels that have an empty orthogonal neighbour) is already pixel-perfect. An outline drawn as the outer ring around a shape picks up L-corners at every diagonal step, so clean those.

**Keep an L-corner only when the corner is real:**
- **Square forms.** Box corners, buildings, windows, UI frames, crates, the 90° corners of a tile grid. Rounding them makes them look soft or melted.
- **Lines thicker than 1 px.** A 2-px stroke or a filled cluster has no L-corner problem. The rule is about 1-px lines.
- **A deliberate sharp joint**, such as an elbow, the tip of a blade, or the point where a cap's visor meets the crown. The corner pixel is the detail there.
- **Very small sprites (8×8 and under)** when removing the pixel would break the silhouette or disconnect a part. Legibility beats purity.

**2. Clean slopes.** Straight lines use consistent run lengths: 1:1 (45°), 2:1, 3:1, 1:2. A run of `3-1-2-1-3` is a jaggy; pick a ratio and keep it. Don't mix ratios inside one straight edge.

**3. Smooth curves.** A curve's runs change gradually and symmetrically: `4-2-1-1-2-4`, never `4-1-3-1`. No run may be longer than the one before it on the way into the curve. Use `draw_ellipse` for round shapes and check that circles don't come out as rounded squares.

**4. Clusters, not noise.** Every colour region should be a deliberate cluster with a readable shape. Single pixels of a different tone in a flat area read as dirt. Texture is a few small, purposeful clusters (a 2–3 px leaf mark, a plank knot), placed sparsely.

**5. No pillow shading.** Don't darken every edge evenly toward the centre. Pick the light direction (§2) and shade the form as a volume: light planes face the light and shadow planes face away.

**6. No banding.** Adjacent ramp steps whose stair-steps line up in parallel make the shape look like stacked contour lines. Offset each band's steps, vary their widths, or merge one away.

**7. Outlines that serve the form.**
- Colour the outline from the darkest step of the part's own ramp (selective outline), not pure black, unless the style calls for a neutral dark.
- Use internal lines only where parts overlap or separate (an arm in front of a torso, the edge of a visor), and make them lighter than the silhouette outline.
- Keep outline thickness consistent across the asset set.

**8. Anti-aliasing by hand, inside only.** Hard alpha means no automatic AA. You may soften a long, shallow inner curve with one intermediate ramp colour at the steps, but never anti-alias the outer silhouette of a sprite that will sit on changing backgrounds. It leaves a halo.

**9. Dither sparingly.** Use ordered dithering for large gradients (skies, glows, big backgrounds) or a deliberate texture. Don't dither small sprites or character shading; at 1× it reads as noise.

**10. Contrast and colour.**
- Hue-shift through the ramp: shadows cooler and more saturated, highlights warmer.
- Check values in greyscale. If the silhouette and the main forms vanish, the colours are doing work that value should do.
- Keep the brightest highlight and the darkest dark for the focal point, such as a face or eyes.

**11. Silhouette first.** Fill the shape with one colour and check that it reads at 1×. If it doesn't, fix the shape before adding a single detail. Exaggerate what matters for gameplay: heads, weapons, the direction the character is facing.

**12. Symmetry where it is real.** Front and back views of a character are usually symmetric. Draw one half and mirror it, then break the symmetry on purpose: lighting, a parting in the hair, an item held in one hand.

### Readability (gameplay first)

- **Value separates layers of the game.** Backgrounds are lower contrast and <darker / more desaturated> than the play layer; characters, enemies and interactables carry the strongest contrast on screen.
- The player character must stand out on every background in the game. Check it with `render_in_context` on the busiest tile you have.
- Things the player can touch, collect, or be hurt by look different from decoration — by colour (§1 reserved colours), outline, or animation.
- Every enemy reads by silhouette alone. Fill it with one colour; if two enemies look the same, change the shape, not the colours.

## 3. Colour budgets

A hard cap per asset. In `draw_grid` the legend *is* the colour count, so count it.

| Asset | Opaque colours |
|---|---|
| Character part | 2–4 |
| Whole character / enemy | ≤ <8> (a boss doesn't get more just because it is bigger) |
| Tile | 2–5 from one ramp, +1 accent ramp |
| Prop | ≤ <8> |
| Item / UI icon | ≤ <8> |
| Effect frame | 2–5 |

Over budget: merge tones before adding detail.

## 4. Asset conventions

Sizes are multiples of the tile size unless noted. Origins are top-left, y down; pivots are in canvas pixels.

### 4.1 Characters and enemies

<Choose the model your engine uses and delete the other.>

**Rigged (paper-doll) characters.** One `kind: "character"` document, one layer per part, named exactly as the engine expects: <`head, body, hand_l, hand_r, foot_l, foot_r`>. Canvas <32×32>, feet end at row <30>.

| Part | Bounds x, y (inclusive) | Pivot | Parent |
|---|---|---|---|
| `head` | <…> | <neck> | `body` |
| `body` | <…> | <hips> | — |
| `hand_l` / `hand_r` | <…> | <wrist> | `body` |
| `foot_l` / `foot_r` | <…> | <ankle> | — (a body bob must not lift the feet) |

- Left and right are the character's own: facing the camera, `hand_l` is on screen right.
- Draw <down, up, right>; `mirror_rig(right → left)` makes the fourth.
- Poses are named `<anim>_<facing>_<frame>` (`walk_down_0`). Movement is in whole pixels.

**Frame-by-frame sprites.** One `kind: "sprite"` document per character, a frame per pose, tagged per animation. Canvas <32×32> with the pivot at the feet, bottom-centre (`set_pivot`), the same on every frame so the sprite doesn't swim.

Either way:
- Proportions: <chibi — head about as tall as the rest / 2.5 heads tall / …>.
- Face direction: <drawn facing right in a slight 3/4 turn; the engine flips for left>.
- Hitbox, not art, decides collision. Keep the body's visual mass inside <the engine's hitbox> so hits look fair.

### 4.2 Animation

| Animation | Frames | Frame time | Tag direction |
|---|---|---|---|
| idle | 2–4 | 150–250 ms | `pingpong` or `forward` |
| walk | 4–6 | 80–120 ms | `forward` |
| run | 6–8 | 60–90 ms | `forward` |
| attack | 3–6 | wind-up slow (120 ms+), hit 1 frame fast (40–60 ms), recover | `forward`, no loop |
| hurt | 1–2 | 80 ms | |
| death | 4–8 | 80–120 ms, last frame held | |

- **Anticipation and hold.** An attack needs a readable wind-up the player can react to, and the frame that hits should be the most extreme pose. Hold it a beat.
- **Move whole pixels.** A 1-px bob on a 32-px character is plenty. No sub-pixel jitter.
- **Keep volume.** Parts don't grow and shrink between frames unless it's deliberate squash and stretch.
- **Loops loop.** The last frame flows into the first; check with `render_onion` and `export_gif`.
- Tag every animation (`tag_frames`); the engine plays tags by name: <`idle`, `walk`, `attack`…>.

### 4.3 Tiles and terrain

- Tile size <16×16 / 32×32>. Every tile is seamless against itself: `set_wrap_mode`, then judge with `render_tiled`, then `check_seams`. A deliberate edge (a plank seam, a brick course) shows up as a seam; decide from `render_tiled`.
- Shapes inside a tile are tone breaks within one ramp (bricks, planks, cobbles), low contrast so a field of them doesn't buzz.
- Avoid a recognisable feature in the middle of a tile; repeated, it forms a grid the eye locks onto. Make 2–4 variants of common ground tiles and let the map mix them.
- Terrain transitions (<grass over dirt, water edges>) are transition sets: `create_transition_set` (corner15 for simple blends, blob47 when the engine supports it), draw the full tile, one edge, one outer and one inner corner, `generate_autotile`, fix the diagonals by hand, then `check_transition_set` and `render_terrain_preview`.
- <Side-view: the top edge of a solid tile is its walkable surface; give it a lighter lip. Top-down: walls get a darker front face <N> px tall.>

### 4.4 Props and items

- Props are <32×32> or <64×64>, sitting on the ground line with the pivot at bottom-centre. Lit top-left; they never flip.
- Pickups and items in the world <bob / sparkle / have an outline> so they read as collectable (§2 readability).
- Material variants (iron, gold, …) keep the exact shape and swap only the material ramp: draw one, then `duplicate_document` + `remap_palette`.

### 4.5 Effects and projectiles

- `kind: "effect"`, centred, lit from above if it flips. Outline in the ramp's darkest tone.
- Fast and readable: most effects are 4–8 frames at 50–80 ms. The first frame is the biggest, brightest flash; then it breaks up and fades by shrinking, not by going translucent.
- Glow goes on a layer with `blend: "additive"`, which exports as a separate `_glow.png` for the engine to add. <Delete if the engine can't draw additive sprites.>
- Size tiers (small / medium / large) scale the shape and keep the colours.

### 4.6 Icons and UI

- Icons are <16×16> in a `create_icon_set` with a shared safe area; `apply_icon_style` adds the outline and drop shadow so every icon matches. Re-run it after edits.
- Silhouette first: an icon has to be recognised at 1× on its slot background without its label.
- UI frames and panels are 9-slice: corners fixed, edges and centre repeat cleanly. Draw the centre as a seamless tile.
- Text is <the game's bitmap font>; never draw lettering into art that will need translating.

### 4.7 Folders and names

| Asset | Path under `<outputDir>` |
|---|---|
| characters | `characters/<name>.png` |
| enemies | `enemies/<name>.png` |
| tiles | `tiles/<set>.png` |
| props / items | `props/<name>.png`, `items/<name>-<material>.png` |
| effects | `effects/<name>.png` |
| icons | `icons/<set>.png` |

Names are lower-kebab-case. <Note any rename the export does, e.g. dots becoming underscores.>

## 5. MCP workflow

1. **Set up.** `load_project` if `<outputDir>/.pixelmcp` exists — it has the settings, palette, ramps and every document. Otherwise:
   - `configure_project({ outputDir: "<outputDir>", pixelsPerUnit: <16>, metadataMode: "<sidecar | embedded>", atlasPadding: <2>, atlasExtrude: <1> })`. Use `embedded` if hand-written `<name>.json` files already sit beside the PNGs, or `sidecar` would overwrite them.
   - `load_palette({ name: "<palette>", source: "<palette-file>" })`, then `define_ramp` for each ramp in §1 and check with `render_palette`.
2. **Look at the neighbours first.** `import_png` (`colorMode: "exact"`) one or two existing assets of the same kind and `render_preview` them. Match their scale, outline and shading before inventing anything.
3. **Silhouette, then form, then detail.** Block the shape in the base tone, then outline, shadow and highlight. Use `draw_grid` for anything detailed, and look at the preview after every step (`preview: true`).
4. **Kind-specific steps.**
   - Character (rig): draw each part per facing → `define_rig_part` → `mirror_rig` → `define_pose` → `render_assembled` for every pose → `export_character`.
   - Animated sprite: add frames → `render_frames` and `render_onion` after every change → `set_frame_duration` → `tag_frames` → `export_gif` to watch it move → `export_spritesheet`.
   - Tile: §4.3 → `export_tileset` (or `export_png` for a single tile).
   - Icons: §4.6 → `export_icon_atlas`.
5. **Check it in context.** `render_in_context` next to existing assets of the same and neighbouring kinds (a new enemy on the tiles it will walk on).
6. **Validate.** `validate_document`, `find_orphan_pixels`, and recount the legend against §3.
7. **Edit existing art in place.** `inspect_file` → `import_png` / `import_aseprite` with `colorMode: "exact"` → `read_grid` and `render_preview` → change only the pixels the edit needs → `export_to_source` so the asset keeps its path and layout.
8. `save_project` before stopping.
9. **Into the game.** <The command or step that registers the asset, e.g. `npm run assets:import <name>`, a manifest entry, or nothing if the engine loads the folder.> Then <run the game / open the asset viewer> and look at it at real size, moving, next to its neighbours. A preview that passes at 10× can still fail in a full scene.

**Things that will trip you:**
- `load_palette` takes hex lists, `.hex`, `.gpl`, `.png` and `.aseprite`. A JASC `.pal` or any other format has to be converted to a hex list first.
- Layers added with `add_layer` are addressed by name.
- Hidden and guide layers never export. To export one part of a layered document, hide the rest.
- <Add each gotcha you hit here the first time it costs you time.>

## 6. Review checklist

- [ ] Every colour is from the palette (`validate_document` passes); no partial alpha.
- [ ] Within the §3 budget, one ramp per material, reserved colours used only for their meaning.
- [ ] Light direction matches §2 (overhead if it flips, top-left if not).
- [ ] 1-px lines and outlines are pixel-perfect (no L-corners except real square corners), slopes and curves step cleanly, and nothing is pillow-shaded, banded or noisy.
- [ ] The silhouette reads in one flat colour at 1×.
- [ ] Size, bounds and pivots match §4; the pivot doesn't move between frames.
- [ ] Animations loop cleanly and attacks have readable anticipation.
- [ ] Tiles pass `render_tiled` with no visible grid.
- [ ] Reads at 1× and stands out (or recedes) as its gameplay role demands.
- [ ] Seen in the running game next to its neighbours, not only in a preview.

## 7. Credits

<If the project tracks provenance: where generated art is recorded, e.g. a manifest entry with `source: generated`, the tool, and the licence.>

## 8. Legacy art: don't imitate

These predate the guide and break it. Restyle them when you touch them.

- <`path/to/asset.png`: anti-aliased, off-palette colours.>
- <`path/to/other/*`: pure-black outlines; swap to the ramp's dark tone.>
