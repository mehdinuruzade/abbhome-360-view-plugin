/**
 * Turning a depth model's output for one wall into a relief map the widget can displace the wall
 * with. Pure functions (no DOM), so they run in tests and in the editor alike.
 *
 * Relief maps are grayscale, row-major, in facade space (u right, v down): 128 is the wall plane,
 * 255 sticks out by the relief's full depth, 0 goes in by it.
 */

/** A model's output: larger values are closer to the camera (relative inverse depth). */
export interface DepthMap {
  width: number;
  height: number;
  data: Float32Array;
}

export interface ReliefPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ReliefOptions {
  /** Median filter radius in output pixels (0 = off). Removes speckle from window reflections. */
  smoothing?: number;
  /** Fraction of extreme values ignored on each side when scaling (sky reflected in glass). */
  clip?: number;
  /** Fraction of the wall over which relief fades to the plane at every edge, so corners stay closed. */
  edgeFade?: number;
}

const DEFAULTS: Required<ReliefOptions> = { smoothing: 2, clip: 0.03, edgeFade: 0.04 };

/** Bilinear sample of a float grid at normalised (u, v). */
function sampleFloat(map: DepthMap, u: number, v: number): number {
  const x = Math.min(map.width - 1, Math.max(0, u * map.width - 0.5));
  const y = Math.min(map.height - 1, Math.max(0, v * map.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(map.width - 1, x0 + 1);
  const y1 = Math.min(map.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => map.data[yy * map.width + xx] ?? 0;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

/**
 * Least-squares plane a + b·u + c·v through the values. A wall photographed straight-on is a
 * plane at constant distance, so a fitted slope is the model's bias (e.g. "the ground is closer"),
 * not relief, and is removed.
 */
export function fitPlane(
  values: Float32Array,
  width: number,
  height: number,
  include: (z: number) => boolean = () => true,
): [number, number, number] {
  let n = 0, su = 0, sv = 0, sz = 0, suu = 0, svv = 0, suv = 0, suz = 0, svz = 0;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const z = values[y * width + x] ?? 0;
      if (!include(z)) continue;
      n++; su += u; sv += v; sz += z; suu += u * u; svv += v * v; suv += u * v; suz += u * z; svz += v * z;
    }
  }
  // Solve the 3×3 normal equations by Cramer's rule.
  const m = [n, su, sv, su, suu, suv, sv, suv, svv];
  const r = [sz, suz, svz];
  const det3 = (a: number[]) =>
    a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) - a[1]! * (a[3]! * a[8]! - a[5]! * a[6]!) + a[2]! * (a[3]! * a[7]! - a[4]! * a[6]!);
  const d = det3(m);
  if (Math.abs(d) < 1e-12) return [n ? sz / n : 0, 0, 0];
  const col = (i: number) => m.map((val, k) => (k % 3 === i ? r[Math.floor(k / 3)]! : val));
  return [det3(col(0)) / d, det3(col(1)) / d, det3(col(2)) / d];
}

/** The value below which `q` of the values fall. */
export function quantile(values: ArrayLike<number>, q: number): number {
  const sorted = Float32Array.from(values).sort();
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i] ?? 0;
}

export function medianFilter(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return values;
  const out = new Float32Array(values.length);
  const window: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      window.length = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = Math.min(width - 1, Math.max(0, x + dx));
          window.push(values[yy * width + xx] ?? 0);
        }
      }
      window.sort((a, b) => a - b);
      out[y * width + x] = window[window.length >> 1] ?? 0;
    }
  }
  return out;
}

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Model output → relief pixels of `width × height`: resample, remove the fitted plane, scale so
 * the clipped extremes reach ±1 around the median (the wall plane), median-filter, fade at the
 * edges, encode as bytes.
 */
