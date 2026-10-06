import { describe, expect, it } from 'vitest';
import { stringifyCompact } from './json';

describe('stringifyCompact', () => {
  const value = {
    name: 'x',
    nested: { list: [1, 2, 3], deep: { a: null, b: true } },
    polygon: [
      [0.5, 0.25],
      [1, 0.25],
    ],
    long: Array.from({ length: 40 }, (_, i) => i * 1000),
    skip: undefined,
    empty: { arr: [], obj: {} },
  };

  it('parses back to the same value as JSON.stringify', () => {
    expect(JSON.parse(stringifyCompact(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it('keeps short structures on one line and wraps long ones', () => {
    const out = stringifyCompact(value);
    expect(out).toContain('"polygon": [[0.5, 0.25], [1, 0.25]]');
    expect(out).toContain('"deep": {"a": null, "b": true}');
    expect(out).toContain('"long": [\n');
    expect(out.endsWith('\n')).toBe(true);
  });
});
