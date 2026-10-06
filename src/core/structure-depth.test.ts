import { describe, expect, it } from 'vitest';
import { encodeRelief, reliefAt } from './depth';
import { glassMask, structureDepth } from './structure-depth';

/** A light wall with rows of dark windows; rows of windows are separated by opaque slab bands. */
function facade(w: number, h: number, opts: { windows?: boolean } = {}): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Storeys 40 px tall: 28 px of window row, 12 px of slab band. Windows 20 px wide, every 32 px.
      const inWindow = opts.windows !== false && y % 40 >= 6 && y % 40 < 34 && x % 32 >= 6 && x % 32 < 26;
      const i = (y * w + x) * 4;
      const [r, g, b] = inWindow ? [50, 60, 80] : [205, 198, 188];
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe('structure depth', () => {
  it('leaves a blank wall on the plane', () => {
    const values = structureDepth(facade(256, 320, { windows: false }), 256, 320, 64, 80);
    expect(Math.max(...values.map(Math.abs))).toBeLessThan(1e-6);
  });

  it('finds the windows as glass', () => {
    const mask = glassMask(facade(256, 320), 256, 320);
    expect(mask[20 * 256 + 16]).toBeGreaterThan(0.9); // window centre
    expect(mask[20 * 256 + 2]).toBeLessThan(0.1); // pier between windows
  });

  it('puts windows back and slab bands forward', () => {
    const w = 256;
    const h = 320;
    const values = structureDepth(facade(w, h), w, h, w, h);
    const at = (x: number, y: number) => values[y * w + x] ?? 0;
    expect(at(16, 60)).toBeLessThan(-0.5); // window
    expect(at(16, 78)).toBeGreaterThan(0.4); // slab band between window rows
    expect(Math.abs(at(2, 60))).toBeLessThan(0.05); // pier beside a window
  });

  it('encodes to relief that is in and out around 128 and flat at the edges', () => {
    const w = 256;
    const h = 320;
    const relief = encodeRelief(structureDepth(facade(w, h), w, h, 128, 160), 128, 160, { smoothing: 0 });
    expect(reliefAt(relief, 16 / w, 60 / h)).toBeLessThan(-0.3);
    expect(reliefAt(relief, 16 / w, 78 / h)).toBeGreaterThan(0.2);
    expect(relief.data[0]).toBe(128);
    expect(relief.data[relief.data.length - 1]).toBe(128);
  });
});
