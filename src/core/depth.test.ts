import { describe, expect, it } from 'vitest';
import { depthToRelief, dptInputSize, fitPlane, quantile, reliefAt, rgbaToDptTensor, type DepthMap } from './depth';

function map(width: number, height: number, f: (u: number, v: number) => number): DepthMap {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f((x + 0.5) / width, (y + 0.5) / height);
  return { width, height, data };
}

describe('depth to relief', () => {
  it('fits and removes a tilted plane, leaving a flat wall at 128', () => {
    const tilted = map(40, 60, (u, v) => 3 + 2 * u - 5 * v);
    const [a, b, c] = fitPlane(tilted.data, 40, 60);
    expect(a).toBeCloseTo(3, 4);
    expect(b).toBeCloseTo(2, 4);
    expect(c).toBeCloseTo(-5, 4);
    const r = depthToRelief(tilted, 20, 30, { smoothing: 0 });
    expect(Math.max(...r.data) - Math.min(...r.data)).toBeLessThanOrEqual(1);
    expect(r.data[15 * 20 + 10]).toBe(128);
  });

  it('pushes closer areas out and farther areas in, around the median plane', () => {
    // A protruding band (closer = larger) and a recessed band on an otherwise flat wall.
    const wall = map(100, 100, (u) => (u > 0.2 && u < 0.3 ? 1 : u > 0.6 && u < 0.7 ? -1 : 0));
    const r = depthToRelief(wall, 100, 100, { smoothing: 0, edgeFade: 0, clip: 0 });
    expect(reliefAt(r, 0.25, 0.5)).toBeGreaterThan(0.9);
    expect(reliefAt(r, 0.65, 0.5)).toBeLessThan(-0.9);
    expect(reliefAt(r, 0.45, 0.5)).toBeCloseTo(0, 1);
  });

  it('ignores clipped outliers when scaling (e.g. sky reflected in glass)', () => {
    const wall = map(100, 100, (u, v) => (u < 0.02 && v < 0.02 ? -1000 : u > 0.4 && u < 0.6 ? 1 : 0));
    const r = depthToRelief(wall, 100, 100, { smoothing: 0, edgeFade: 0, clip: 0.01 });
    expect(reliefAt(r, 0.5, 0.5)).toBeGreaterThan(0.9);
  });

  it('fades the relief to the wall plane at every edge so corners stay closed', () => {
    const wall = map(50, 50, (u) => (u < 0.5 ? 1 : -1));
    const r = depthToRelief(wall, 50, 50, { smoothing: 0, edgeFade: 0.1 });
    for (const [x, y] of [[0, 25], [49, 25], [25, 0], [25, 49]] as const) {
      expect(Math.abs((r.data[y * 50 + x] ?? 0) - 128)).toBeLessThanOrEqual(3);
    }
  });

  it('removes speckle with the median filter', () => {
    const wall = map(60, 60, (u, v) => (Math.abs(u - 0.5) < 0.01 && Math.abs(v - 0.5) < 0.01 ? 50 : (u > 0.7 ? 1 : 0)));
    const r = depthToRelief(wall, 60, 60, { smoothing: 2, edgeFade: 0, clip: 0 });
    expect(reliefAt(r, 0.5, 0.5)).toBeCloseTo(reliefAt(r, 0.4, 0.4), 1);
  });

  it('computes quantiles', () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([5, 1, 3, 2, 4], 0)).toBe(1);
  });
});

describe('Depth Anything preprocessing', () => {
  it('resizes like DPT: least scaling, aspect kept, multiples of 14', () => {
    expect(dptInputSize(700, 1000)).toEqual([518, 742]);
    expect(dptInputSize(518, 518)).toEqual([518, 518]);
    const [w, h] = dptInputSize(1600, 900);
    expect(w % 14).toBe(0);
    expect(h % 14).toBe(0);
    expect(h).toBe(518);
  });

  it('normalises RGBA into planar ImageNet-normalised floats', () => {
    const rgba = new Uint8ClampedArray([255, 0, 128, 255, 0, 255, 0, 255]);
    const t = rgbaToDptTensor(rgba, 2, 1);
    expect(t).toHaveLength(6);
    expect(t[0]).toBeCloseTo((1 - 0.485) / 0.229, 5); // R of pixel 0
    expect(t[2 + 1]).toBeCloseTo((1 - 0.456) / 0.224, 5); // G of pixel 1
    expect(t[4]).toBeCloseTo((128 / 255 - 0.406) / 0.225, 5); // B of pixel 0
  });
});
