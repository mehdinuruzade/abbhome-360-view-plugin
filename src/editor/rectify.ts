import { applyH, squareToQuad } from '../core/homography';
import type { Corners } from '../core/types';

/** The quad is an axis-aligned rectangle, so a plain crop-and-scale is exact. */
export function isAxisAligned(c: Corners, eps = 1e-6): boolean {
  return (
    Math.abs(c.tl[1] - c.tr[1]) < eps &&
    Math.abs(c.bl[1] - c.br[1]) < eps &&
    Math.abs(c.tl[0] - c.bl[0]) < eps &&
    Math.abs(c.tr[0] - c.br[0]) < eps
  );
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`couldn't load ${src}`));
    img.src = src;
  });
}

/**
 * Draws the wall straight-on into a canvas of `width × height` pixels. Straight-on photos are a
 * crop; anything keystoned is resampled through the corner homography.
 */
export function rectify(img: HTMLImageElement, corners: Corners, width: number, height: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(width));
  out.height = Math.max(1, Math.round(height));
  const ctx = out.getContext('2d');
  const h = squareToQuad(corners);
  if (!ctx || !h) return out;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (isAxisAligned(corners)) {
    ctx.drawImage(
      img,
      corners.tl[0] * iw,
      corners.tl[1] * ih,
      (corners.tr[0] - corners.tl[0]) * iw,
      (corners.bl[1] - corners.tl[1]) * ih,
      0,
      0,
      out.width,
      out.height,
    );
    return out;
  }
  const src = document.createElement('canvas');
  src.width = iw;
  src.height = ih;
  const sctx = src.getContext('2d');
  if (!sctx) return out;
  sctx.drawImage(img, 0, 0);
  const pixels = sctx.getImageData(0, 0, iw, ih).data;
  const target = ctx.createImageData(out.width, out.height);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const [sx, sy] = applyH(h, (x + 0.5) / out.width, (y + 0.5) / out.height);
      const px = Math.min(iw - 1, Math.max(0, Math.floor(sx * iw)));
      const py = Math.min(ih - 1, Math.max(0, Math.floor(sy * ih)));
      const si = (py * iw + px) * 4;
      const ti = (y * out.width + x) * 4;
      target.data[ti] = pixels[si] ?? 0;
      target.data[ti + 1] = pixels[si + 1] ?? 0;
      target.data[ti + 2] = pixels[si + 2] ?? 0;
      target.data[ti + 3] = 255;
    }
  }
  ctx.putImageData(target, 0, 0);
  return out;
}