export function depthToRelief(raw: DepthMap, width: number, height: number, options: ReliefOptions = {}): ReliefPixels {
  const opts = { ...DEFAULTS, ...options };
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) values[y * width + x] = sampleFloat(raw, (x + 0.5) / width, (y + 0.5) / height);
  }
  // Fit the plane without the outliers, so a few wild pixels can't tilt it.
  const rawLo = quantile(values, opts.clip);
  const rawHi = quantile(values, 1 - opts.clip);
  // Differences under 2 % of the model's range are noise, not relief.
  const minScale = Math.max((rawHi - rawLo) * 0.02, 1e-9);
  const [a, b, c] = fitPlane(values, width, height, (z) => z >= rawLo && z <= rawHi);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      values[i] = (values[i] ?? 0) - (a + (b * (x + 0.5)) / width + (c * (y + 0.5)) / height);
    }
  }
  const mid = quantile(values, 0.5);
  const lo = quantile(values, opts.clip);
  const hi = quantile(values, 1 - opts.clip);
  const scale = Math.max(hi - mid, mid - lo, minScale);
  for (let i = 0; i < values.length; i++) values[i] = Math.min(1, Math.max(-1, ((values[i] ?? 0) - mid) / scale));
  return encodeRelief(values, width, height, opts);
}

/**
 * Relief values in −1 … +1 → relief pixels: median-filter, fade to the wall plane at the edges,
 * encode as bytes (128 = plane).
 */
export function encodeRelief(
  values: Float32Array,
  width: number,
  height: number,
  options: Pick<ReliefOptions, 'smoothing' | 'edgeFade'> = {},
): ReliefPixels {
  const smoothing = options.smoothing ?? DEFAULTS.smoothing;
  const edgeFade = options.edgeFade ?? DEFAULTS.edgeFade;
  const filtered = medianFilter(values, width, height, Math.round(smoothing));
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    // Measured so the outermost pixels sit exactly on the edge (and get no relief).
    const v = height > 1 ? y / (height - 1) : 0.5;
    for (let x = 0; x < width; x++) {
      const u = width > 1 ? x / (width - 1) : 0.5;
      const edge = Math.min(u, 1 - u, v, 1 - v);
      const fade = edgeFade > 0 ? smoothstep(0, edgeFade, edge) : 1;
      const value = Math.min(1, Math.max(-1, filtered[y * width + x] ?? 0));
      data[y * width + x] = Math.round(128 + 127 * value * fade);
    }
  }
  return { width, height, data };
}

/** Relief at facade (u, v) in −1 (fully in) … +1 (fully out), bilinear. */
export function reliefAt(r: ReliefPixels, u: number, v: number): number {
  const x = Math.min(r.width - 1, Math.max(0, u * r.width - 0.5));
  const y = Math.min(r.height - 1, Math.max(0, v * r.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(r.width - 1, x0 + 1);
  const y1 = Math.min(r.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => ((r.data[yy * r.width + xx] ?? 128) - 128) / 127;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

/**
 * Input size for Depth Anything (DPT preprocessing): scale as little as possible so one side is
 * `target`, keep the aspect ratio, and round both sides to multiples of 14.
 */
export function dptInputSize(width: number, height: number, target = 518, multiple = 14): [number, number] {
  const sw = target / width;
  const sh = target / height;
  const scale = Math.abs(1 - sw) < Math.abs(1 - sh) ? sw : sh;
  const round = (val: number) => Math.max(multiple, Math.round(val / multiple) * multiple);
  return [round(width * scale), round(height * scale)];
}

/** ImageNet normalisation used by Depth Anything. */
export const DPT_MEAN = [0.485, 0.456, 0.406] as const;
export const DPT_STD = [0.229, 0.224, 0.225] as const;

/** RGBA bytes → planar float tensor data [3, h, w], rescaled to 0..1 and normalised. */
export function rgbaToDptTensor(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let ch = 0; ch < 3; ch++) out[ch * plane + i] = ((rgba[i * 4 + ch] ?? 0) / 255 - DPT_MEAN[ch]!) / DPT_STD[ch]!;
  }
  return out;
}
