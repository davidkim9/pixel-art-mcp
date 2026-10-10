/**
 * Builds the README images in docs/showcase/preview/ from the exported assets in docs/showcase/.
 *
 *   npx tsx docs/showcase/build-previews.ts
 *
 * The scene is composed the way a game would do it: it only reads the exported PNGs and their
 * JSON metadata (frame rects, tags, corner masks), never the editor's project file.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lzwEncode } from "../../src/gif.js";
import { decodePng, encodeRgbaPng } from "../../src/png.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "preview");
mkdirSync(out, { recursive: true });

interface Rect { x: number; y: number; w: number; h: number }
interface Frame { name: string; rect: Rect; durationMs: number; mask?: number }
interface Sheet {
  width: number;
  indices: Uint8Array;
  palette: { r: number; g: number; b: number }[];
  frames: Frame[];
  tags: { name: string; from: number; to: number }[];
}

function load(name: string): Sheet {
  const png = decodePng(readFileSync(join(here, `${name}.png`)));
  const meta = JSON.parse(readFileSync(join(here, `${name}.json`), "utf8"));
  if (!png.indices || !png.palette) throw new Error(`${name}.png is not indexed`);
  return { width: png.width, indices: png.indices, palette: png.palette, frames: meta.frames, tags: meta.tags ?? [] };
}

// ---------------------------------------------------------------- upscaled sheets

function upscale(name: string, scale: number) {
  const png = decodePng(readFileSync(join(here, `${name}.png`)));
  const w = png.width * scale, h = png.height * scale;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / scale) * png.width + Math.floor(x / scale)) * 4;
      rgba.set(png.rgba.subarray(s, s + 4), (y * w + x) * 4);
    }
  writeFileSync(join(out, `${name}.png`), encodeRgbaPng(w, h, rgba));
}

upscale("hero", 4);
upscale("explosion", 4);
upscale("coin", 6);
upscale("sparkle", 6);
upscale("grass", 6);
upscale("path", 4);
upscale("tree", 4);

// GIFs written by the MCP's export_gif, renamed for the README
const previews = join(here, ".pixelmcp", "previews");
const gifs: Record<string, string> = { explosion96: "explosion", coin96: "coin", sparkle96: "sparkle" };
for (const d of ["down", "left", "right", "up"]) gifs[`hero_walk_walk_${d}`] = `walk_${d}`;
for (const [src, dest] of Object.entries(gifs))
  if (existsSync(join(previews, `${src}.gif`))) copyFileSync(join(previews, `${src}.gif`), join(out, `${dest}.gif`));

// ---------------------------------------------------------------- scene

const hero = load("hero");
const grass = load("grass");
const path = load("path");
const tree = load("tree");
const coin = load("coin");
const sparkle = load("sparkle");

const TILE = 16, COLS = 15, ROWS = 10; // 240×160, a Game Boy Advance screen
const W = COLS * TILE, H = ROWS * TILE;

// Path terrain on the dual grid: one character per tile corner, "#" = dirt.
const corners = [
  "......###.......",
  "......###.......",
  "......###.......",
  "......###.......",
  "......###.......",
  "################",
  "################",
  "################",
  "................",
  "................",
  "................",
];
const tallGrass = (i: number, j: number) => i >= 10 && i <= 14 && j >= 0 && j <= 3;
const flowers = new Set(["0,3", "4,3", "9,1", "12,8", "9,9", "2,9", "14,9", "3,0"]);
const trees = [[2, -6], [48, 24], [-10, 118], [20, 122], [50, 118], [146, 120], [176, 116], [206, 122]];
const TREE_BASE = 36; // trunk bottom row inside the tree sprite

function blit(canvas: Uint8Array, sheet: Sheet, frame: number, dx: number, dy: number) {
  const { rect } = sheet.frames[frame];
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const tx = dx + x, ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const v = sheet.indices[(rect.y + y) * sheet.width + rect.x + x];
      if (v !== 0) canvas[ty * W + tx] = v;
    }
}

const frameByMask = new Map(path.frames.map((f, i) => [f.mask!, i]));
const background = new Uint8Array(W * H);
for (let j = 0; j < ROWS; j++)
  for (let i = 0; i < COLS; i++) {
    blit(background, grass, tallGrass(i, j) ? 2 : flowers.has(`${i},${j}`) ? 1 : 0, i * TILE, j * TILE);
    const c = (x: number, y: number) => (corners[y][x] === "#" ? 1 : 0);
    const mask = c(i, j) * 1 + c(i + 1, j) * 2 + c(i + 1, j + 1) * 4 + c(i, j + 1) * 8;
    if (mask) blit(background, path, frameByMask.get(mask)!, i * TILE, j * TILE);
  }

const tag = (sheet: Sheet, name: string) => sheet.tags.find((t) => t.name === name)!;
const walkCycle = (dir: string, step: number) => {
  const t = tag(hero, `walk_${dir}`); // stand, step A, step B
  return [t.from, t.from + 1, t.from, t.from + 2][step % 4];
};

// Timeline at 60 ms per tick: walk right to the coin, pick it up, walk back.
const TICK = 60, startX = 4, endX = 176, feetY = 110, heroY = feetY - 31;
const coinX = endX + 8, coinY = 90;
type Shot = { x: number; frame: number; coin: boolean; sparkle: number | null };
const shots: Shot[] = [];
for (let x = startX, k = 0; x <= endX; x += 2, k++) shots.push({ x, frame: walkCycle("right", k >> 1), coin: true, sparkle: null });
for (let k = 0; k < 12; k++) shots.push({ x: endX, frame: tag(hero, "walk_down").from, coin: false, sparkle: k < 6 ? k : null });
for (let x = endX, k = 0; x >= startX; x -= 2, k++)
  // the coin respawns with a twinkle once the hero has walked away
  shots.push({ x, frame: walkCycle("left", k >> 1), coin: x <= endX - 30, sparkle: x <= endX - 30 && x >= endX - 40 ? (endX - 30 - x) >> 1 : null });

const coinFrames = coin.frames.flatMap((f, i) => Array(Math.max(1, Math.round(f.durationMs / TICK))).fill(i));
const frames = shots.map((s, t) => {
  const canvas = background.slice();
  const sprites: [number, () => void][] = [];
  for (const [x, y] of trees) sprites.push([y + TREE_BASE, () => blit(canvas, tree, 0, x, y)]);
  if (s.coin) sprites.push([coinY + 14, () => blit(canvas, coin, coinFrames[t % coinFrames.length], coinX, coinY)]);
  sprites.push([feetY, () => blit(canvas, hero, s.frame, s.x, heroY)]);
  if (s.sparkle !== null) sprites.push([999, () => blit(canvas, sparkle, s.sparkle!, coinX, coinY - 4)]);
  sprites.sort((a, b) => a[0] - b[0]).forEach(([, draw]) => draw());
  return canvas;
});

writeFileSync(join(out, "scene.gif"), deltaGif(frames, 3, TICK, hero.palette));
console.log(`wrote ${out}`);

/**
 * export_gif writes every frame in full, which is fine for small sprites but heavy for a whole
 * screen. Here each frame after the first stores only the rectangle that changed, with index 0
 * (unused by the scene) as "keep the previous pixel".
 */
