import { existsSync, readFileSync } from 'node:fs';
import { deriveDimensions, quadAspect } from '../src/core/dimensions';
import type { BuildingConfig, Corners, FacadeConfig, FacadeId, Massing, UnitCell, Vec2 } from '../src/core/types';
import { createUnits, updateApartment, type WithEditor } from '../src/editor/state';

/**
 * The demo building, built from measurements of the four sample renders (1844×2000 px each).
 * Run `npm run demo:config` to rewrite public/demo/building.json; a unit test checks the
 * committed file still matches this function.
 */

const IMAGE = { width: 1844, height: 2000 };

/**
 * Wall rectangles in source pixels. The top edge is the top of the recessed central strip,
 * which is the same physical height on every face and keeps the sky notch above that strip
 * out of the texture. The right wall's ground is hidden by a neighbouring roof; its row comes
 * from the slab pitch.
 */
const CALIBRATION: Record<FacadeId, { x0: number; x1: number; top: number; ground: number }> = {
  front: { x0: 369, x1: 1477, top: 242, ground: 1840 },
  right: { x0: 451, x1: 1347, top: 202, ground: 1871 },
  back: { x0: 377, x1: 1464, top: 257, ground: 1828 },
  left: { x0: 496, x1: 1392, top: 203, ground: 1870 },
};

/**
 * Storey boundaries measured on the front, top to bottom: top loggia floors 13 and 12, typical
 * floors 11–2 (slab bands every two storeys, 105.45 px apart), terrace floor 1, commercial
 * ground floor 0. They land within 0.5 % at the same normalised height on the other walls.
 */
const FRONT_FLOOR_ROWS = [242, 402, 504, 609.5, 715, 820.5, 926, 1031.5, 1137, 1242, 1347.5, 1453, 1558.5, 1664.5, 1840];
const TYPICAL_STOREY_PX = (1558.5 - 504) / 10;
const STOREY_M = 2.8;

/** Column dividers (u) from the measured piers. Central strips are cores and stay unmarked. */
const DIVIDERS: Record<FacadeId, number[]> = {
  front: [0.35, 0.545, 0.645],
  right: [0.25, 0.59, 0.7],
  back: [0.36, 0.645],
  left: [0.29, 0.41, 0.63],
};

/**
 * The building's shape: the photos show narrow full-height slots (the sky shows through them at
 * the top): one in the front wall and one in each side wall at the same distance back (the left
 * and right photos agree to 0.002). Their u-ranges are measured from the sky in the photos; how
 * deep they go isn't visible in any photo, so SLOT_DEPTH_M is an estimate.
 */
const FRONT_SLOT_U: [number, number] = [0.546, 0.627];
/** On the right elevation (u = d / depth); the left one mirrors it. */
const SIDE_SLOT_U: [number, number] = [0.597, 0.695];
const SLOT_DEPTH_M = 1.8;

function demoMassing(width: number, depth: number, height: number): Massing {
  const r = (n: number) => round(n, 2);
  const [f0, f1] = FRONT_SLOT_U.map((u) => r(u * width)) as [number, number];
  const [s0, s1] = SIDE_SLOT_U.map((u) => r(u * depth)) as [number, number];
  const t = SLOT_DEPTH_M;
  const polygon: Vec2[] = [
    [0, 0], [f0, 0], [f0, t], [f1, t], [f1, 0], [width, 0],
    [width, s0], [r(width - t), s0], [r(width - t), s1], [width, s1],
    [width, depth], [0, depth],
    [0, s1], [t, s1], [t, s0], [0, s0],
  ];
  return { blocks: [{ polygon, height }] };
}

interface Stack {
  key: string;
  position: string;
  cells: UnitCell[];
  rooms: number;
  areaM2: number;
}

