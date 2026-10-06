import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, resolveUrl } from './parse-config';

const corners = { tl: [0.2, 0.1], tr: [0.8, 0.1], br: [0.8, 0.9], bl: [0.2, 0.9] };
const facade = (image: string) => ({ image, corners });

function minimal(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'b1',
    name: 'Test',
    dimensions: { width: 30, depth: 20, height: 40 },
    facades: {
      front: facade('front.webp'),
      right: facade('right.webp'),
      back: facade('back.webp'),
      left: facade('left.webp'),
    },
    apartments: [
      { id: 'a1', number: '101', floor: 1, status: 'available', rooms: 2 },
      { id: 'a2', number: '102', floor: 1, status: 'on-hold' },
    ],
    regions: [
      {
        apartmentId: 'a1',
        facade: 'front',
        polygon: [
          [0, 0],
          [0.5, 0],
          [0.5, 0.1],
        ],
      },
    ],
    ...over,
  };
}

describe('parseConfig', () => {
  it('reads a valid config and resolves image URLs against the config URL', () => {
    const { config, warnings } = parseConfig(minimal(), 'https://cdn.example.com/b/1/building.json');
    expect(config.facades.front.image).toBe('https://cdn.example.com/b/1/front.webp');
    expect(config.apartments).toHaveLength(2);
    expect(config.regions).toHaveLength(1);
    expect(warnings).toEqual(['status "on-hold" (1 apartment) is shown as unavailable']);
  });

  it('keeps unknown fields at every level', () => {
    const raw = minimal({ marketing: { tagline: 'x' } });
    (raw.apartments[0] as Record<string, unknown>).view = 'sea';
    const { config } = parseConfig(raw);
    expect(config.marketing).toEqual({ tagline: 'x' });
    expect(config.apartments[0]?.view).toBe('sea');
  });

  it('keeps unknown fields in nested objects too (regions, dimensions, corners, editor data)', () => {
    const raw = minimal({
      dimensions: { width: 30, depth: 20, height: 40, rotationDeg: 12 },
      editor: {
        floorLines: [0, 1],
        dividers: { front: [0.5] },
        units: { a1: { level: 0, cells: [{ facade: 'front', col: 0, note: 'x' }], stack: 'A' } },
        tool: 'v2',
      },
    });
    (raw.regions[0] as Record<string, unknown>).label = 'balcony';
    (raw.facades.front.corners as Record<string, unknown>).source = 'survey';
    const { config } = parseConfig(raw);
    expect(config.regions[0]?.label).toBe('balcony');
    expect(config.dimensions.rotationDeg).toBe(12);
    expect(config.facades.front.corners.source).toBe('survey');
    expect(config.editor?.tool).toBe('v2');
    expect(config.editor?.units.a1?.stack).toBe('A');
    expect(config.editor?.units.a1?.cells[0]?.note).toBe('x');
  });

  it('accepts numeric apartment ids in apartments and regions alike', () => {
    const raw = minimal({
      apartments: [{ id: 1203, number: 1203, floor: 12, status: 'available' }],
      regions: [{ apartmentId: 1203, facade: 'front', polygon: [[0, 0], [1, 0], [1, 1]] }],
    });
    const { config, warnings } = parseConfig(raw);
    expect(config.apartments[0]?.id).toBe('1203');
    expect(config.regions.map((r) => r.apartmentId)).toEqual(['1203']);
    expect(warnings).toEqual([]);
  });

  it('keeps an unknown status as-is (the widget shows it as unavailable)', () => {
    const { config } = parseConfig(minimal());
    expect(config.apartments[1]?.status).toBe('on-hold');
  });

  it('skips broken apartments and regions with warnings instead of failing', () => {
    const raw = minimal({
      apartments: [{ number: 'no id' }, { id: 'a1', floor: 2, price: { amountMinor: 'x' } }],
      regions: [
        { apartmentId: 'ghost', facade: 'front', polygon: [[0, 0], [1, 0], [1, 1]] },
        { apartmentId: 'a1', facade: 'roof', polygon: [[0, 0], [1, 0], [1, 1]] },
        { apartmentId: 'a1', facade: 'front', polygon: [[0, 0], [1, 0]] },
      ],
    });
    const { config, warnings } = parseConfig(raw);
    expect(config.apartments.map((a) => a.id)).toEqual(['a1']);
    expect(config.apartments[0]?.price).toBeUndefined();
    expect(config.regions).toEqual([]);
    expect(warnings.length).toBeGreaterThanOrEqual(5);
  });

  it('falls back to the whole image for bad corners and a plain wall for a missing facade', () => {
    const raw = minimal();
    raw.facades.back = { image: 'back.webp', corners: { ...corners, tl: [0.9, 0.1] } };
    delete (raw.facades as Record<string, unknown>).left;
    const { config, warnings } = parseConfig(raw);
    expect(config.facades.back.corners).toEqual({ tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] });
    expect(config.facades.left.image).toBe('');
    expect(warnings.some((w) => w.startsWith('facades.back.corners'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('facades.left'))).toBe(true);
  });

  it('reads a newer schema version best-effort with a warning', () => {
    const { config, warnings } = parseConfig(minimal({ schemaVersion: 2 }));
    expect(config.schemaVersion).toBe(2);
    expect(warnings[0]).toMatch(/newer/);
  });

  it('throws only when there is nothing to show', () => {
    expect(() => parseConfig('nope')).toThrow(ConfigError);
    expect(() => parseConfig(minimal({ dimensions: { width: 0, depth: 1, height: 1 } }))).toThrow(
      ConfigError,
    );
  });

  it('drops malformed editor data but keeps the regions', () => {
    const { config, warnings } = parseConfig(minimal({ editor: { floorLines: 'x' } }));
    expect(config.editor).toBeUndefined();
    expect(config.regions).toHaveLength(1);
    expect(warnings.some((w) => w.includes('editor data'))).toBe(true);
  });

  it('leaves data and blob URLs alone', () => {
    expect(resolveUrl('data:image/png;base64,AAA', 'https://x.test/a/')).toBe('data:image/png;base64,AAA');
    expect(resolveUrl('plans/a.svg', 'https://x.test/a/b.json')).toBe('https://x.test/a/plans/a.svg');
  });
});

