import { describe, expect, it } from 'vitest';
import type { BuildingConfig } from '../core/types';
import {
  addDivider,
  createUnits,
  levelBands,
  moveDivider,
  moveFloorLine,
  removeApartments,
  removeDivider,
  setBaseLevel,
  setEvenFloors,
  updateApartment,
  withEditor,
} from './state';

const corners = { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] } as BuildingConfig['facades']['front']['corners'];

function base(): BuildingConfig {
  const facade = { image: '', corners };
  return {
    schemaVersion: 1,
    id: 't',
    name: 'Test',
    dimensions: { width: 30, depth: 20, height: 40 },
    facades: { front: facade, right: facade, back: facade, left: facade },
    apartments: [],
    regions: [],
  };
}

/** Four bands (levels 0–3), front split at 0.5, right split at 0.4. */
function grid() {
  let c = setEvenFloors(base(), 4, 0, 1).config;
  c = addDivider(c, 'front', 0.5).config;
  c = addDivider(c, 'right', 0.4).config;
  return c;
}

describe('editor grid model', () => {
  it('numbers bands from the bottom, starting at the base level', () => {
    const c = setEvenFloors(base(), 2, 0, 1).config;
    expect(levelBands(c.editor)).toEqual([
      { level: 1, vTop: 0, vBottom: 0.5 },
      { level: 0, vTop: 0.5, vBottom: 1 },
    ]);
    expect(levelBands(setBaseLevel(c, 1).editor).map((b) => b.level)).toEqual([2, 1]);
  });

  it('creates a stack: one apartment per level, numbered by level and stack order', () => {
    let { config: c, created } = createUnits(grid(), { cells: [{ facade: 'front', col: 1 }], levels: [1, 2] });
    expect(created).toEqual(['apt-101', 'apt-201']);
    ({ config: c } = createUnits(c, { cells: [{ facade: 'front', col: 0 }], levels: [1] }));
    expect(c.apartments.map((a) => a.number)).toEqual(['101', '201', '102']);
    const r = c.regions.find((x) => x.apartmentId === 'apt-201');
    expect(r?.facade).toBe('front');
    expect(r?.polygon).toEqual([
      [0.5, 0.25],
      [1, 0.25],
      [1, 0.5],
      [0.5, 0.5],
    ]);
  });

  it('gives a corner apartment one region on each wall', () => {
    const { config: c } = createUnits(grid(), {
      cells: [
        { facade: 'front', col: 1 },
        { facade: 'right', col: 0 },
      ],
      levels: [2],
    });
    expect(c.regions.map((r) => r.facade).sort()).toEqual(['front', 'right']);
  });

  it('gives a re-created stack its old numbers back', () => {
    let c = grid();
    for (const col of [0, 1]) c = createUnits(c, { cells: [{ facade: 'front', col }], levels: [1] }).config;
    c = removeApartments(c, ['apt-101']);
    const { created } = createUnits(c, { cells: [{ facade: 'front', col: 0 }], levels: [1] });
    expect(created).toEqual(['apt-101']);
  });

  it('skips levels where a cell is already taken', () => {
    let { config: c } = createUnits(grid(), { cells: [{ facade: 'front', col: 1 }], levels: [1] });
    const res = createUnits(c, { cells: [{ facade: 'front', col: 1 }], levels: [1, 2] });
    c = res.config;
    expect(res.skippedLevels).toEqual([1]);
    expect(res.created).toEqual(['apt-201']);
  });

  it('moves regions with a dragged floor line', () => {
    const { config: c } = createUnits(grid(), { cells: [{ facade: 'front', col: 0 }], levels: [3] });
    const moved = moveFloorLine(c, 1, 0.3);
    expect(moved.regions[0]?.polygon[2]).toEqual([0.5, 0.3]);
    // Clamped so bands never invert.
    expect(moveFloorLine(c, 1, 0.9).editor.floorLines[1]).toBeLessThan(0.5);
  });

  it('keeps an apartment whole when a divider splits its column', () => {
    const { config: c } = createUnits(grid(), { cells: [{ facade: 'front', col: 1 }], levels: [0] });
    const { config: split, index } = addDivider(c, 'front', 0.75);
    expect(index).toBe(1);
    expect(split.editor.units['apt-001']?.cells).toEqual([
      { facade: 'front', col: 1 },
      { facade: 'front', col: 2 },
    ]);
    expect(split.regions[0]?.polygon[0]).toEqual([0.5, 0.75]);
    expect(split.regions[0]?.polygon[1]).toEqual([1, 0.75]);
  });

  it('merges columns when a divider is removed and shifts later columns', () => {
    let c = addDivider(grid(), 'front', 0.75).config; // front columns: 0–0.5, 0.5–0.75, 0.75–1
    c = createUnits(c, { cells: [{ facade: 'front', col: 2 }], levels: [0] }).config;
    const merged = removeDivider(c, 'front', 0);
    expect(merged.editor.dividers.front).toEqual([0.75]);
    expect(merged.editor.units['apt-001']?.cells).toEqual([{ facade: 'front', col: 1 }]);
    expect(merged.regions[0]?.polygon[0]?.[0]).toBe(0.75);
  });

  it('clamps dragged dividers between their neighbours', () => {
    const c = addDivider(grid(), 'front', 0.75).config;
    expect(moveDivider(c, 'front', 0, 0.9).editor.dividers.front[0]).toBeLessThan(0.75);
    expect(addDivider(c, 'front', 0.501).index).toBe(-1);
  });

  it('removes apartments with their regions and cells, and drops units on removed levels', () => {
    let { config: c } = createUnits(grid(), { cells: [{ facade: 'front', col: 0 }], levels: [0, 3] });
    c = removeApartments(c, ['apt-001']);
    expect(c.apartments.map((a) => a.id)).toEqual(['apt-301']);
    expect(c.regions.every((r) => r.apartmentId === 'apt-301')).toBe(true);
    expect(Object.keys(c.editor.units)).toEqual(['apt-301']);
    const shrunk = setEvenFloors(c, 2);
    expect(shrunk.removed).toEqual(['apt-301']);
    expect(shrunk.config.apartments).toEqual([]);
  });

  it('shifts floors with the base level so apartments stay on their band', () => {
    const { config: c } = createUnits(grid(), { cells: [{ facade: 'front', col: 0 }], levels: [1] });
    const shifted = setBaseLevel(c, -1);
    expect(shifted.apartments[0]?.floor).toBe(0);
    expect(shifted.regions[0]?.polygon).toEqual(c.regions[0]?.polygon);
  });

  it('updates apartment fields and deletes fields set to undefined', () => {
    const { config: c } = createUnits(grid(), { cells: [{ facade: 'front', col: 0 }], levels: [1] });
    const u = updateApartment(c, 'apt-101', { rooms: 3, status: 'sold' });
    expect(u.apartments[0]).toMatchObject({ rooms: 3, status: 'sold' });
    expect('rooms' in updateApartment(u, 'apt-101', { rooms: undefined }).apartments[0]!).toBe(false);
  });

  it('leaves configs without editor data untouched until the editor is used', () => {
    const c = base();
    expect(withEditor(c).editor.floorLines).toEqual([0, 1]);
    expect(c.editor).toBeUndefined();
  });
});
