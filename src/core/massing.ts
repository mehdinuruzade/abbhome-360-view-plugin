import { polygonArea } from './geometry2d';
import { FACADES, type BuildingConfig, type Dimensions, type FacadeId, type MassingBlock, type Vec2, type Vec3 } from './types';

/**
 * The building's 3D shape: blocks (footprint polygons rising from the ground) and the walls along
 * their edges. Photos, regions, the floor/column grid and relief maps all stay in facade space,
 * the (u, v) of each straight-on elevation; a wall shows the elevation it faces, projected
 * straight onto it. A box is simply one rectangular block.
 *
 * Positions here are world X and Z (see facade-frame.ts: origin at the centre of the bounding
 * box, front at +Z, right at +X), written as Vec2 [X, Z].
 */

export interface Block {
  /** World [X, Z], counter-clockwise in X-Z (positive shoelace area), no repeated points. */
  points: Vec2[];
  height: number;
}

export interface Wall {
  /** Left end as seen from outside. */
  a: Vec2;
  /** Right end as seen from outside. */
  b: Vec2;
  /** Outward unit normal [X, Z]. */
  normal: Vec2;
  length: number;
  height: number;
  /** The elevation this wall shows. */
  facade: FacadeId;
  block: number;
}

/** Each elevation's viewing direction (towards the viewer), [X, Z]. */
export const FACADE_DIRECTION: Readonly<Record<FacadeId, Vec2>> = {
  front: [0, 1],
  right: [1, 0],
  back: [0, -1],
  left: [-1, 0],
};

const EPS = 1e-6;

/** Plan [x, d] (metres from the front-left corner of the bounding box) → world [X, Z]. */
export function planToWorld(p: Vec2, d: Dimensions): Vec2 {
  return [p[0] - d.width / 2, d.depth / 2 - p[1]];
}

export function worldToPlan(p: Vec2, d: Dimensions): Vec2 {
  return [p[0] + d.width / 2, d.depth / 2 - p[1]];
}

/** Drops repeated points (including a closing copy of the first) and makes the winding CCW. */
export function normalizeRing(points: readonly Vec2[]): Vec2[] {
  const ring: Vec2[] = [];
  for (const p of points) {
    const last = ring[ring.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > EPS) ring.push([p[0], p[1]]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) <= EPS) ring.pop();
  return polygonArea(ring) < 0 ? ring.reverse() : ring;
}

/** The blocks of a config: its massing in world coordinates, or the box from `dimensions`. */
export function blocksOf(config: Pick<BuildingConfig, 'dimensions' | 'massing'>): Block[] {
  const d = config.dimensions;
  const declared = (config.massing?.blocks ?? [])
    .map((b: MassingBlock) => ({ points: normalizeRing(b.polygon.map((p) => planToWorld(p, d))), height: b.height }))
    .filter((b) => b.points.length >= 3 && b.height > 0);
  if (declared.length) return declared;
  const w = d.width / 2;
  const z = d.depth / 2;
  return [{ points: normalizeRing([[-w, -z], [w, -z], [w, z], [-w, z]]), height: d.height }];
}

/** The elevation whose viewing direction is closest to the outward normal. */
export function facingOf(normal: Vec2): FacadeId {
  let best: FacadeId = 'front';
  let bestDot = -Infinity;
  for (const f of FACADES) {
    const [dx, dz] = FACADE_DIRECTION[f];
    const dot = normal[0] * dx + normal[1] * dz;
    if (dot > bestDot + 1e-9) {
      best = f;
      bestDot = dot;
    }
  }
  return best;
}

/** One wall per block edge, outward-facing. */
export function wallsOf(blocks: readonly Block[]): Wall[] {
  const walls: Wall[] = [];
  blocks.forEach((block, bi) => {
    const pts = block.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as Vec2;
      const q = pts[(i + 1) % pts.length] as Vec2;
      const ex = q[0] - p[0];
      const ez = q[1] - p[1];
      const length = Math.hypot(ex, ez);
      if (length < EPS) continue;
      // Counter-clockwise in X-Z: the outside is on the right of p → q, so p → q runs right to
      // left as seen from outside.
      const normal: Vec2 = [ez / length, -ex / length];
      walls.push({ a: q, b: p, normal, length, height: block.height, facade: facingOf(normal), block: bi });
    }
  });
  return walls;
}

