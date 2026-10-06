import { expect, test } from '@playwright/test';

// Every other e2e test depends on WebGL working in this browser, so check it first and loudly.
test('the browser can create a WebGL2 context and draw', async ({ page }) => {
  await page.goto('./');
  const pixel = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const gl = canvas.getContext('webgl2');
    if (!gl) return null;
    gl.clearColor(1, 0.5, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const out = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return Array.from(out);
  });
  expect(pixel, 'WebGL2 is unavailable in this browser').not.toBeNull();
  expect(pixel?.[0]).toBe(255);
  expect(pixel?.[1]).toBeGreaterThan(120);
  expect(pixel?.[1]).toBeLessThan(135);
  expect(pixel?.[2]).toBe(0);
});
