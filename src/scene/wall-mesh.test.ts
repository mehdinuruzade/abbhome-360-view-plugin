import type { BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import type { ReliefPixels } from '../core/depth';
import type { Corners, Dimensions } from '../core/types';
import { createWall, pickProxy } from './wall-mesh';

const d: Dimensions = { width: 30, depth: 20, height: 40 };
const corners: Corners = { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] };

/** Relief that is +1 (fully out) in the left half and −1 (fully in) in the right half. */
function halves(width = 64, height = 64): ReliefPixels {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = x < width / 2 ? 255 : 1;
  return { width, height, data };
}

describe('wall mesh', () => {
  it('stays flat and coarse without relief', () => {
    const wall = createWall('front', d, corners, null);
    expect(wall.geometry.parameters.widthSegments).toBe(16);
    const z = wall.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < z.count; i++) expect(z.getZ(i)).toBe(0);
  });

  it('pushes vertices out and in along the wall normal by the relief', () => {
    const wall = createWall('front', d, corners, null, { pixels: halves(), depthM: 0.8 });
    const g = wall.geometry;
    const { widthSegments: gx, heightSegments: gy } = g.parameters;
    expect(gx).toBe(128);
    expect(gy).toBeGreaterThan(gx); // the wall is taller than wide
    const pos = g.getAttribute('position') as BufferAttribute;
    const row = Math.floor(gy / 2) * (gx + 1);
    expect(pos.getZ(row + Math.floor(gx * 0.2))).toBeCloseTo(0.8, 2);
    expect(pos.getZ(row + Math.floor(gx * 0.8))).toBeCloseTo(-0.8, 1);
  });

  it('carries facade uv for the overlay and a flat invisible proxy for picking', () => {
    const wall = createWall('right', d, corners, null, { pixels: halves(), depthM: 1 });
    expect(wall.geometry.getAttribute('facadeUv').count).toBe(wall.geometry.getAttribute('position').count);
    const proxy = pickProxy(wall);
    expect(proxy.userData.facade).toBe('right');
    expect((proxy.material as { visible: boolean }).visible).toBe(false);
    expect(wall.castShadow && wall.receiveShadow).toBe(true);
  });
});