/** Facade u of a world point on elevation `f` (0 at its left edge, 1 at its right, seen from outside). */
export function elevationU(f: FacadeId, x: number, z: number, d: Dimensions): number {
  switch (f) {
    case 'front':
      return (x + d.width / 2) / d.width;
    case 'right':
      return (d.depth / 2 - z) / d.depth;
    case 'back':
      return (d.width / 2 - x) / d.width;
    case 'left':
      return (z + d.depth / 2) / d.depth;
  }
}

/** Facade (u, v) of a world point, projected straight onto elevation `f`. */
export function elevationUv(f: FacadeId, p: Vec3, d: Dimensions): Vec2 {
  return [elevationU(f, p[0], p[2], d), 1 - p[1] / d.height];
}

/** Where a ray from `o` along `dir` first crosses segment p–q (distance along the ray), or null. */
function raySegment(o: Vec2, dir: Vec2, p: Vec2, q: Vec2): number | null {
  const sx = q[0] - p[0];
  const sz = q[1] - p[1];
  const denom = dir[0] * sz - dir[1] * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel: grazing a wall isn't hitting it
  const ox = p[0] - o[0];
  const oz = p[1] - o[1];
  const t = (ox * sz - oz * sx) / denom;
  const s = (ox * dir[1] - oz * dir[0]) / denom;
  return t > 1e-4 && s >= -1e-9 && s <= 1 + 1e-9 ? t : null;
}

/**
 * The tallest block standing between a ground point and the viewer of elevation `f`: anything on
 * a wall below this height is hidden in that photo. 0 when nothing is in front.
 */
export function occluderHeight(f: FacadeId, point: Vec2, blocks: readonly Block[]): number {
  const dir = FACADE_DIRECTION[f];
  // Start just outside the surface so the wall's own edge doesn't count.
  const o: Vec2 = [point[0] + dir[0] * 1e-3, point[1] + dir[1] * 1e-3];
  let tallest = 0;
  for (const block of blocks) {
    if (block.height <= tallest) continue;
    const pts = block.points;
    for (let i = 0; i < pts.length; i++) {
      if (raySegment(o, dir, pts[i] as Vec2, pts[(i + 1) % pts.length] as Vec2) !== null) {
        tallest = block.height;
        break;
      }
    }
  }
  return tallest;
}

/** A point on a wall: t runs from its left end (0) to its right end (1). */
export function wallPoint(w: Wall, t: number): Vec2 {
  return [w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t];
}

export interface FacadePoint {
  point: Vec3;
  normal: Vec3;
  wall: number;
}

/**
 * Where facade (u, v) of elevation `f` is on the building: the frontmost wall facing that way
 * that covers it and is visible in the photo there. Null where the elevation shows no wall
 * (sky beside a setback, say).
 */
export function facadeToWorld(f: FacadeId, u: number, v: number, walls: readonly Wall[], blocks: readonly Block[], d: Dimensions): FacadePoint | null {
  const y = (1 - v) * d.height;
  const dir = FACADE_DIRECTION[f];
  let best: FacadePoint | null = null;
  let bestDepth = -Infinity;
  walls.forEach((w, i) => {
    if (w.facade !== f || y > w.height + 1e-6) return;
    const ua = elevationU(f, w.a[0], w.a[1], d);
    const ub = elevationU(f, w.b[0], w.b[1], d);
    if (Math.abs(ub - ua) < 1e-9) return;
    const t = (u - ua) / (ub - ua);
    if (t < -1e-6 || t > 1 + 1e-6) return;
    const p = wallPoint(w, Math.min(1, Math.max(0, t)));
    if (occluderHeight(f, p, blocks) > y + 1e-6) return;
    const depth = p[0] * dir[0] + p[1] * dir[1];
    if (depth > bestDepth) {
      bestDepth = depth;
      best = { point: [p[0], y, p[1]], normal: [w.normal[0], 0, w.normal[1]], wall: i };
    }
  });
  return best;
}
