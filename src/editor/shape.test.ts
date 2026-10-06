import { describe, expect, it } from 'vitest';
import { selfIntersects } from '../core/geometry2d';
import { parseConfig } from '../core/parse-config';
import type { BuildingConfig, Dimensions, Massing } from '../core/types';
import {
  SHAPE_TEMPLATES,
  addBlock,
  insertVertex,
  moveVertex,
  removeBlock,
  removeVertex,
  resize,
  setBlockHeight,
  setTemplate,
  shapeBlocks,
  snapPoint,
  templateBlocks,
} from './shape';

const dims: Dimensions = { width: 30, depth: 20, height: 40 };
const config = { dimensions: dims } as Pick<BuildingConfig, 'dimensions' | 'massing'>;
const square: Massing = { blocks: [{ polygon: [[0, 0], [30, 0], [30, 20], [0, 20]], height: 40 }] };

describe('shape templates', () => {
  it('fill the box, never cross themselves and parse cleanly', () => {
    for (const { id } of SHAPE_TEMPLATES) {
      const blocks = templateBlocks(id, dims);
      for (const b of blocks) {
        expect(selfIntersects(b.polygon)).toBe(false);
        const xs = b.polygon.map((p) => p[0]);
        const ds = b.polygon.map((p) => p[1]);
        expect([Math.min(...xs), Math.max(...xs), Math.min(...ds), Math.max(...ds)]).toEqual([0, 30, 0, 20]);
      }
      const { warnings } = parseConfig({ schemaVersion: 1, id: 'x', name: 'x', dimensions: dims, facades: {}, massing: { blocks } });
      expect(warnings.filter((w) => w.includes('massing'))).toEqual([]);
    }
  });

  it('rectangle removes the shape; the others set it', () => {
    const full = { ...config, schemaVersion: 1, id: 'b', name: 'b', facades: {}, apartments: [], regions: [] } as unknown as BuildingConfig;
    const l = setTemplate(full, 'l');
    expect(l.massing?.blocks[0]?.polygon).toHaveLength(6);
    expect('massing' in setTemplate(l, 'rectangle')).toBe(false);
  });

  it('shows the box when there is no shape', () => {
    expect(shapeBlocks(config)).toEqual(square.blocks);
  });
});

describe('editing a footprint', () => {
  it('moves a corner inside the box and refuses a move that would cross the outline', () => {
    const moved = moveVertex(square, 0, 2, [40, 25], dims);
    expect(moved?.blocks[0]?.polygon[2]).toEqual([30, 20]);
    const inward = moveVertex(square, 0, 2, [20, 12], dims);
    expect(inward?.blocks[0]?.polygon[2]).toEqual([20, 12]);
    // Dragging corner 1 past corner 3's side makes a bow tie.
    expect(moveVertex(square, 0, 1, [-1, 25], dims)).toBeNull();
  });

  it('adds a corner on an edge and removes corners down to three, but not below', () => {
    let m: Massing | null = insertVertex(square, 0, 0, [15, 0]);
    expect(m.blocks[0]?.polygon).toEqual([[0, 0], [15, 0], [30, 0], [30, 20], [0, 20]]);
    m = removeVertex(m, 0, 1);
    m = m && removeVertex(m, 0, 0);
    expect(m?.blocks[0]?.polygon).toHaveLength(3);
    expect(m && removeVertex(m, 0, 0)).toBeNull();
  });

  it('snaps to the grid, the box edges and square with the neighbours', () => {
    const poly = square.blocks[0]?.polygon ?? [];
    expect(snapPoint(poly, 2, [12.34, 7.86], dims, 0.4)).toEqual([12.3, 7.9]);
    expect(snapPoint(poly, 2, [29.8, 7.86], dims, 0.4)).toEqual([30, 7.9]);
    // In line with the next corner's d (20) and the previous corner's x (30).
    expect(snapPoint(poly, 2, [29.75, 19.7], dims, 0.4)).toEqual([30, 20]);
  });

  it('adds and removes blocks and caps their height at the building height', () => {
    const two = addBlock(config);
    expect(two.blocks).toHaveLength(2);
    expect(two.blocks[1]?.height).toBeCloseTo(13.33);
    expect(setBlockHeight(two, 1, 99, dims).blocks[1]?.height).toBe(40);
    expect(setBlockHeight(two, 1, 0, dims).blocks[1]?.height).toBe(1);
    const one = removeBlock(two, 1);
    expect(one?.blocks).toHaveLength(1);
    expect(one && removeBlock(one, 0)).toBeUndefined();
  });

  it('stretches the shape when the building is resized', () => {
    const l = { ...config, schemaVersion: 1, massing: { blocks: templateBlocks('l', dims) } } as unknown as BuildingConfig;
    const bigger = resize(l, { width: 60, depth: 10, height: 20 });
    expect(bigger.massing?.blocks[0]?.polygon).toEqual([[0, 0], [60, 0], [60, 5], [30, 5], [30, 10], [0, 10]]);
    expect(bigger.massing?.blocks[0]?.height).toBe(20);
    // A box stays a box.
    expect(resize({ dimensions: dims } as BuildingConfig, { width: 60, depth: 10, height: 20 }).massing).toBeUndefined();
  });
});
