import { z } from "zod";
import { getCel } from "../document.js";
import { checkColorIndex, createPalette, rampWarnings } from "../palette.js";
import { resolvePaletteSource } from "../palette-sources.js";
import type { Project } from "../project.js";
import { renderPaletteImage } from "../render/previews.js";
import { cloneDocument } from "../document.js";
import { fail } from "../util/errors.js";
import { slugify } from "../util/ids.js";
import { zDocId } from "./helpers.js";
import type { Register } from "./helpers.js";

export function registerPaletteTools(register: Register, project: Project): void {
  register({
    name: "load_palette",
    title: "Load palette",
    description:
      "Load a palette. source: a list of hex colors; the text of a Lospec .hex or GIMP .gpl file; a path to a .png, .aseprite, .gpl or .hex file " +
      "(inside the project or importRoots); or \"builtin:pico8\". Index 0 is inserted as transparent, so the first color becomes index 1 " +
      "(indexed PNG/Aseprite palettes whose entry 0 is transparent keep their indices). Reloading a name replaces that palette. " +
      "The first palette loaded becomes the project default.",
    input: {
      name: z.string().min(1),
      source: z.union([z.string(), z.array(z.string())]),
      ramps: z.record(z.string(), z.array(z.number().int())).optional().describe("Optional named ramps, dark → light"),
    },
    handler: (args) => {
      const src = resolvePaletteSource(project, args.source);
      const id = slugify(args.name, "palette");
      const palette = createPalette(id, args.name, src.colors);
      const warnings: string[] = [];
      for (const [name, indices] of Object.entries(args.ramps ?? {})) {
        indices.forEach((i) => checkColorIndex(palette, i, `Ramp "${name}" index`));
        palette.ramps[name] = indices;
        warnings.push(...rampWarnings(palette, indices));
      }
      const replaced = project.palettes.has(id);
      project.palettes.set(id, palette);
      let madeDefault = false;
      if (!project.settings.defaultPaletteId) {
        project.settings.defaultPaletteId = id;
        madeDefault = true;
      }
      return {
        data: {
          paletteId: id,
          colors: palette.colors.length - 1,
          indices: `1–${palette.colors.length - 1} (0 = transparent)`,
          origin: src.origin,
          replaced,
          isDefault: project.settings.defaultPaletteId === id,
          madeDefault,
          warnings,
        },
      };
    },
  });

  register({
    name: "list_palettes",
    title: "List palettes",
    description: "All loaded palettes with color counts and ramp names.",
    input: {},
    readOnly: true,
    handler: () => ({
      data: {
        defaultPaletteId: project.settings.defaultPaletteId ?? null,
        palettes: [...project.palettes.values()].map((p) => ({ id: p.id, name: p.name, colors: p.colors.length - 1, ramps: Object.keys(p.ramps) })),
      },
    }),
  });

  register({
    name: "get_palette",
    title: "Get palette",
    description: "Colors (index-aligned; index 0 = transparent) and ramps of a palette.",
    input: { id: z.string() },
    readOnly: true,
    handler: (args) => {
      const p = project.getPalette(args.id);
      return { data: { id: p.id, name: p.name, colors: Object.fromEntries(p.colors.map((c, i) => [i, i === 0 ? "transparent" : c])), ramps: p.ramps } };
    },
  });

  register({
    name: "render_palette",
    title: "Render palette 🖼",
    description: "Swatch image of a palette, labelled with indices, plus one row per ramp (dark → light).",
    input: { id: z.string(), swatchSize: z.number().int().min(12).max(64).optional() },
    readOnly: true,
    handler: (args) => {
      const p = project.getPalette(args.id);
      return {
        data: { id: p.id, colors: p.colors.length - 1, ramps: p.ramps },
        images: [renderPaletteImage(p, args.swatchSize ?? 28).toPng()],
      };
    },
  });

  register({
    name: "define_ramp",
    title: "Define ramp",
    description: "Name a shading ramp: palette indices ordered dark → light. Used by shade_with_ramp, radial_gradient and selective outlines.",
    input: { paletteId: z.string(), name: z.string().min(1), indices: z.array(z.number().int()).min(2) },
    handler: (args) => {
      const p = project.getPalette(args.paletteId);
      args.indices.forEach((i) => {
        checkColorIndex(p, i, "Ramp index");
        if (i === 0) fail("Ramps can't contain index 0 (transparent).");
      });
      if (new Set(args.indices).size !== args.indices.length) fail("Ramp indices must be unique.");
      p.ramps[args.name] = [...args.indices];
      return { data: { paletteId: p.id, ramp: args.name, indices: args.indices, warnings: rampWarnings(p, args.indices) } };
    },
  });

  register({
    name: "remap_palette",
    title: "Remap palette",
    description:
      "Index-to-index remap over every layer and frame, e.g. {\"12\": 30, \"13\": 31}, to make color variants (enemy recolors, team colors, an ice fireball). " +
      "With newDocName the result is written to a new document and the original is untouched.",
    input: {
      docId: zDocId,
      mapping: z.record(z.string(), z.number().int().min(0).max(255)),
      newDocName: z.string().optional(),
    },
    mutates: (a) => (a.newDocName ? undefined : a.docId),
    handler: (args) => {
      const src = project.getDoc(args.docId);
      const palette = project.paletteFor(src);
      const table = new Uint8Array(256).map((_, i) => i);
      for (const [from, to] of Object.entries(args.mapping)) {
        const f = Number(from);
        if (!Number.isInteger(f) || f < 0 || f > 255) fail(`Invalid source index "${from}".`);
        checkColorIndex(palette, to, "Target index");
        table[f] = to;
      }
      const doc = args.newDocName ? cloneDocument(src) : src;
      if (args.newDocName) {
        doc.id = project.newDocId();
        doc.name = args.newDocName;
        delete doc.source;
      }
      const counts: Record<string, number> = {};
      for (const layer of doc.layers) {
        if (layer.guide) continue;
        for (let f = 0; f < doc.frames.length; f++) {
          const cel = getCel(doc, layer.id, f);
          if (!cel) continue;
          for (let i = 0; i < cel.length; i++) {
            const v = cel[i]!;
            if (table[v] !== v) {
              counts[v] = (counts[v] ?? 0) + 1;
              cel[i] = table[v]!;
            }
          }
        }
      }
      if (args.newDocName) project.addDoc(doc);
      return { data: { docId: doc.id, name: doc.name, pixelsRemapped: counts } };
    },
  });
}
