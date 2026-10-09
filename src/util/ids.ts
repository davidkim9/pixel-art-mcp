import { createHash } from "node:crypto";

/** Lowercase identifier made of [a-z0-9_]. */
export function slugify(name: string, fallback = "item"): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

/** Returns `base`, or `base_2`, `base_3`, ... — the first one not taken. */
export function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}_${i}`;
    if (!taken(id)) return id;
  }
}

/**
 * Sanitizes an export name. Slashes are allowed and create subdirectories of
 * the output directory; every segment is restricted to [A-Za-z0-9_-].
 */
export function sanitizeAssetName(name: string): string {
  const segments = name
    .split(/[\\/]+/)
    .map((s) => s.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  return segments.join("/") || "asset";
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with every non-ASCII character escaped, so it can live in a PNG tEXt chunk. */
export function asciiJson(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(
    /[\u007f-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
