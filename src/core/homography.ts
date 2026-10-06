import type { Corners, Vec2 } from './types';

/** Row-major 3×3 matrix taking homogeneous [u, v, 1] to [x, y, w]. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

const EPS = 1e-12;

/** z of (a − o) × (b − o). Positive for a clockwise turn in y-down image coordinates. */
function turn(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * True when tl → tr → br → bl is a strictly convex quad going clockwise on screen (y down).
 * The winding check rejects swapped corners, which would mirror the wall.
 */
export function isConvexQuad(c: Corners): boolean {
  const p = [c.tl, c.tr, c.br, c.bl];
  for (let i = 0; i < 4; i++) {
    const z = turn(p[i] as Vec2, p[(i + 1) % 4] as Vec2, p[(i + 2) % 4] as Vec2);
    if (!(z > EPS)) return false;
  }
  return true;
}

/**
 * The projective map from the unit square to the quad: (0,0) → tl, (1,0) → tr, (1,1) → br,
 * (0,1) → bl. Facade (u, v) in, normalised image (x, y) out. Null for a degenerate, non-convex
 * or mirrored quad. (Heckbert, "Fundamentals of Texture Mapping", 1989, §2.2.3.)
 */
export function squareToQuad(c: Corners): Mat3 | null {
  if (!isConvexQuad(c)) return null;
  const [x0, y0] = c.tl;
  const [x1, y1] = c.tr;
  const [x2, y2] = c.br;
  const [x3, y3] = c.bl;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let g = 0;
  let h = 0;
  if (Math.abs(sx) > EPS || Math.abs(sy) > EPS) {
    const dx1 = x1 - x2;
    const dx2 = x3 - x2;
    const dy1 = y1 - y2;
    const dy2 = y3 - y2;
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < EPS) return null;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function applyH(m: Mat3, u: number, v: number): Vec2 {
  const w = m[6] * u + m[7] * v + m[8];
  return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
}
