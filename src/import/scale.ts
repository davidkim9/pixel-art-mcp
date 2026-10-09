/** Integer upscale detection ("auto" scale) and downsampling. */

function divisorsDesc(n: number): number[] {
  const out: number[] = [];
  for (let d = n; d >= 1; d--) if (n % d === 0) out.push(d);
  return out;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Largest integer N such that the image size is divisible by N and every N×N
 * block is a single color. `same(i, j)` compares two pixel offsets.
 */
export function detectScale(width: number, height: number, same: (a: number, b: number) => boolean): number {
  // A single flat color is "uniform" at every factor; treat it as native resolution.
  let flat = true;
  for (let i = 1; i < width * height && flat; i++) if (!same(0, i)) flat = false;
  if (flat) return 1;
  for (const n of divisorsDesc(gcd(width, height))) {
    if (n === 1) return 1;
    let ok = true;
    for (let by = 0; by < height && ok; by += n) {
      for (let bx = 0; bx < width && ok; bx += n) {
        const first = by * width + bx;
        for (let y = by; y < by + n && ok; y++) {
          for (let x = bx; x < bx + n; x++) {
            if (!same(first, y * width + x)) {
              ok = false;
              break;
            }
          }
        }
      }
    }
    if (ok) return n;
  }
  return 1;
}

/** Comparator for thresholded RGBA: all transparent pixels are equal. */
export function rgbaComparator(rgba: Uint8Array, alphaThreshold: number): (a: number, b: number) => boolean {
  return (a, b) => {
    const ta = rgba[a * 4 + 3]! < alphaThreshold;
    const tb = rgba[b * 4 + 3]! < alphaThreshold;
    if (ta || tb) return ta && tb;
    return rgba[a * 4] === rgba[b * 4] && rgba[a * 4 + 1] === rgba[b * 4 + 1] && rgba[a * 4 + 2] === rgba[b * 4 + 2] && rgba[a * 4 + 3] === rgba[b * 4 + 3];
  };
}

/** Keeps the top-left pixel of every N×N block (channels per pixel = `channels`). */
export function downsample(data: Uint8Array, width: number, height: number, n: number, channels: number): Uint8Array {
  if (n === 1) return data;
  const w = width / n;
  const h = height / n;
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * n * width + x * n) * channels;
      out.set(data.subarray(src, src + channels), (y * w + x) * channels);
    }
  }
  return out;
}
