import { DEFAULT_NUMBER_PATTERN, formatUnitNumber } from '../core/apartments';
import { mergeIntervals, rectPolygon } from '../core/geometry2d';
import {
  FACADES,
  type Apartment,
  type ApartmentPatch,
  type BuildingConfig,
  type EditorData,
  type EditorUnit,
  type FacadeId,
  type Region,
  type UnitCell,
  type Vec2,
} from '../core/types';

/**
 * The editor's grid model, as pure functions over a BuildingConfig. Floor lines are shared by all
 * four walls; dividers are per wall. An apartment made in the editor is a level band times one or
 * more columns (two walls for a corner unit), and its regions are regenerated whenever a line or
 * divider moves, so the `editor` block is the source of truth and `regions` is derived from it.
 */

/** Smallest band or column, as a fraction of the wall (about 20 cm on a 45 m wall). */
export const MIN_GAP = 0.004;

export interface LevelBand {
  level: number;
  vTop: number;
  vBottom: number;
}

export type WithEditor = BuildingConfig & { editor: EditorData };

export function emptyEditorData(): EditorData {
  return {
    floorLines: [0, 1],
    baseLevel: 0,
    dividers: { front: [], right: [], back: [], left: [] },
    units: {},
    numberPattern: DEFAULT_NUMBER_PATTERN,
  };
}

export function withEditor(config: BuildingConfig): WithEditor {
  return config.editor ? (config as WithEditor) : { ...config, editor: emptyEditorData() };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Bands between consecutive floor lines, top to bottom. The bottom band is `baseLevel`. */
export function levelBands(e: EditorData): LevelBand[] {
  const lines = e.floorLines;
  const n = lines.length - 1;
  const bands: LevelBand[] = [];
  for (let i = 0; i < n; i++) {
    bands.push({ level: e.baseLevel + (n - 1 - i), vTop: lines[i] as number, vBottom: lines[i + 1] as number });
  }
  return bands;
}

export function bandForLevel(e: EditorData, level: number): LevelBand | undefined {
  return levelBands(e).find((b) => b.level === level);
}

/** [u0, u1] of each column on a wall, left to right. */
export function columnBounds(e: EditorData, f: FacadeId): Vec2[] {
  const edges = [0, ...e.dividers[f], 1];
  return edges.slice(0, -1).map((u, i): Vec2 => [u, edges[i + 1] as number]);
}

/** One rectangle per wall per run of adjacent columns. */
export function unitRegions(e: EditorData, apartmentId: string, unit: EditorUnit): Region[] {
  const band = bandForLevel(e, unit.level);
  if (!band) return [];
  const out: Region[] = [];
  for (const f of FACADES) {
    const cols = columnBounds(e, f);
    const spans = unit.cells
      .filter((c) => c.facade === f)
      .map((c) => cols[c.col])
      .filter((s): s is Vec2 => s !== undefined);
    for (const [u0, u1] of mergeIntervals(spans)) {
      out.push({ apartmentId, facade: f, polygon: rectPolygon(u0, band.vTop, u1, band.vBottom) });
    }
  }
  return out;
}

/** Recomputes the regions of editor-made apartments and keeps every other region as it was. */
export function regenerateRegions<T extends BuildingConfig>(config: T): T {
  const e = config.editor;
  if (!e) return config;
  const kept = config.regions.filter((r) => !e.units[r.apartmentId]);
  const generated = config.apartments.flatMap((a) => {
    const unit = e.units[a.id];
    return unit ? unitRegions(e, a.id, unit) : [];
  });
  return { ...config, regions: [...kept, ...generated] };
}

function withUnits<T extends WithEditor>(config: T, units: Record<string, EditorUnit>): T {
  return { ...config, editor: { ...config.editor, units } };
}

/** Removes apartments together with their regions and editor cells. */
export function removeApartments<T extends BuildingConfig>(config: T, ids: readonly string[]): T {
  if (ids.length === 0) return config;
  const drop = new Set(ids);
  const next: T = {
    ...config,
    apartments: config.apartments.filter((a) => !drop.has(a.id)),
    regions: config.regions.filter((r) => !drop.has(r.apartmentId)),
  };
  if (config.editor) {
    const units = { ...config.editor.units };
    for (const id of drop) delete units[id];
    next.editor = { ...config.editor, units };
  }
  return next;
}

export function updateApartment<T extends BuildingConfig>(config: T, id: string, patch: Omit<ApartmentPatch, 'id'>): T {
  return {
    ...config,
    apartments: config.apartments.map((a) => {
      if (a.id !== id) return a;
      const merged: Apartment = { ...a };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete merged[k];
        else merged[k] = v;
      }
      return merged;
    }),
  };
}

