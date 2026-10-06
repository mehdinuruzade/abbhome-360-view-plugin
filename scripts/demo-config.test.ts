import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveDimensions, quadAspect } from '../src/core/dimensions';
import { stringifyCompact } from '../src/core/json';
import { parseConfig } from '../src/core/parse-config';
import { buildDemoConfig } from './demo-config';

const committed = readFileSync(new URL('../public/demo/building.json', import.meta.url), 'utf8');

describe('demo config', () => {
  const config = buildDemoConfig();

  it('matches the committed public/demo/building.json (run `npm run demo:config` after changes)', () => {
    expect(stringifyCompact(config)).toBe(committed);
  });

  it('round-trips through JSON unchanged', () => {
    expect(JSON.parse(committed)).toEqual(JSON.parse(JSON.stringify(config)));
  });

  it('has 104 apartments on 13 floors, with corner units on two walls', () => {
    expect(config.apartments).toHaveLength(104);
    expect(new Set(config.apartments.map((a) => a.floor)).size).toBe(13);
    const corner = config.regions.filter((r) => r.apartmentId === 'apt-1203').map((r) => r.facade);
    expect(corner.sort()).toEqual(['front', 'right']);
    expect(config.regions).toHaveLength(104 + 52);
  });

  it('measures about 29.4 × 22.8 × 42.4 m, opposite walls within 1.5 %', () => {
    const { width, depth, height } = config.dimensions;
    expect(width).toBeCloseTo(29.4, 0);
    expect(depth).toBeCloseTo(22.8, 0);
    expect(height).toBeCloseTo(42.4, 0);
    const size = { width: 1844, height: 2000 };
    const aspect = (f: 'front' | 'right' | 'back' | 'left') => quadAspect(config.facades[f].corners, size);
    const { warnings } = deriveDimensions(height, {
      front: aspect('front'),
      back: aspect('back'),
      right: aspect('right'),
      left: aspect('left'),
    });
    expect(warnings).toEqual([]);
    expect(Math.abs(aspect('front') - aspect('back')) / aspect('front')).toBeLessThan(0.015);
  });

  it('parses without warnings', () => {
    const { warnings } = parseConfig(JSON.parse(committed), 'https://example.test/demo/building.json');
    expect(warnings).toEqual([]);
  });

  it('keeps apartment 1203 available (the e2e tests tap it) and includes sold units', () => {
    expect(config.apartments.find((a) => a.number === '1203')?.status).toBe('available');
    expect(config.apartments.some((a) => a.status === 'sold')).toBe(true);
    expect(config.apartments.some((a) => a.status === 'reserved')).toBe(true);
  });
});
