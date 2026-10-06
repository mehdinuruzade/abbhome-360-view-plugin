import { describe, expect, it } from 'vitest';
import { deriveDimensions, quadAspect } from './dimensions';
import type { Corners } from './types';

const img = { width: 2000, height: 1000 };

describe('dimensions', () => {
  it('measures the pixel aspect ratio of a wall quad', () => {
    // 0.5 × 2000 px wide, 0.5 × 1000 px tall.
    const c: Corners = { tl: [0.25, 0.25], tr: [0.75, 0.25], br: [0.75, 0.75], bl: [0.25, 0.75] };
    expect(quadAspect(c, img)).toBeCloseTo(2, 12);
  });

  it('derives width and depth from the height and opposite walls', () => {
    const { dimensions, warnings } = deriveDimensions(40, {
      front: 0.75,
      back: 0.74,
      right: 0.5,
      left: 0.51,
    });
    expect(dimensions.height).toBe(40);
    expect(dimensions.width).toBeCloseTo(29.8, 9);
    expect(dimensions.depth).toBeCloseTo(20.2, 9);
    expect(warnings).toEqual([]);
  });

  it('warns when opposite walls disagree by more than 5 %', () => {
    const { warnings } = deriveDimensions(40, { front: 0.8, back: 0.7, right: 0.5, left: 0.5 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('width-mismatch');
    expect(warnings[0]?.difference).toBeCloseTo(0.1333, 3);
  });
});
