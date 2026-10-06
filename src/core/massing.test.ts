import { describe, expect, it } from 'vitest';
import { uvToWorld } from './facade-frame';
import { blocksOf, elevationUv, facadeToWorld, normalizeRing, occluderHeight, planToWorld, wallsOf, type Block } from './massing';
import { FACADES, type Dimensions, type MassingBlock, type Vec2 } from './types';

const d: Dimensions = { width: 30, depth: 20, height: 40 };
const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.every((x, i) => Math.abs(x - (b[i] ?? NaN)) < eps);
const shape = (blocks: MassingBlock[]) => blocksOf({ dimensions: d, massing: { blocks } });

/** An L: full-width front part 10 m deep, plus the left 12 m running to the back. */
const L: MassingBlock = { polygon: [[0, 0], [30, 0], [30, 10], [12, 10], [12, 20], [0, 20]], height: 40 };
/** A U open to the front: a 6 m court, 8 m deep, between two arms. */
const U: MassingBlock = { polygon: [[0, 0], [12, 0], [12, 8], [18, 8], [18, 0], [30, 0], [30, 20], [0, 20]], height: 40 };

describe('massing', () => {
  it('normalises rings to counter-clockwise without repeated points', () => {
    const ring = normalizeRing([[0, 0], [0, 1], [0, 1], [1, 1], [1, 0], [0, 0]]);
    expect(ring).toHaveLength(4);
    const area = ring.reduce((s, p, i) => {
      const q = ring[(i + 1) % ring.length] as Vec2;
      return s + p[0] * q[1] - q[0] * p[1];
    }, 0);
    expect(area).toBeGreaterThan(0);
  });

  it('without massing is the box: four walls that match the facade frames', () => {
    const walls = wallsOf(blocksOf({ dimensions: d }));
    expect(walls).toHaveLength(4);
    for (const f of FACADES) {
      const w = walls.find((x) => x.facade === f);
      expect(w).toBeDefined();
      if (!w) continue;
      // Left end at (u = 0), right end at (u = 1), as uvToWorld places them.
      const left = uvToWorld(f, d, 0, 1);
      const right = uvToWorld(f, d, 1, 1);
      expect(near(w.a, [left[0], left[2]])).toBe(true);
      expect(near(w.b, [right[0], right[2]])).toBe(true);
      expect(w.height).toBe(40);
    }
  });

  it('projects any point onto the elevations like the box does', () => {
    for (const f of FACADES) {
      const p = uvToWorld(f, d, 0.3, 0.7);
      expect(near(elevationUv(f, p, d), [0.3, 0.7])).toBe(true);
    }
  });

  it('gives an L shape six walls; the inner corner walls face front and right', () => {
    const walls = wallsOf(shape([L]));
    expect(walls).toHaveLength(6);
    const counts = walls.reduce<Record<string, number>>((c, w) => ({ ...c, [w.facade]: (c[w.facade] ?? 0) + 1 }), {});
    expect(counts).toEqual({ front: 1, right: 2, back: 2, left: 1 });
    // The recessed right wall (x = 12) shows the right elevation from u = 0.5 to 1.
    const recessed = walls.find((w) => w.facade === 'right' && Math.abs(w.a[0] - (12 - 15)) < 1e-9);
    expect(recessed).toBeDefined();
    if (recessed) {
      expect(elevationUv('right', [recessed.a[0], 0, recessed.a[1]], d)[0]).toBeCloseTo(0.5);
      expect(elevationUv('right', [recessed.b[0], 0, recessed.b[1]], d)[0]).toBeCloseTo(1);
    }
  });

  it('hides the court side walls of a U from their elevations, but not the court back wall', () => {
    const blocks = shape([U]);
    // The court's left side wall is at x = 12 facing right; the right arm blocks the right view.
    const sideWall = planToWorld([12, 4], d);
    expect(occluderHeight('right', sideWall, blocks)).toBe(40);
    // The court's back wall (d = 8) faces the front; nothing is in front of it.
    expect(occluderHeight('front', planToWorld([15, 8], d), blocks)).toBe(0);
    // Outer walls are visible.
    expect(occluderHeight('front', planToWorld([5, 0], d), blocks)).toBe(0);
  });

  it('finds the frontmost visible wall for a facade point', () => {
    const blocks = shape([U]);
    const walls = wallsOf(blocks);
    // Front elevation at u = 0.5 is the court's back wall, 8 m back from the front.
    const court = facadeToWorld('front', 0.5, 0.5, walls, blocks, d);
    expect(court).not.toBeNull();
    expect(court?.point[2]).toBeCloseTo(10 - 8);
    expect(court?.normal).toEqual([0, 0, 1]);
    // At u = 0.1 it's the left arm's front.
    expect(facadeToWorld('front', 0.1, 0.5, walls, blocks, d)?.point[2]).toBeCloseTo(10);
  });

  it('handles a podium with a tower: the tower front shows above the podium only', () => {
    const blocks: Block[] = shape([
      { polygon: [[0, 0], [30, 0], [30, 20], [0, 20]], height: 10 },
      { polygon: [[8, 6], [22, 6], [22, 16], [8, 16]], height: 40 },
    ]);
    const walls = wallsOf(blocks);
    expect(walls).toHaveLength(8);
    // High up, the front elevation is the tower, 6 m back.
    const high = facadeToWorld('front', 0.5, 0.2, walls, blocks, d);
    expect(high?.point[2]).toBeCloseTo(10 - 6);
    // Low down it's the podium front.
    expect(facadeToWorld('front', 0.5, 0.9, walls, blocks, d)?.point[2]).toBeCloseTo(10);
    // Beside the tower, above the podium, there's no wall at all.
    expect(facadeToWorld('front', 0.1, 0.2, walls, blocks, d)).toBeNull();
    // The tower's front wall below 10 m is behind the podium.
    expect(occluderHeight('front', planToWorld([15, 6], d), blocks)).toBe(10);
  });

  it('textures an angled wall from the elevation it faces most', () => {
    const blocks = shape([{ polygon: [[0, 0], [20, 0], [30, 10], [30, 20], [0, 20]], height: 40 }]);
    const chamfer = wallsOf(blocks).find((w) => Math.abs(w.normal[0] - w.normal[1]) < 1e-9);
    expect(chamfer).toBeDefined();
    expect(['front', 'right']).toContain(chamfer?.facade);
  });
});
