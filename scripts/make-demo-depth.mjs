// Computes the demo building's relief in the editor's code, in a real browser, and writes
// public/demo/assets/<wall>-relief.png and relief.json, then regenerates public/demo/building.json.
//   npm run build && npm run demo:depth          structure depth (offline, instant)
//   npm run build && npm run demo:depth -- --ai  the AI depth model (needs huggingface.co)
// Needs Playwright's Chromium (once, outside the cloud container: npx playwright install chromium).
// DEPTH_MODEL_FILE=path/to/model.onnx uses a local model file instead of downloading it.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const root = new URL('..', import.meta.url);
const useModel = process.argv.includes('--ai');
const source = useModel ? 'model' : 'structure';
// Keep in step with STRUCTURE_DEPTH_M (src/core/structure-depth.ts) and DEFAULT_RELIEF_DEPTH_M.
const depthM = useModel ? 0.8 : 0.4;
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
    console.log(`Adding ${source} depth to the ${f} wall…`);
    const dataUrl = await page.evaluate(
      async ({ src, corners, aspect, useModel }) =>
        (await (useModel ? window.abb360Depth.estimateRelief : window.abb360Depth.structureRelief)(src, corners, aspect)).dataUrl,
      { src: `/demo/${config.facades[f].image}`, corners: config.facades[f].corners, aspect, useModel },
    );
    writeFileSync(new URL(`public/demo/assets/${f}-relief.png`, root), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  writeFileSync(new URL('public/demo/assets/relief.json', root), `${JSON.stringify({ source, depthM })}\n`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
execSync('npm run demo:config', { stdio: 'inherit', cwd: root });
console.log('Done. Check the demo page, then commit public/demo/assets/*-relief.png, relief.json and public/demo/building.json.');
