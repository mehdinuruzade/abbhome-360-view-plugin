/**
 * The building config (schema v1) is the contract between the editor, the widget and the host
 * page. Changes must stay additive: older widgets in the wild have to keep reading newer configs.
 */

/** The four walls in order around the building: each next one is the face to the right. */
export type FacadeId = 'front' | 'right' | 'back' | 'left';
export const FACADES: readonly FacadeId[] = ['front', 'right', 'back', 'left'];

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** The wall's four corners in its source image, normalised to the image size (0..1, y down). */
export interface Corners {
  tl: Vec2;
  tr: Vec2;
  br: Vec2;
  bl: Vec2;
  [key: string]: unknown;
}

/** Metres. `width` runs along the front and back walls, `depth` along the sides. */
export interface Dimensions {
  width: number;
  depth: number;
  height: number;
  [key: string]: unknown;
}

/**
 * Optional depth for a wall: a grayscale image in facade space (128 = wall plane, white sticks
 * out by `depthM` metres, black goes in by it). Usually a data URL made by the editor.
 */
export interface Relief {
  image: string;
  depthM: number;
  [key: string]: unknown;
}

export interface FacadeConfig {
  /** Image URL; relative URLs resolve against the config's own URL. Empty = plain wall. */
  image: string;
  corners: Corners;
  relief?: Relief;
  [key: string]: unknown;
}

export const KNOWN_STATUSES = ['available', 'reserved', 'sold'] as const;
export type KnownStatus = (typeof KNOWN_STATUSES)[number];

/** Money in minor units (e.g. qəpik), never floating point. */
export interface Money {
  amountMinor: number;
  currency: string;
}

export interface Apartment {
  id: string;
  number: string;
  floor: number;
  /** Usually a known status; any other value is kept and shown as unavailable. */
  status: string;
  rooms?: number;
  areaM2?: number;
  price?: Money;
  planImage?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

/** An apartment's outline on one wall, in facade space: u right, v down, both 0..1. */
export interface Region {
  apartmentId: string;
  facade: FacadeId;
  polygon: Vec2[];
  [key: string]: unknown;
}

/** One column of one facade. */
export interface UnitCell {
  facade: FacadeId;
  col: number;
  [key: string]: unknown;
}

/** How the editor built an apartment: a level band times one or more columns. */
export interface EditorUnit {
  level: number;
  cells: UnitCell[];
  [key: string]: unknown;
}

/** Editor-only data. The widget ignores it and reads `regions`. */
export interface EditorData {
  /** Ascending v positions shared by all walls (0 = roof line, 1 = ground). Bands lie between. */
  floorLines: number[];
  /** Level number of the bottom band. */
  baseLevel: number;
  /** Ascending u positions per facade, strictly inside (0, 1). Columns lie between. */
  dividers: Record<FacadeId, number[]>;
  /** Apartment id to the cells it was created from. */
  units: Record<string, EditorUnit>;
  numberPattern?: string;
  [key: string]: unknown;
}

export interface BuildingConfig {
  schemaVersion: number;
  id: string;
  name: string;
  dimensions: Dimensions;
  facades: Record<FacadeId, FacadeConfig>;
  apartments: Apartment[];
  regions: Region[];
  editor?: EditorData;
  [key: string]: unknown;
}

export interface ApartmentFilter {
  status?: string[];
  rooms?: number[];
  minFloor?: number;
  maxFloor?: number;
  /** Minor units, like `price.amountMinor`. */
  minPrice?: number;
  maxPrice?: number;
  minArea?: number;
  maxArea?: number;
  ids?: string[];
}

export type ApartmentPatch = { id: string } & Partial<Omit<Apartment, 'id'>>;