function deltaGif(frames: Uint8Array[], scale: number, delayMs: number, palette: { r: number; g: number; b: number }[]): Buffer {
  const bytes: number[] = [];
  const byte = (v: number) => bytes.push(v & 0xff);
  const word = (v: number) => (byte(v), byte(v >> 8));
  const ascii = (s: string) => [...s].forEach((c) => byte(c.charCodeAt(0)));
  const sw = W * scale, sh = H * scale;
  ascii("GIF89a");
  let bits = 2;
  while (1 << bits < palette.length) bits++;
  word(sw), word(sh), byte(0xf0 | ((bits - 1) << 4) | (bits - 1)), byte(0), byte(0); // global color table
  for (let i = 0; i < 1 << bits; i++) {
    const c = palette[i] ?? { r: 0, g: 0, b: 0 };
    byte(c.r), byte(c.g), byte(c.b);
  }
  byte(0x21), byte(0xff), byte(11), ascii("NETSCAPE2.0"), byte(3), byte(1), word(0), byte(0);
  frames.forEach((f, n) => {
    const prev = n > 0 ? frames[n - 1] : null;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (!prev || prev[y * W + x] !== f[y * W + x]) (x0 = Math.min(x0, x), y0 = Math.min(y0, y), x1 = Math.max(x1, x), y1 = Math.max(y1, y));
    if (x1 < 0) (x0 = y0 = 0), (x1 = y1 = 0); // nothing changed: a 1-pixel transparent update
    const rw = (x1 - x0 + 1) * scale, rh = (y1 - y0 + 1) * scale;
    const px = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++)
      for (let x = 0; x < rw; x++) {
        const i = (y0 + Math.floor(y / scale)) * W + x0 + Math.floor(x / scale);
        px[y * rw + x] = prev && prev[i] === f[i] ? 0 : f[i];
      }
    byte(0x21), byte(0xf9), byte(4), byte((1 << 2) | 1), word(Math.round(delayMs / 10)), byte(0), byte(0);
    byte(0x2c), word(x0 * scale), word(y0 * scale), word(rw), word(rh), byte(0), byte(bits);
    const data = lzwEncode(bits, px);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.subarray(i, i + 255);
      byte(block.length), block.forEach(byte);
    }
    byte(0);
  });
  byte(0x3b);
  return Buffer.from(bytes);
}
