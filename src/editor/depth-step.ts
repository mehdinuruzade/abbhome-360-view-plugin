import { depthToRelief, type DepthMap, type ReliefPixels } from '../core/depth';
import type { Corners } from '../core/types';
import { getDepthEstimator, type DepthProgress } from './depth-model';
import { loadImage, rectify } from './rectify';

/** Relief maps are stored small: depth from one photo has no fine detail worth more. */
export const RELIEF_WIDTH = 256;
/** Height of the straightened wall image the model sees. */
const MODEL_SOURCE_HEIGHT = 700;

export function reliefSize(aspect: number): [number, number] {
  return [RELIEF_WIDTH, Math.max(32, Math.min(1024, Math.round(RELIEF_WIDTH / aspect)))];
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

export interface EstimatedRelief {
  /** The model's output, kept in memory so smoothing can be redone without rerunning it. */
  raw: DepthMap;
  dataUrl: string;
}

/** Turns stored model output into a relief image with the given smoothing. */
export function reliefFromRaw(raw: DepthMap, aspect: number, smoothing: number): string {
  const [w, h] = reliefSize(aspect);
  return reliefToDataUrl(depthToRelief(raw, w, h, { smoothing }));
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
  const raw = await estimator.estimate(wall);
  return { raw, dataUrl: reliefFromRaw(raw, aspect, opts.smoothing ?? 2) };
}

declare global {
  interface Window {
    /** Used by `npm run demo:depth` to compute the demo building's relief in a real browser. */
    abb360Depth?: { estimateRelief: typeof estimateRelief };
  }
}
window.abb360Depth = { estimateRelief };
