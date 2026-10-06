import { Vector3, type BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import type { ReliefPixels } from '../core/depth';
import { uvToWorld } from '../core/facade-frame';
import { blocksOf, wallsOf, type Wall } from '../core/massing';
import type { Corners, Dimensions, FacadeId, MassingBlock } from '../core/types';
import { createWall, pickProxy, type WallLook } from './wall-mesh';

const d: Dimensions = { width: 30, depth: 20, height: 40 };
const corners: Corners = { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] };
const box = blocksOf({ dimensions: d });
const boxWall = (f: FacadeId) => wallsOf(box).find((w) => w.facade === f) as Wall;
const look = (relief: WallLook['relief'] = null): WallLook => ({ map: null, corners, relief, tone: null });

/** Relief that is +1 (fully out) in the left half and −1 (fully in) in the right half. */
function halves(width = 64, height = 64): ReliefPixels {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = x < width / 2 ? 255 : 1;
  return { width, height, data };
}

const positions = (g: { getAttribute(name: string): unknown }) => g.getAttribute('position') as BufferAttribute;

describe('wall mesh', () => {
  it('lays a box wall exactly on its facade frame, coarse and flat without relief', () => {
    const wall = createWall(boxWall('front'), 0, d, box, look());
    const [gx, gy] = wall.geometry.userData.segments as [number, number];
    expect(gx).toBe(15);
    expect(gy).toBe(20);
    const pos = positions(wall.geometry);
    // First vertex is the top-left corner seen from outside, last the bottom-right.
    expect(new Vector3().fromBufferAttribute(pos, 0).toArray()).toEqual(uvToWorld('front', d, 0, 0));
    expect(new Vector3().fromBufferAttribute(pos, pos.count - 1).toArray()).toEqual(uvToWorld('front', d, 1, 1));
    for (let i = 0; i < pos.count; i++) expect(pos.getZ(i)).toBeCloseTo(10);
  });

  it('faces outward on every side', () => {
    for (const f of ['front', 'right', 'back', 'left'] as const) {
      const shape = boxWall(f);
      const wall = createWall(shape, 0, d, box, look());
      const n = wall.geometry.getAttribute('normal') as BufferAttribute;
      expect(n.getX(0)).toBeCloseTo(shape.normal[0]);
      expect(n.getZ(0)).toBeCloseTo(shape.normal[1]);
    }
  });

  it('pushes vertices out and in along the wall normal by the relief, and not at its edges', () => {
    const wall = createWall(boxWall('front'), 0, d, box, look({ pixels: halves(), depthM: 0.8 }));
    const g = wall.geometry;
    const [gx, gy] = g.userData.segments as [number, number];
    expect(gx).toBe(225);
    expect(gy).toBeGreaterThan(gx); // the wall is taller than wide
    const pos = positions(g);
    const row = Math.floor(gy / 2) * (gx + 1);
    expect(pos.getZ(row + Math.floor(gx * 0.2)) - 10).toBeCloseTo(0.8, 2);
    expect(pos.getZ(row + Math.floor(gx * 0.8)) - 10).toBeCloseTo(-0.8, 1);
    expect(pos.getZ(row) - 10).toBeCloseTo(0, 6); // left end
    expect(pos.getZ(row + gx) - 10).toBeCloseTo(0, 6); // right end
    // The same relief shades fine detail as a bump map read through the second UV channel.
    expect(wall.material.bumpMap?.channel).toBe(1);
    expect(g.getAttribute('uv1').count).toBe(pos.count);
  });

  it('carries facade uv for the overlay and a flat invisible proxy for picking', () => {
    const wall = createWall(boxWall('right'), 3, d, box, look({ pixels: halves(), depthM: 1 }));
    expect(wall.geometry.getAttribute('facadeUv').count).toBe(positions(wall.geometry).count);
    const proxy = pickProxy(wall);
    expect(proxy.userData.facade).toBe('right');
    expect(proxy.userData.wall).toBe(3);
    expect((proxy.material as { visible: boolean }).visible).toBe(false);
    expect(wall.castShadow && wall.receiveShadow).toBe(true);
  });

  it('marks the part of a wall hidden in its photo, so it gets a plain tone and no apartments', () => {
    const podiumTower: MassingBlock[] = [
      { polygon: [[0, 0], [30, 0], [30, 20], [0, 20]], height: 10 },
      { polygon: [[8, 6], [22, 6], [22, 16], [8, 16]], height: 40 },
    ];
    const blocks = blocksOf({ dimensions: d, massing: { blocks: podiumTower } });
    const towerFront = wallsOf(blocks).find((w) => w.block === 1 && w.facade === 'front') as Wall;
    const wall = createWall(towerFront, 0, d, blocks, look());
    const mix = wall.geometry.getAttribute('photoMix') as BufferAttribute;
    const pos = positions(wall.geometry);
    for (let i = 0; i < mix.count; i++) expect(mix.getX(i)).toBe(pos.getY(i) > 10 + 1e-3 ? 1 : 0);
  });
});