// ── Floor lines ────────────────────────────────────────────────────────────────────────────

/**
 * Evenly spaced lines giving `count` bands between `top` and `bottom` (defaults: the current
 * outermost lines). Apartments on levels that no longer exist are removed and returned, so the
 * caller can ask first.
 */
export function setEvenFloors(
  config: BuildingConfig,
  count: number,
  top?: number,
  bottom?: number,
): { config: WithEditor; removed: string[] } {
  const c = withEditor(config);
  const e = c.editor;
  const n = Math.max(1, Math.round(count));
  const t = clamp(top ?? e.floorLines[0] ?? 0, 0, 1);
  const b = clamp(bottom ?? e.floorLines[e.floorLines.length - 1] ?? 1, t + MIN_GAP * n, 1);
  const floorLines = Array.from({ length: n + 1 }, (_, k) => t + (k * (b - t)) / n);
  const maxLevel = e.baseLevel + n - 1;
  const removed = Object.entries(e.units)
    .filter(([, u]) => u.level < e.baseLevel || u.level > maxLevel)
    .map(([id]) => id);
  const next = removeApartments({ ...c, editor: { ...e, floorLines } }, removed);
  return { config: regenerateRegions(next), removed };
}

export function moveFloorLine(config: BuildingConfig, index: number, v: number): WithEditor {
  const c = withEditor(config);
  const lines = [...c.editor.floorLines];
  if (index < 0 || index >= lines.length) return c;
  const lo = index > 0 ? (lines[index - 1] as number) + MIN_GAP : 0;
  const hi = index < lines.length - 1 ? (lines[index + 1] as number) - MIN_GAP : 1;
  lines[index] = clamp(v, lo, hi);
  return regenerateRegions({ ...c, editor: { ...c.editor, floorLines: lines } });
}

/** Renumbers the bands. Apartments stay on the same physical band; their floor shifts with it. */
export function setBaseLevel(config: BuildingConfig, baseLevel: number): WithEditor {
  const c = withEditor(config);
  const delta = Math.round(baseLevel) - c.editor.baseLevel;
  if (delta === 0) return c;
  const units: Record<string, EditorUnit> = {};
  for (const [id, u] of Object.entries(c.editor.units)) units[id] = { ...u, level: u.level + delta };
  return regenerateRegions({
    ...c,
    apartments: c.apartments.map((a) => (units[a.id] ? { ...a, floor: a.floor + delta } : a)),
    editor: { ...c.editor, baseLevel: c.editor.baseLevel + delta, units },
  });
}

// ── Dividers ───────────────────────────────────────────────────────────────────────────────

function remapCells(
  units: Record<string, EditorUnit>,
  f: FacadeId,
  map: (col: number) => number[],
): Record<string, EditorUnit> {
  const out: Record<string, EditorUnit> = {};
  for (const [id, u] of Object.entries(units)) {
    const cells: UnitCell[] = [];
    const seen = new Set<string>();
    for (const cell of u.cells) {
      const cols = cell.facade === f ? map(cell.col) : [cell.col];
      for (const col of cols) {
        const key = `${cell.facade}:${col}`;
        if (!seen.has(key)) {
          seen.add(key);
          cells.push({ facade: cell.facade, col });
        }
      }
    }
    out[id] = { ...u, cells };
  }
  return out;
}

/**
 * Splits the column under `u`. An apartment that used the split column keeps both halves, so
 * adding a divider never changes an existing apartment's outline. Returns index −1 when `u` is
 * too close to an edge or another divider.
 */
