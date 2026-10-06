import { chromium } from '@playwright/test';
const [out, zoom] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
await p.goto('http://localhost:4180/demo/');
await p.waitForFunction(() => document.querySelector('abb-building-360')?.building, null, { timeout: 60000 });
await p.waitForTimeout(2000);
await p.evaluate(() => document.querySelector('abb-building-360').setAttribute('availability','hidden'));
const box = await p.locator('abb-building-360').boundingBox();
await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < Number(zoom || 0); i++) { await p.keyboard.down('Control'); await p.mouse.wheel(0, -200); await p.keyboard.up('Control'); await p.waitForTimeout(100); }
await p.waitForTimeout(1500);
await p.locator('abb-building-360').screenshot({ path: out });
await b.close();
