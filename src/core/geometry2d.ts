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

/** Proper crossing of segments p1–p2 and q1–q2 (touching at an end doesn't count). */
export function segmentsCross(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const orient = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

/** True when two non-neighbouring edges of the closed polygon cross. */
export function selfIntersects(poly: readonly Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours through the closing edge
      if (segmentsCross(poly[i] as Vec2, poly[(i + 1) % n] as Vec2, poly[j] as Vec2, poly[(j + 1) % n] as Vec2)) return true;
    }
  }
  return false;
}
