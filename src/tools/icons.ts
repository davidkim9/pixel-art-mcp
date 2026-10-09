import { z } from "zod";
import { writeExport } from "../export/write.js";
import { applyIconStyle, createIconSet, exportIconAtlas } from "../icons.js";
import type { IconStyle } from "../types.js";
import type { Project } from "../project.js";
import { fail } from "../util/errors.js";
import { checkColor, zColor, zDocId } from "./helpers.js";
import type { Register } from "./helpers.js";

export function registerIconTools(register: Register, project: Project): void {
  register({
    name: "create_icon_set",
    title: "Create icon set",
    description:
      "Create an icon document: size×size, one frame per icon (count), a drawing layer \"icon\" and a locked guide layer marking the safe area " +
      "(margin px, default 1) that outline and shadow need. names labels the frames (used by export_icon_atlas).",
    input: {
      name: z.string().min(1),
      size: z.number().int().min(4).max(512),
      count: z.number().int().min(1).max(1024),
      paletteId: z.string().optional(),
      margin: z.number().int().min(0).optional(),
      names: z.array(z.string()).optional(),
    },
    handler: (args) => {
      const doc = createIconSet(project, { ...args, margin: args.margin ?? 1 });
      project.addDoc(doc);
      return {
        data: {
          docId: doc.id,
          size: args.size,
          icons: doc.frames.length,
          safeArea: { x: doc.icon!.margin, y: doc.icon!.margin, w: args.size - 2 * doc.icon!.margin, h: args.size - 2 * doc.icon!.margin },
          layers: doc.layers.map((l) => l.id),
          tip: "Leave room inside the safe area for apply_icon_style's outline (1px) and shadow offset.",
        },
      };
    },
  });

  register({
    name: "apply_icon_style",
    title: "Apply icon style",
    description:
      "Apply the same outline and drop shadow to every icon, for consistency. outline: palette index or {color, connectivity 4|8}; shadow: palette index " +
      "or {color, dx, dy} (default offset 1,1). They are generated on layers style_outline / style_shadow below the art and regenerated each call, so " +
      "re-run after editing icons. Omit both to re-apply the last style; pass null to remove one.",
    input: {
      docId: zDocId,
      outline: z.union([zColor, z.object({ color: zColor, connectivity: z.union([z.literal(4), z.literal(8)]).optional() }), z.null()]).optional(),
      shadow: z.union([zColor, z.object({ color: zColor, dx: z.number().int().optional(), dy: z.number().int().optional() }), z.null()]).optional(),
    },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      if (doc.kind !== "icon") fail(`Document "${doc.id}" is not an icon set.`);
      const stored = doc.icon?.style;
      let style: IconStyle;
      if (args.outline === undefined && args.shadow === undefined) {
        if (!stored) fail("Pass outline and/or shadow (no style has been applied yet).");
        style = stored;
      } else {
        style = {
          outline:
            args.outline === undefined || args.outline === null
              ? null
              : typeof args.outline === "number"
                ? { color: args.outline, connectivity: 4 }
                : { color: args.outline.color, connectivity: args.outline.connectivity ?? 4 },
          shadow:
            args.shadow === undefined || args.shadow === null
              ? null
              : typeof args.shadow === "number"
                ? { color: args.shadow, dx: 1, dy: 1 }
                : { color: args.shadow.color, dx: args.shadow.dx ?? 1, dy: args.shadow.dy ?? 1 },
        };
      }
      if (style.outline) checkColor(project, doc, style.outline.color, "outline color");
      if (style.shadow) checkColor(project, doc, style.shadow.color, "shadow color");
      const result = applyIconStyle(doc, style);
      doc.icon = { size: doc.icon?.size ?? doc.width, margin: doc.icon?.margin ?? 0, style };
      return { data: { style, ...result, layers: doc.layers.map((l) => l.id) } };
    },
  });

  register({
    name: "export_icon_atlas",
    title: "Export icon atlas",
    description:
      "Export all icons as one indexed PNG atlas (grid, padding + extrusion) with metadata mapping names to frames/rects (\"icons\": {name: index}). " +
      "names (in frame order) override the frame labels.",
    input: { docId: zDocId, names: z.array(z.string()).optional(), columns: z.number().int().min(1).optional(), name: z.string().optional() },
    mutates: (a) => a.docId,
    handler: (args) => {
      const doc = project.getDoc(args.docId);
      const result = exportIconAtlas(project, doc, args);
      return { data: { ...writeExport(project, result), icons: result.metadata.icons, size: result.metadata.size } };
    },
  });
}
