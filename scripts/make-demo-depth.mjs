// Computes the demo building's relief with the real depth model and writes
// public/demo/assets/<wall>-relief.png, then regenerates public/demo/building.json.
// Run on a machine that can reach huggingface.co:  npm run build && npm run demo:depth
// (needs Playwright's Chromium once: npx playwright install chromium)
// DEPTH_MODEL_FILE=path/to/model.onnx uses a local model file instead of downloading it.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const root = new URL('..', import.meta.url);
const config = JSON.parse(readFileSync(new URL('public/demo/building.json', root), 'utf8'));
const server = await preview({ preview: { port: 4175, strictPort: true, host: '127.0.0.1' } });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const localModel = process.env.DEPTH_MODEL_FILE;
  if (localModel) {
    await page.addInitScript(() => {
      window.abb360DepthModelUrl = 'https://local-model.invalid/model.onnx';
    });
    await page.route('https://local-model.invalid/model.onnx', (route) =>
      route.fulfill({ body: readFileSync(localModel), contentType: 'application/octet-stream' }),
    );
  }
  page.on('console', (m) => console.log(`[browser] ${m.text()}`));
  await page.goto('http://127.0.0.1:4175/editor/index.html');
  await page.waitForFunction(() => window.abb360Depth);
  const { width, depth, height } = config.dimensions;
  for (const f of ['front', 'right', 'back', 'left']) {
    const aspect = (f === 'front' || f === 'back' ? width : depth) / height;
    console.log(`Estimating depth for the ${f} wall…`);
    const dataUrl = await page.evaluate(
      async ({ src, corners, aspect }) => (await window.abb360Depth.estimateRelief(src, corners, aspect)).dataUrl,
      { src: `/demo/${config.facades[f].image}`, corners: config.facades[f].corners, aspect },
    );
    writeFileSync(new URL(`public/demo/assets/${f}-relief.png`, root), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
execSync('npm run demo:config', { stdio: 'inherit', cwd: root });
console.log('Done. Check the demo page, then commit public/demo/assets/*-relief.png and public/demo/building.json.');
