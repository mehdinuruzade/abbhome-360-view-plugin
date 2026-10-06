import { describe, expect, it } from 'vitest';
import { applyH, isConvexQuad, squareToQuad } from './homography';
import type { Corners, Vec2 } from './types';

const rect: Corners = { tl: [0.2, 0.1], tr: [0.8, 0.1], br: [0.8, 0.9], bl: [0.2, 0.9] };
// A keystoned wall, as a photo taken from the ground looking up would give.
const keystone: Corners = { tl: [0.3, 0.1], tr: [0.7, 0.12], br: [0.85, 0.95], bl: [0.15, 0.9] };

function close(a: Vec2, b: Vec2, digits = 12) {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
}

function lineIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  const a = p1[0] * p2[1] - p1[1] * p2[0];
  const b = p3[0] * p4[1] - p3[1] * p4[0];
  return [
    (a * (p3[0] - p4[0]) - (p1[0] - p2[0]) * b) / d,
    (a * (p3[1] - p4[1]) - (p1[1] - p2[1]) * b) / d,
  ];
}

describe('squareToQuad', () => {
  for (const [name, quad] of [
    ['rectangle', rect],
    ['keystone', keystone],
  ] as const) {
    it(`maps the unit square's corners exactly onto the ${name}`, () => {
      const h = squareToQuad(quad);
      expect(h).not.toBeNull();
      if (!h) return;
      close(applyH(h, 0, 0), quad.tl);
      close(applyH(h, 1, 0), quad.tr);
      close(applyH(h, 1, 1), quad.br);
      close(applyH(h, 0, 1), quad.bl);
    });

    it(`maps the square's centre onto the ${name}'s diagonal intersection`, () => {
      const h = squareToQuad(quad);
      if (!h) throw new Error('expected a homography');
      close(applyH(h, 0.5, 0.5), lineIntersection(quad.tl, quad.br, quad.tr, quad.bl), 10);
    });
  }

  it('is affine for a rectangle (midpoints map to midpoints)', () => {
    const h = squareToQuad(rect);
    if (!h) throw new Error('expected a homography');
    expect(h[6]).toBe(0);
    expect(h[7]).toBe(0);
    close(applyH(h, 0.25, 0.5), [0.35, 0.5]);
  });

  it('returns null for degenerate, self-crossing and mirrored quads', () => {
    const collinear: Corners = { tl: [0, 0], tr: [0.5, 0], br: [1, 0], bl: [0, 1] };
    const bowTie: Corners = { tl: [0, 0], tr: [1, 1], br: [1, 0], bl: [0, 1] };
    const mirrored: Corners = { tl: rect.tr, tr: rect.tl, br: rect.bl, bl: rect.br };
    const point: Corners = { tl: [0.5, 0.5], tr: [0.5, 0.5], br: [0.5, 0.5], bl: [0.5, 0.5] };
    for (const q of [collinear, bowTie, mirrored, point]) {
      expect(isConvexQuad(q)).toBe(false);
      expect(squareToQuad(q)).toBeNull();
    }
  });

  it('rejects a concave quad', () => {
    const concave: Corners = { tl: [0, 0], tr: [1, 0], br: [0.4, 0.3], bl: [0, 1] };
    expect(squareToQuad(concave)).toBeNull();
  });
});
