import { squareToQuad } from './homography';
import {
  FACADES,
  KNOWN_STATUSES,
  type Apartment,
  type BuildingConfig,
  type Corners,
  type Dimensions,
  type EditorData,
  type EditorUnit,
  type FacadeConfig,
  type FacadeId,
  type Money,
  type Region,
  type UnitCell,
  type Vec2,
} from './types';

/** The config can't be shown at all (not an object, or no usable dimensions). */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface ParseResult {
  config: BuildingConfig;
  /** Problems that were worked around: logged for the host's developers, never shown to buyers. */
  warnings: string[];
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isFacadeId = (v: unknown): v is FacadeId => (FACADES as readonly unknown[]).includes(v);

/** Relative URLs resolve against the config's own URL; data: and blob: URLs pass through. */
export function resolveUrl(url: string, baseUrl: string | undefined): string {
  if (!url || !baseUrl || /^(data|blob):/i.test(url)) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function parseVec2(v: unknown): Vec2 | null {
  if (!Array.isArray(v) || v.length < 2 || !isFiniteNumber(v[0]) || !isFiniteNumber(v[1])) {
    return null;
  }
  return [v[0], v[1]];
}

export function fullImageCorners(): Corners {
  return { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] };
}

function parseCorners(raw: unknown, path: string, warnings: string[]): Corners {
  if (raw !== undefined) {
    const o = isObject(raw) ? raw : {};
    const c = { tl: parseVec2(o.tl), tr: parseVec2(o.tr), br: parseVec2(o.br), bl: parseVec2(o.bl) };
    if (c.tl && c.tr && c.br && c.bl) {
      const corners: Corners = { tl: c.tl, tr: c.tr, br: c.br, bl: c.bl };
      if (squareToQuad(corners)) return corners;
    }
    warnings.push(`${path}: corners must be a convex tl, tr, br, bl quad; using the whole image`);
  }
  return fullImageCorners();
}

function parseFacade(raw: unknown, f: FacadeId, baseUrl: string | undefined, warnings: string[]) {
  if (!isObject(raw)) {
    warnings.push(`facades.${f} is missing; showing a plain wall`);
    return { image: '', corners: fullImageCorners() } satisfies FacadeConfig;
  }
  const image = typeof raw.image === 'string' ? resolveUrl(raw.image, baseUrl) : '';
  if (!image) warnings.push(`facades.${f}.image is missing; showing a plain wall`);
  return {
    ...raw,
    image,
    corners: parseCorners(raw.corners, `facades.${f}.corners`, warnings),
  } satisfies FacadeConfig;
}

function parseDimensions(raw: unknown): Dimensions {
  const o = isObject(raw) ? raw : {};
  const { width, depth, height } = o;
  if (
    !isFiniteNumber(width) || !isFiniteNumber(depth) || !isFiniteNumber(height) ||
    width <= 0 || depth <= 0 || height <= 0
  ) {
    throw new ConfigError('dimensions need positive width, depth and height in metres');
  }
  return { width, depth, height };
}

function parseMoney(raw: unknown): Money | null {
  if (!isObject(raw)) return null;
  const { amountMinor, currency } = raw;
  if (!isFiniteNumber(amountMinor) || typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    return null;
  }
  return { amountMinor: Math.round(amountMinor), currency: currency.toUpperCase() };
}

function parseApartment(
  raw: unknown,
  index: number,
  baseUrl: string | undefined,
  warnings: string[],
): Apartment | null {
  if (!isObject(raw)) {
    warnings.push(`apartments[${index}] is not an object; skipped`);
    return null;
  }
  const id = typeof raw.id === 'number' ? String(raw.id) : raw.id;
  if (typeof id !== 'string' || !id) {
    warnings.push(`apartments[${index}] has no id; skipped`);
    return null;
  }
  const number =
    typeof raw.number === 'string' || typeof raw.number === 'number' ? String(raw.number) : id;
  let floor = 0;
  if (isFiniteNumber(raw.floor)) floor = raw.floor;
  else warnings.push(`apartment ${id} has no floor; using 0`);
  const status = typeof raw.status === 'string' && raw.status ? raw.status : 'unknown';

  const out: Apartment = { ...raw, id, number, floor, status };
  for (const key of ['rooms', 'areaM2'] as const) {
    if (out[key] !== undefined && !isFiniteNumber(out[key])) {
      warnings.push(`apartment ${id}: ${key} is not a number; ignored`);
      delete out[key];
    }
  }
  if (raw.price !== undefined) {
    const price = parseMoney(raw.price);
    if (price) out.price = price;
    else {
      warnings.push(`apartment ${id}: price needs amountMinor and a 3-letter currency; ignored`);
      delete out.price;
    }
  }
  if (typeof raw.planImage === 'string' && raw.planImage) {
    out.planImage = resolveUrl(raw.planImage, baseUrl);
  } else delete out.planImage;
  if (raw.extra !== undefined && !isObject(raw.extra)) delete out.extra;
  return out;
}

function parseRegion(raw: unknown, index: number, ids: Set<string>, warnings: string[]) {
  if (!isObject(raw)) {
    warnings.push(`regions[${index}] is not an object; skipped`);
    return null;
  }
  const { apartmentId, facade } = raw;
  if (typeof apartmentId !== 'string' || !ids.has(apartmentId)) {
    warnings.push(`regions[${index}] points at an unknown apartment; skipped`);
    return null;
  }
  if (!isFacadeId(facade)) {
    warnings.push(`regions[${index}] has an unknown facade; skipped`);
    return null;
  }
  const polygon = Array.isArray(raw.polygon) ? raw.polygon.map(parseVec2) : [];
  if (polygon.length < 3 || polygon.some((p) => p === null)) {
    warnings.push(`regions[${index}] needs a polygon of at least 3 [u, v] points; skipped`);
    return null;
  }
  return { apartmentId, facade, polygon: polygon as Vec2[] } satisfies Region;
}

function numberList(v: unknown): number[] | null {
  return Array.isArray(v) && v.every(isFiniteNumber) ? [...v] : null;
}

/** Editor data is advisory: anything malformed is dropped, the regions still render. */
function parseEditor(raw: unknown, warnings: string[]): EditorData | undefined {
  if (raw === undefined) return undefined;
  const fail = () => {
    warnings.push('editor data is malformed; ignored (regions still display)');
    return undefined;
  };
  if (!isObject(raw)) return fail();
  const floorLines = numberList(raw.floorLines);
  if (!floorLines || floorLines.length < 2) return fail();
  const dividersRaw = isObject(raw.dividers) ? raw.dividers : {};
  const dividers = {} as Record<FacadeId, number[]>;
  for (const f of FACADES) dividers[f] = numberList(dividersRaw[f]) ?? [];
  const units: Record<string, EditorUnit> = {};
  if (isObject(raw.units)) {
    for (const [id, u] of Object.entries(raw.units)) {
      if (!isObject(u) || !isFiniteNumber(u.level) || !Array.isArray(u.cells)) continue;
      const cells = u.cells.filter(
        (c): c is UnitCell => isObject(c) && isFacadeId(c.facade) && isFiniteNumber(c.col),
      );
      units[id] = { level: u.level, cells: cells.map((c) => ({ facade: c.facade, col: c.col })) };
    }
  }
  return {
    floorLines: floorLines.sort((a, b) => a - b),
    baseLevel: isFiniteNumber(raw.baseLevel) ? raw.baseLevel : 0,
    dividers,
    units,
    ...(typeof raw.numberPattern === 'string' ? { numberPattern: raw.numberPattern } : {}),
  };
}

/**
 * Reads a building config leniently, so a host running an older widget never breaks on a newer
 * or slightly wrong config:
 * - unknown fields are kept;
 * - unknown statuses are kept and shown as unavailable;
 * - broken apartments and regions are skipped with a warning.
 * Throws ConfigError only when nothing sensible can be shown.
 */
export function parseConfig(input: unknown, baseUrl?: string): ParseResult {
  if (!isObject(input)) throw new ConfigError('the building config must be a JSON object');
  const warnings: string[] = [];

  let schemaVersion = 1;
  if (isFiniteNumber(input.schemaVersion)) schemaVersion = input.schemaVersion;
  else warnings.push('schemaVersion is missing; reading the config as version 1');
  if (schemaVersion > 1) {
    warnings.push(`config schema v${schemaVersion} is newer than this widget (v1); unknown parts are ignored`);
  }

  const dimensions = parseDimensions(input.dimensions);
  const facadesRaw = isObject(input.facades) ? input.facades : {};
  const facades = {} as Record<FacadeId, FacadeConfig>;
  for (const f of FACADES) facades[f] = parseFacade(facadesRaw[f], f, baseUrl, warnings);

  const apartments: Apartment[] = [];
  const ids = new Set<string>();
  const rawApartments = Array.isArray(input.apartments) ? input.apartments : [];
  rawApartments.forEach((raw, i) => {
    const a = parseApartment(raw, i, baseUrl, warnings);
    if (!a) return;
    if (ids.has(a.id)) {
      warnings.push(`apartment id ${a.id} appears twice; the second one is skipped`);
      return;
    }
    ids.add(a.id);
    apartments.push(a);
  });

  const unknownStatuses = new Map<string, number>();
  for (const a of apartments) {
    if (!(KNOWN_STATUSES as readonly string[]).includes(a.status)) {
      unknownStatuses.set(a.status, (unknownStatuses.get(a.status) ?? 0) + 1);
    }
  }
  for (const [status, count] of unknownStatuses) {
    warnings.push(`status "${status}" (${count} apartment${count === 1 ? '' : 's'}) is shown as unavailable`);
  }

  const rawRegions = Array.isArray(input.regions) ? input.regions : [];
  const regions = rawRegions
    .map((raw, i) => parseRegion(raw, i, ids, warnings))
    .filter((r): r is Region => r !== null);

  const editor = parseEditor(input.editor, warnings);
  const id = typeof input.id === 'string' || typeof input.id === 'number' ? String(input.id) : 'building';
  const config: BuildingConfig = {
    ...input,
    schemaVersion,
    id,
    name: typeof input.name === 'string' ? input.name : '',
    dimensions,
    facades,
    apartments,
    regions,
  };
  if (editor) config.editor = editor;
  else delete config.editor;
  return { config, warnings };
}