export function addDivider(config: BuildingConfig, f: FacadeId, u: number): { config: WithEditor; index: number } {
  const c = withEditor(config);
  const ds = c.editor.dividers[f];
  if (u < MIN_GAP || u > 1 - MIN_GAP || ds.some((d) => Math.abs(d - u) < MIN_GAP)) {
    return { config: c, index: -1 };
  }
  const k = ds.filter((d) => d < u).length;
  const dividers = { ...c.editor.dividers, [f]: [...ds.slice(0, k), u, ...ds.slice(k)] };
  const units = remapCells(c.editor.units, f, (col) => (col < k ? [col] : col === k ? [k, k + 1] : [col + 1]));
  return { config: regenerateRegions({ ...c, editor: { ...c.editor, dividers, units } }), index: k };
}

export function moveDivider(config: BuildingConfig, f: FacadeId, index: number, u: number): WithEditor {
  const c = withEditor(config);
  const ds = [...c.editor.dividers[f]];
  if (index < 0 || index >= ds.length) return c;
  const lo = (index > 0 ? (ds[index - 1] as number) : 0) + MIN_GAP;
  const hi = (index < ds.length - 1 ? (ds[index + 1] as number) : 1) - MIN_GAP;
  ds[index] = clamp(u, lo, hi);
  return regenerateRegions({ ...c, editor: { ...c.editor, dividers: { ...c.editor.dividers, [f]: ds } } });
}

/** Merges the two columns either side of the divider. */
export function removeDivider(config: BuildingConfig, f: FacadeId, index: number): WithEditor {
  const c = withEditor(config);
  const ds = c.editor.dividers[f];
  if (index < 0 || index >= ds.length) return c;
  const dividers = { ...c.editor.dividers, [f]: ds.filter((_, i) => i !== index) };
  const units = remapCells(c.editor.units, f, (col) => [col <= index ? col : col - 1]);
  return regenerateRegions({ ...c, editor: { ...c.editor, dividers, units } });
}

// ── Apartments ─────────────────────────────────────────────────────────────────────────────

/** The apartment occupying a cell at a level, if any. */
export function unitAt(e: EditorData, f: FacadeId, col: number, level: number): string | undefined {
  for (const [id, u] of Object.entries(e.units)) {
    if (u.level === level && u.cells.some((c) => c.facade === f && c.col === col)) return id;
  }
  return undefined;
}

export interface CreateUnitsInput {
  cells: readonly UnitCell[];
  levels: readonly number[];
  pattern?: string;
  status?: string;
}

/**
 * One apartment per level from the same cells (a "stack"). Numbers follow the pattern, the index
 * counting the apartments already on that level, so stacks created in order get 01, 02, …
 * Levels where any of the cells is taken are skipped and returned.
 */
export function createUnits(
  config: BuildingConfig,
  input: CreateUnitsInput,
): { config: WithEditor; created: string[]; skippedLevels: number[] } {
  let c = withEditor(config);
  const e = c.editor;
  const seen = new Set<string>();
  const cells = input.cells.filter((cell) => {
    const key = `${cell.facade}:${cell.col}`;
    const valid = cell.col >= 0 && cell.col < columnBounds(e, cell.facade).length;
    if (!valid || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const created: string[] = [];
  const skippedLevels: number[] = [];
  if (cells.length === 0) return { config: c, created, skippedLevels };

  const pattern = input.pattern ?? e.numberPattern ?? DEFAULT_NUMBER_PATTERN;
  const numbers = new Set(c.apartments.map((a) => a.number));
  const ids = new Set(c.apartments.map((a) => a.id));
  const apartments = [...c.apartments];
  const units = { ...e.units };
  for (const level of [...new Set(input.levels)].sort((a, b) => a - b)) {
    const occupied = cells.some((cell) => unitAt({ ...e, units }, cell.facade, cell.col, level));
    if (!bandForLevel(e, level) || occupied) {
      skippedLevels.push(level);
      continue;
    }
    let index = Object.values(units).filter((u) => u.level === level).length + 1;
    let number = formatUnitNumber(pattern, level, index);
    while (numbers.has(number)) number = formatUnitNumber(pattern, level, ++index);
    let id = `apt-${number}`;
    for (let k = 2; ids.has(id); k++) id = `apt-${number}-${k}`;
    numbers.add(number);
    ids.add(id);
    apartments.push({ id, number, floor: level, status: input.status ?? 'available' });
    units[id] = { level, cells: cells.map((cell) => ({ ...cell })) };
    created.push(id);
  }
  c = withUnits({ ...c, apartments }, units);
  return { config: regenerateRegions(c), created, skippedLevels };
}
