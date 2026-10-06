import { polygonArea, selfIntersects } from '../core/geometry2d';
import type { BuildingConfig, Dimensions, Massing, MassingBlock, Vec2 } from '../core/types';

/**
 * The editor's shape model, as pure functions: templates, editing a block's footprint, and
 * keeping the shape in step with the building's size. Plan coordinates in metres (x left → right
 * seen from the front, d back from the front edge), inside dimensions.width × depth.
 */

export type ShapeTemplate = 'rectangle' | 'l' | 'u' | 't' | 'notched';

export const SHAPE_TEMPLATES: { id: ShapeTemplate; label: string }[] = [
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'l', label: 'L' },
  { id: 'u', label: 'U' },
  { id: 't', label: 'T' },
  { id: 'notched', label: 'Notched' },
];

/** Grid the editor snaps to, metres. */
export const SNAP_M = 0.1;
/** Smallest block height, metres. */
const MIN_BLOCK_HEIGHT = 1;

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The blocks as the editor shows them: the declared shape, or the box. */
export function shapeBlocks(config: Pick<BuildingConfig, 'dimensions' | 'massing'>): MassingBlock[] {
  const { width: w, depth: d, height: h } = config.dimensions;
  return config.massing?.blocks.length ? config.massing.blocks : [{ polygon: [[0, 0], [w, 0], [w, d], [0, d]], height: h }];
}

/** A template footprint filling the building's bounding box. */
export function templateBlocks(kind: ShapeTemplate, dims: Dimensions): MassingBlock[] {
  const { width: W, depth: D, height } = dims;
  const x = (f: number) => r2(f * W);
  const z = (f: number) => r2(f * D);
  let polygon: Vec2[];
  switch (kind) {
    case 'rectangle':
      polygon = [[0, 0], [W, 0], [W, D], [0, D]];
      break;
    case 'l': // the back-right quarter missing
      polygon = [[0, 0], [W, 0], [W, z(0.5)], [x(0.5), z(0.5)], [x(0.5), D], [0, D]];
      break;
    case 'u': // a courtyard open to the back
      polygon = [[0, 0], [W, 0], [W, D], [x(0.65), D], [x(0.65), z(0.45)], [x(0.35), z(0.45)], [x(0.35), D], [0, D]];
      break;
    case 't': // a full-width front wing and a stem to the back
      polygon = [[0, 0], [W, 0], [W, z(0.4)], [x(0.7), z(0.4)], [x(0.7), D], [x(0.3), D], [x(0.3), z(0.4)], [0, z(0.4)]];
      break;
    case 'notched': {
      // A narrow full-height slot in the middle of each side.
      const t = r2(Math.min(1.5, 0.1 * Math.min(W, D)));
      const [a, b] = [x(0.46), x(0.54)];
      const [c, e] = [z(0.46), z(0.54)];
      polygon = [
        [0, 0], [a, 0], [a, t], [b, t], [b, 0], [W, 0],
        [W, c], [r2(W - t), c], [r2(W - t), e], [W, e],
        [W, D], [b, D], [b, r2(D - t)], [a, r2(D - t)], [a, D], [0, D],
        [0, e], [t, e], [t, c], [0, c],
      ];
      break;
    }
  }
  return [{ polygon, height }];
}

/** Applies a template; the rectangle removes the shape (the plain box, which every widget shows). */
export function setTemplate<T extends BuildingConfig>(config: T, kind: ShapeTemplate): T {
  if (kind === 'rectangle') {
    const { massing: _drop, ...rest } = config;
    return rest as T;
  }
  return { ...config, massing: { ...config.massing, blocks: templateBlocks(kind, config.dimensions) } };
}

/** Stretches the shape with the building when its size changes (heights proportionally too). */
export function scaleMassing(massing: Massing | undefined, from: Dimensions, to: Dimensions): Massing | undefined {
  if (!massing) return massing;
  const sx = to.width / from.width;
  const sd = to.depth / from.depth;
  const sh = to.height / from.height;
  return {
    ...massing,
    blocks: massing.blocks.map((b) => ({
      ...b,
      polygon: b.polygon.map(([x, d]): Vec2 => [r2(x * sx), r2(d * sd)]),
      height: r2(b.height * sh),
    })),
  };
}

/** A new size for the building, with its shape stretched to match. */
export function resize<T extends BuildingConfig>(config: T, dimensions: Dimensions): T {
  const massing = scaleMassing(config.massing, config.dimensions, dimensions);
  return massing ? { ...config, dimensions, massing } : { ...config, dimensions };
}

