import type { Vec2 } from './types';

/** Even-odd rule. Points exactly on an edge may land either way. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as Vec2;
    const [xj, yj] = poly[j] as Vec2;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Signed shoelace area. */
export function polygonArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as Vec2;
    const [xj, yj] = poly[j] as Vec2;
    a += xj * yi - xi * yj;
  }
  return a / 2;
}

/** Area-weighted centroid; the vertex mean for degenerate (zero-area) polygons. */
export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  const area = polygonArea(poly);
  if (Math.abs(area) < 1e-12) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as Vec2;
    const [xj, yj] = poly[j] as Vec2;
    const f = xj * yi - xi * yj;
    cx += (xi + xj) * f;
    cy += (yi + yj) * f;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

export function rectPolygon(u0: number, v0: number, u1: number, v1: number): Vec2[] {
  return [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
}

/** Sorts intervals and merges the ones that overlap or touch. */
export function mergeIntervals(intervals: readonly Vec2[], eps = 1e-9): Vec2[] {
  const sorted = intervals
    .map(([a, b]): Vec2 => (a <= b ? [a, b] : [b, a]))
    .sort((x, y) => x[0] - y[0]);
  const out: Vec2[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + eps) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}