/** Eight apartments per floor; the four corner units wrap round two walls. Sample data. */
const STACKS: Stack[] = [
  { key: 'A', position: 'south-west corner', cells: [{ facade: 'front', col: 0 }, { facade: 'left', col: 3 }], rooms: 3, areaM2: 104.6 },
  { key: 'B', position: 'south', cells: [{ facade: 'front', col: 1 }], rooms: 2, areaM2: 68.4 },
  { key: 'C', position: 'south-east corner', cells: [{ facade: 'front', col: 3 }, { facade: 'right', col: 0 }], rooms: 3, areaM2: 97.8 },
  { key: 'D', position: 'east', cells: [{ facade: 'right', col: 1 }], rooms: 2, areaM2: 63.7 },
  { key: 'E', position: 'north-east corner', cells: [{ facade: 'right', col: 3 }, { facade: 'back', col: 0 }], rooms: 3, areaM2: 101.2 },
  { key: 'F', position: 'north', cells: [{ facade: 'back', col: 1 }], rooms: 2, areaM2: 73.9 },
  { key: 'G', position: 'north-west corner', cells: [{ facade: 'back', col: 2 }, { facade: 'left', col: 0 }], rooms: 3, areaM2: 95.6 },
  { key: 'H', position: 'west', cells: [{ facade: 'left', col: 2 }], rooms: 2, areaM2: 66.2 },
];

/** Written by `npm run demo:depth` next to the relief images: how they were made and their strength. */
function demoRelief(): { source: string; depthM: number } | null {
  const file = new URL('../public/demo/assets/relief.json', import.meta.url);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as { source: string; depthM: number };
}

const RESIDENTIAL_LEVELS = Array.from({ length: 13 }, (_, i) => i + 1);

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

function corners(f: FacadeId): Corners {
  const { x0, x1, top, ground } = CALIBRATION[f];
  const p = (x: number, y: number): [number, number] => [round(x / IMAGE.width, 5), round(y / IMAGE.height, 5)];
  return { tl: p(x0, top), tr: p(x1, top), br: p(x1, ground), bl: p(x0, ground) };
}

/** Deterministic mix: about 60 % available, 15 % reserved, 25 % sold. */
function sampleStatus(level: number, stackIndex: number): string {
  const h = (level * 31 + stackIndex * 17) % 20;
  return h < 12 ? 'available' : h < 15 ? 'reserved' : 'sold';
}

export function buildDemoConfig(): WithEditor {
  const front = CALIBRATION.front;
  const height = round(((front.ground - front.top) * STOREY_M) / TYPICAL_STOREY_PX, 2);
  const facades = {} as Record<FacadeId, FacadeConfig>;
  const aspects = {} as Record<FacadeId, number>;
  const relief = demoRelief();
  for (const f of ['front', 'right', 'back', 'left'] as const) {
    facades[f] = { image: `assets/${f}.webp`, corners: corners(f) };
    if (relief && existsSync(new URL(`../public/demo/assets/${f}-relief.png`, import.meta.url))) {
      facades[f].relief = { image: `assets/${f}-relief.png`, depthM: relief.depthM, source: relief.source };
    }
    aspects[f] = quadAspect(facades[f].corners, IMAGE);
  }
  const { dimensions } = deriveDimensions(height, aspects);

  const width = round(dimensions.width, 2);
  const depth = round(dimensions.depth, 2);
  const base: BuildingConfig = {
    schemaVersion: 1,
    id: 'demo-residence',
    name: 'Demo residence',
    sampleData: true,
    dimensions: { width, depth, height },
    massing: demoMassing(width, depth, height),
    facades,
    apartments: [],
    regions: [],
    editor: {
      floorLines: FRONT_FLOOR_ROWS.map((r) => round((r - front.top) / (front.ground - front.top), 4)),
      baseLevel: 0,
      dividers: DIVIDERS,
      units: {},
      numberPattern: '{floor}{nn}',
    },
  };

  // Stacks in order, so every floor numbers its apartments A=01 … H=08.
  let config = base as WithEditor;
  for (const stack of STACKS) {
    config = createUnits(config, { cells: stack.cells, levels: RESIDENTIAL_LEVELS }).config;
  }
  for (const a of config.apartments) {
    const stackIndex = Number(a.number.slice(-2));
    const stack = STACKS[stackIndex - 1] as Stack;
    const corner = stack.rooms === 3;
    const pricePerM2 = 1650 + 30 * a.floor + (corner ? 120 : 0);
    const priceAzn = Math.round((stack.areaM2 * pricePerM2) / 100) * 100;
    config = updateApartment(config, a.id, {
      rooms: stack.rooms,
      areaM2: stack.areaM2,
      price: { amountMinor: priceAzn * 100, currency: 'AZN' },
      status: sampleStatus(a.floor, stackIndex),
      planImage: `assets/plans/plan-${stack.rooms}-room.svg`,
      extra: { stack: stack.key, position: stack.position },
    });
  }
  return config;
}
