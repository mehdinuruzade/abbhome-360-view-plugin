import { depthToRelief, encodeRelief, type DepthMap, type ReliefPixels } from '../core/depth';
import { STRUCTURE_DEPTH_M, structureDepth } from '../core/structure-depth';
import type { Corners } from '../core/types';
import { getDepthEstimator, type DepthProgress } from './depth-model';
import { loadImage, rectify } from './rectify';

/** Model relief is stored small: depth from one photo has no fine detail worth more. */
export const RELIEF_WIDTH = 256;
/** Structure relief keeps window edges crisp, so it is stored at twice that. */
export const STRUCTURE_RELIEF_WIDTH = 512;
/** Height of the straightened wall image the model sees. */
const MODEL_SOURCE_HEIGHT = 700;
/** Height of the straightened wall image structure depth reads. */
const STRUCTURE_SOURCE_HEIGHT = 900;

export { STRUCTURE_DEPTH_M };

export function reliefSize(aspect: number, width = RELIEF_WIDTH): [number, number] {
  return [width, Math.max(32, Math.min(1024, Math.round(width / aspect)))];
}

/** Grayscale relief pixels as a PNG data URL (embedded in building.json). */
export function reliefToDataUrl(pixels: ReliefPixels): string {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(pixels.width, pixels.height);
  for (let i = 0; i < pixels.data.length; i++) {
    const g = pixels.data[i] ?? 128;
    img.data[i * 4] = g;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = g;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** What a relief was made from, kept in memory so smoothing can be redone without starting over. */
export type RawRelief =
  | { kind: 'model'; depth: DepthMap }
  | { kind: 'structure'; values: Float32Array; width: number; height: number };

export interface EstimatedRelief {
  raw: RawRelief;
  dataUrl: string;
}

/** Turns stored model output or structure values into a relief image with the given smoothing. */
export function reliefFromRaw(raw: RawRelief, aspect: number, smoothing: number): string {
  if (raw.kind === 'structure') return reliefToDataUrl(encodeRelief(raw.values, raw.width, raw.height, { smoothing }));
  const [w, h] = reliefSize(aspect);
  return reliefToDataUrl(depthToRelief(raw.depth, w, h, { smoothing }));
}

/**
 * Depth from the photo's structure (glass back, slab edges forward): instant and offline.
 * `aspect` is the wall's width ÷ height in metres.
 */
export async function structureRelief(
  src: string,
  corners: Corners,
  aspect: number,
  opts: { smoothing?: number } = {},
): Promise<EstimatedRelief> {
  const img = await loadImage(src);
  const sw = Math.max(16, Math.round(STRUCTURE_SOURCE_HEIGHT * aspect));
  const wall = rectify(img, corners, sw, STRUCTURE_SOURCE_HEIGHT);
  const ctx = wall.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('this browser can\'t read image pixels');
  const rgba = ctx.getImageData(0, 0, wall.width, wall.height).data;
  const [width, height] = reliefSize(aspect, STRUCTURE_RELIEF_WIDTH);
  const raw: RawRelief = { kind: 'structure', values: structureDepth(rgba, wall.width, wall.height, width, height), width, height };
  return { raw, dataUrl: reliefFromRaw(raw, aspect, opts.smoothing ?? 1) };
}

/**
 * Straightens one wall's photo, runs the depth model on it and returns its relief image.
 * `aspect` is the wall's width ÷ height in metres.
 */
export async function estimateRelief(
  src: string,
  corners: Corners,
  aspect: number,
  opts: { smoothing?: number; onProgress?: DepthProgress } = {},
): Promise<EstimatedRelief> {
  const estimator = await getDepthEstimator(opts.onProgress);
  const img = await loadImage(src);
  const wall = rectify(img, corners, Math.round(MODEL_SOURCE_HEIGHT * aspect), MODEL_SOURCE_HEIGHT);
  const raw: RawRelief = { kind: 'model', depth: await estimator.estimate(wall) };
  return { raw, dataUrl: reliefFromRaw(raw, aspect, opts.smoothing ?? 2) };
}

declare global {
  interface Window {
    /** Used by `npm run demo:depth` to compute the demo building's relief in a real browser. */
    abb360Depth?: { estimateRelief: typeof estimateRelief; structureRelief: typeof structureRelief };
  }
}
window.abb360Depth = { estimateRelief, structureRelief };
