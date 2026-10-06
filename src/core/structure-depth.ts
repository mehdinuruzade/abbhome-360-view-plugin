/**
 * Depth worked out from a straightened wall photo's structure, without a model: glass and openings
 * sit back, and horizontal opaque bands between rows of windows (slab edges, balcony fronts) stick
 * out. A heuristic, not a measurement, but instant, offline, and it reads well under a raking sun.
 *
 * Output values are in −1 … +1 of `STRUCTURE_DEPTH_M`, ready for `encodeRelief` (src/core/depth.ts).
 */

import { quantile, smoothstep } from './depth';

/** Metres that ±1 stands for in a structure relief. */
export const STRUCTURE_DEPTH_M = 0.4;
/** Glass sits back by this fraction of the full depth (0.6 × 0.4 m ≈ a 24 cm reveal). */
const RECESS = 0.6;
/** Slab edges stick out by this fraction (0.5 × 0.4 m = 20 cm). */
const SLAB = 0.5;

/** Box blur with an integral image; edges clamp. */
function boxBlur(src: Float32Array, w: number, h: number, rx: number, ry: number): Float32Array {
  if (rx <= 0 && ry <= 0) return src;
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x] ?? 0;
      sum[(y + 1) * (w + 1) + x + 1] = (sum[y * (w + 1) + x + 1] ?? 0) + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - ry);
    const y1 = Math.min(h, y + ry + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rx);
      const x1 = Math.min(w, x + rx + 1);
      const s =
        (sum[y1 * (w + 1) + x1] ?? 0) - (sum[y0 * (w + 1) + x1] ?? 0) - (sum[y1 * (w + 1) + x0] ?? 0) + (sum[y0 * (w + 1) + x0] ?? 0);
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** 1 where a pixel is glass or an opening, 0 on the wall. */
export function glassMask(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const n = w * h;
  const lum = new Float32Array(n);
  const blue = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    lum[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    blue[i] = Math.max(0, b - (r + g) / 2) / 255;
  }
  // Darker than its surroundings, or than the wall as a whole (large glazing fills its own
  // neighbourhood), and a little extra for the blue cast of glass.
  const radius = Math.max(2, Math.round(w * 0.06));
  const local = boxBlur(lum, w, h, radius, radius);
  const wall = quantile(lum, 0.6);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = lum[i] ?? 0;
    const darker = Math.max((local[i] ?? 0) - l, 0.8 * (wall - l)) + 0.5 * (blue[i] ?? 0);
    raw[i] = smoothstep(0.05, 0.15, darker);
  }
  // Clean, hard-edged openings: close (fills reflections and glazing bars inside a window), then
  // open (drops specks on the wall). Architecture is made of flat planes, so the mask is binary.
  let mask: Float32Array = new Float32Array(n);
  for (let i = 0; i < n; i++) mask[i] = (raw[i] ?? 0) >= 0.5 ? 1 : 0;
  const close = Math.max(1, Math.round(w * 0.008));
  mask = erode(dilate(mask, w, h, close), w, h, close);
  mask = dilate(erode(mask, w, h, 1), w, h, 1);
  return mask;
}

function dilate(mask: Float32Array, w: number, h: number, r: number): Float32Array {
  const blurred = boxBlur(mask, w, h, r, r);
  return blurred.map((v) => (v > 1e-4 ? 1 : 0));
}

function erode(mask: Float32Array, w: number, h: number, r: number): Float32Array {
  const blurred = boxBlur(mask, w, h, r, r);
  return blurred.map((v) => (v > 1 - 1e-4 ? 1 : 0));
}

/**
 * Structure relief for a straightened wall image (`w × h` RGBA), resampled to `outW × outH`.
 * Values: −RECESS for glass, +SLAB for slab bands, 0 for the wall plane.
 */
export function structureDepth(rgba: Uint8ClampedArray, w: number, h: number, outW: number, outH: number): Float32Array {
  const glass = glassMask(rgba, w, h);

  // A row is a slab band when it is (nearly) all opaque while rows of windows are close by;
  // a blank wall, opaque everywhere, gets no bands.
  const opaque = new Float32Array(h);
  const x0 = Math.floor(w * 0.06);
  const x1 = Math.max(x0 + 1, Math.ceil(w * 0.94));
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) s += glass[y * w + x] ?? 0;
    opaque[y] = 1 - s / (x1 - x0);
  }
  const reach = Math.max(2, Math.round(h * 0.04));
  const band = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let nearMin = 1;
    for (let dy = -reach; dy <= reach; dy++) nearMin = Math.min(nearMin, opaque[Math.min(h - 1, Math.max(0, y + dy))] ?? 1);
    band[y] = (opaque[y] ?? 0) > 0.9 && nearMin < 0.75 ? 1 : 0;
  }

  const full = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const b = band[y] ?? 0;
    for (let x = 0; x < w; x++) {
      const g = glass[y * w + x] ?? 0;
      full[y * w + x] = SLAB * b * (1 - g) - RECESS * g * (1 - b);
    }
  }

  // Area-average down to the output size.
  const out = new Float32Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const ya = Math.floor((oy * h) / outH);
    const yb = Math.max(ya + 1, Math.floor(((oy + 1) * h) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const xa = Math.floor((ox * w) / outW);
      const xb = Math.max(xa + 1, Math.floor(((ox + 1) * w) / outW));
      let s = 0;
      let count = 0;
      for (let y = ya; y < Math.min(h, yb); y++) {
        for (let x = xa; x < Math.min(w, xb); x++) {
          s += full[y * w + x] ?? 0;
          count++;
        }
      }
      out[oy * outW + ox] = count ? s / count : 0;
    }
  }
  return out;
}
