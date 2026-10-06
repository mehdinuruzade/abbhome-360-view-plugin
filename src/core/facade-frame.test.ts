import { describe, expect, it } from 'vitest';
import {
  facadeFrame,
  imageToTextureUv,
  localToUv,
  NEXT,
  uvToLocal,
  uvToWorld,
} from './facade-frame';
import { FACADES, type Dimensions, type Vec3 } from './types';

const d: Dimensions = { width: 30, depth: 20, height: 40 };

function close3(a: Vec3, b: Vec3) {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i] as number, 9);
}

describe('facade frames', () => {
  it('puts the front wall facing +Z with u=0 at x = −width/2', () => {
    close3(uvToWorld('front', d, 0, 1), [-15, 0, 10]);
    close3(uvToWorld('front', d, 1, 0), [15, 40, 10]);
    expect(facadeFrame('front', d).normal).toEqual([0, 0, 1]);
  });

  it('gives each wall an outward normal and the expected u direction', () => {
    expect(facadeFrame('right', d).normal).toEqual([1, 0, 0]);
    expect(facadeFrame('back', d).normal).toEqual([0, 0, -1]);
    expect(facadeFrame('left', d).normal).toEqual([-1, 0, 0]);
    // u runs along −Z on the right wall, −X on the back, +Z on the left.
    expect(uvToWorld('right', d, 1, 0)[2]).toBeLessThan(uvToWorld('right', d, 0, 0)[2]);
    expect(uvToWorld('back', d, 1, 0)[0]).toBeLessThan(uvToWorld('back', d, 0, 0)[0]);
    expect(uvToWorld('left', d, 1, 0)[2]).toBeGreaterThan(uvToWorld('left', d, 0, 0)[2]);
  });

  it("joins each wall's right edge to the next wall's left edge (no mirroring)", () => {
    for (const f of FACADES) {
      close3(uvToWorld(f, d, 1, 1), uvToWorld(NEXT[f], d, 0, 1));
      close3(uvToWorld(f, d, 1, 0), uvToWorld(NEXT[f], d, 0, 0));
    }
  });

  it('visits all four walls going round once', () => {
    let f = NEXT.front;
    const seen = ['front'];
    while (f !== 'front') {
      seen.push(f);
      f = NEXT[f];
    }
    expect(seen).toEqual(['front', 'right', 'back', 'left']);
  });

  it('moves points out along the normal with an offset', () => {
    for (const f of FACADES) {
      const base = uvToWorld(f, d, 0.5, 0.5);
      const out = uvToWorld(f, d, 0.5, 0.5, 2);
      const n = facadeFrame(f, d).normal;
      close3([out[0] - base[0], out[1] - base[1], out[2] - base[2]], [n[0] * 2, 0, n[2] * 2]);
    }
  });

  it('round-trips between facade uv and wall-local coordinates', () => {
    const [x, y] = uvToLocal('right', d, 0.3, 0.7);
    expect(x).toBeCloseTo(-4, 9);
    expect(y).toBeCloseTo(-8, 9);
    const [u, v] = localToUv('right', d, x, y);
    expect(u).toBeCloseTo(0.3, 9);
    expect(v).toBeCloseTo(0.7, 9);
  });

  it('flips only the image y axis when converting to texture UVs', () => {
    expect(imageToTextureUv([0.25, 0.1])).toEqual([0.25, 0.9]);
  });
});