/**
 * Snaps a dragged point: to the 10 cm grid, onto the box edges, and into line with its two
 * neighbours (so walls stay square) when it is within `tolerance` metres of that.
 */
export function snapPoint(poly: readonly Vec2[], index: number, p: Vec2, dims: Dimensions, tolerance: number): Vec2 {
  const n = poly.length;
  const prev = poly[(index - 1 + n) % n] as Vec2;
  const next = poly[(index + 1) % n] as Vec2;
  const snapAxis = (v: number, axis: 0 | 1, max: number) => {
    const candidates = [0, max, prev[axis], next[axis]];
    let best = v;
    let bestDist = tolerance;
    for (const c of candidates) {
      const dist = Math.abs(v - c);
      if (dist <= bestDist) {
        best = c;
        bestDist = dist;
      }
    }
    return best === v ? Math.round(v / SNAP_M) * SNAP_M : best;
  };
  return [r2(clamp(snapAxis(p[0], 0, dims.width), 0, dims.width)), r2(clamp(snapAxis(p[1], 1, dims.depth), 0, dims.depth))];
}

function valid(polygon: readonly Vec2[]): boolean {
  return polygon.length >= 3 && !selfIntersects(polygon) && Math.abs(polygonArea(polygon)) > 1e-3;
}

function withBlock(massing: Massing, index: number, block: MassingBlock): Massing {
  return { ...massing, blocks: massing.blocks.map((b, i) => (i === index ? block : b)) };
}

/** Moves one corner (kept inside the box). Null when the footprint would cross itself. */
export function moveVertex(massing: Massing, block: number, index: number, p: Vec2, dims: Dimensions): Massing | null {
  const b = massing.blocks[block];
  if (!b || !b.polygon[index]) return null;
  const point: Vec2 = [r2(clamp(p[0], 0, dims.width)), r2(clamp(p[1], 0, dims.depth))];
  const polygon = b.polygon.map((q, i) => (i === index ? point : q));
  return valid(polygon) ? withBlock(massing, block, { ...b, polygon }) : null;
}

/** Adds a corner on edge `edge` (from point `edge` to the next), at `p`. */
export function insertVertex(massing: Massing, block: number, edge: number, p: Vec2): Massing {
  const b = massing.blocks[block];
  if (!b) return massing;
  const polygon = [...b.polygon];
  polygon.splice(edge + 1, 0, [r2(p[0]), r2(p[1])]);
  return withBlock(massing, block, { ...b, polygon });
}

/** Removes a corner. Null when fewer than three would be left or the footprint would cross itself. */
export function removeVertex(massing: Massing, block: number, index: number): Massing | null {
  const b = massing.blocks[block];
  if (!b || b.polygon.length <= 3) return null;
  const polygon = b.polygon.filter((_, i) => i !== index);
  return valid(polygon) ? withBlock(massing, block, { ...b, polygon }) : null;
}

export function setBlockHeight(massing: Massing, block: number, height: number, dims: Dimensions): Massing {
  const b = massing.blocks[block];
  if (!b || !Number.isFinite(height)) return massing;
  return withBlock(massing, block, { ...b, height: r2(clamp(height, MIN_BLOCK_HEIGHT, dims.height)) });
}

/**
 * Adds a block in the middle, a third of the building's height (a podium's tower or a lower
 * wing: move its corners and set its height).
 */
export function addBlock(config: Pick<BuildingConfig, 'dimensions' | 'massing'>): Massing {
  const { width: W, depth: D, height: H } = config.dimensions;
  const blocks = shapeBlocks(config);
  const block: MassingBlock = {
    polygon: [[r2(W * 0.3), r2(D * 0.3)], [r2(W * 0.7), r2(D * 0.3)], [r2(W * 0.7), r2(D * 0.7)], [r2(W * 0.3), r2(D * 0.7)]],
    height: r2(Math.max(MIN_BLOCK_HEIGHT, H / 3)),
  };
  return { ...config.massing, blocks: [...blocks, block] };
}

/** Removes a block; with none left the building is the box again (undefined). */
export function removeBlock(massing: Massing, block: number): Massing | undefined {
  const blocks = massing.blocks.filter((_, i) => i !== block);
  return blocks.length ? { ...massing, blocks } : undefined;
}
