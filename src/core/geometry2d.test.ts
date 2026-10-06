import { describe, expect, it } from 'vitest';
import {
  mergeIntervals,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  rectPolygon,
} from './geometry2d';
import type { Vec2 } from './types';

describe('2D geometry', () => {
  const square = rectPolygon(0.2, 0.2, 0.6, 0.6);
  const lShape: Vec2[] = [
    [0, 0],
    [2, 0],
    [2, 1],
    [1, 1],
    [1, 2],
    [0, 2],
  ];

  it('tests points against convex and concave polygons', () => {
    expect(pointInPolygon([0.4, 0.4], square)).toBe(true);
    expect(pointInPolygon([0.7, 0.4], square)).toBe(false);
    expect(pointInPolygon([0.5, 1.5], lShape)).toBe(true);
    expect(pointInPolygon([1.5, 1.5], lShape)).toBe(false);
  });

  it('computes area and the area-weighted centroid', () => {
    expect(Math.abs(polygonArea(square))).toBeCloseTo(0.16, 12);
    const [cx, cy] = polygonCentroid(square);
    expect(cx).toBeCloseTo(0.4, 12);
    expect(cy).toBeCloseTo(0.4, 12);
    const [lx, ly] = polygonCentroid(lShape);
    expect(lx).toBeCloseTo(5 / 6, 12);
    expect(ly).toBeCloseTo(5 / 6, 12);
  });

  it('falls back to the vertex mean for a zero-area polygon', () => {
    expect(
      polygonCentroid([
        [0, 0],
        [1, 0],
        [2, 0],
      ]),
    ).toEqual([1, 0]);
  });

  it('merges touching and overlapping intervals', () => {
    expect(
      mergeIntervals([
        [0.5, 0.7],
        [0, 0.25],
        [0.25, 0.4],
        [0.65, 0.9],
      ]),
    ).toEqual([
      [0, 0.4],
      [0.5, 0.9],
    ]);
  });
});