describe('relief', () => {
  it('keeps a relief, resolves its image and clamps its depth', () => {
    const raw = minimal();
    (raw.facades.front as Record<string, unknown>).relief = { image: 'front-relief.png', depthM: 9, model: 'x' };
    (raw.facades.back as Record<string, unknown>).relief = { image: 'data:image/png;base64,AAA' };
    const { config, warnings } = parseConfig(raw, 'https://cdn.example.com/b/building.json');
    expect(config.facades.front.relief).toEqual({ image: 'https://cdn.example.com/b/front-relief.png', depthM: 5, model: 'x' });
    expect(config.facades.back.relief?.depthM).toBe(0.8);
    expect(warnings.some((w) => w.includes('relief'))).toBe(false);
  });

  it('shows a wall flat when its relief is unusable', () => {
    const raw = minimal();
    (raw.facades.left as Record<string, unknown>).relief = { depthM: 1 };
    const { config, warnings } = parseConfig(raw);
    expect(config.facades.left.relief).toBeUndefined();
    expect(warnings.some((w) => w.startsWith('facades.left.relief'))).toBe(true);
  });

  it('reads massing blocks, keeps unknown fields and drops a closing duplicate point', () => {
    const raw = minimal({
      massing: {
        roofStyle: 'flat',
        blocks: [{ polygon: [[0, 0], [30, 0], [30, 10], [12, 10], [12, 20], [0, 20], [0, 0]], height: 40, label: 'L' }],
      },
    });
    const { config, warnings } = parseConfig(raw);
    expect(warnings).not.toContainEqual(expect.stringContaining('massing'));
    expect(config.massing?.roofStyle).toBe('flat');
    expect(config.massing?.blocks[0]?.polygon).toHaveLength(6);
    expect(config.massing?.blocks[0]?.label).toBe('L');
  });

  it('skips broken massing blocks and falls back to the box when none is left', () => {
    const { config, warnings } = parseConfig(
      minimal({
        massing: {
          blocks: [
            { polygon: [[0, 0], [10, 0]], height: 10 },
            { polygon: [[0, 0], [10, 10], [10, 0], [0, 10]], height: 10 }, // a bow tie
            'nonsense',
          ],
        },
      }),
    );
    expect(config.massing).toBeUndefined();
    expect(warnings).toContainEqual(expect.stringContaining('at least 3 points'));
    expect(warnings).toContainEqual(expect.stringContaining('crosses itself'));
    expect(warnings).toContainEqual(expect.stringContaining('shown as a box'));
  });

  it('caps a block at the building height and fills in a missing one', () => {
    const { config, warnings } = parseConfig(
      minimal({
        massing: {
          blocks: [
            { polygon: [[0, 0], [30, 0], [30, 20], [0, 20]], height: 55 },
            { polygon: [[5, 5], [10, 5], [10, 10]] },
          ],
        },
      }),
    );
    expect(config.massing?.blocks.map((b) => b.height)).toEqual([40, 40]);
    expect(warnings).toContainEqual(expect.stringContaining('taller than dimensions.height'));
    expect(warnings).toContainEqual(expect.stringContaining('has no height'));
  });
});
