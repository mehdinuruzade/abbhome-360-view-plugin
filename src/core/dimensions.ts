import type { Corners, Dimensions, FacadeId, Vec2 } from './types';

export interface ImageSize {
  width: number;
  height: number;
}

/** How far front vs back (or left vs right) may disagree before the editor warns. */
export const MISMATCH_LIMIT = 0.05;

export interface DimensionWarning {
  code: 'width-mismatch' | 'depth-mismatch';
  /** Relative difference, e.g. 0.07 = 7 %. */
  difference: number;
}

/** Pixel width ÷ pixel height of a wall quad, averaging opposite edges. */
export function quadAspect(c: Corners, img: ImageSize): number {
  const px = (p: Vec2): Vec2 => [p[0] * img.width, p[1] * img.height];
  const len = (a: Vec2, b: Vec2) => Math.hypot(px(b)[0] - px(a)[0], px(b)[1] - px(a)[1]);
  const horizontal = len(c.tl, c.tr) + len(c.bl, c.br);
  const vertical = len(c.tl, c.bl) + len(c.tr, c.br);
  return horizontal / vertical;
}

function relativeDifference(a: number, b: number): number {
  return Math.abs(a - b) / ((a + b) / 2);
}

/**
 * Width and depth from the building's height and each wall's aspect ratio. Opposite walls
 * should agree; a large difference usually means a corner was placed wrongly.
 */
export function deriveDimensions(
  height: number,
  aspects: Readonly<Record<FacadeId, number>>,
): { dimensions: Dimensions; warnings: DimensionWarning[] } {
  const warnings: DimensionWarning[] = [];
  const widthDiff = relativeDifference(aspects.front, aspects.back);
  const depthDiff = relativeDifference(aspects.right, aspects.left);
  if (widthDiff > MISMATCH_LIMIT) warnings.push({ code: 'width-mismatch', difference: widthDiff });
  if (depthDiff > MISMATCH_LIMIT) warnings.push({ code: 'depth-mismatch', difference: depthDiff });
  return {
    dimensions: {
      width: (height * (aspects.front + aspects.back)) / 2,
      depth: (height * (aspects.right + aspects.left)) / 2,
      height,
    },
    warnings,
  };
}
