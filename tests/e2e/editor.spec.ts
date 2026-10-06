import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

type Config = {
  facades: Record<string, { image: string; corners: { tl: [number, number] } }>;
  apartments: { id: string; number: string; floor: number; status: string; planImage?: string }[];
  regions: { apartmentId: string; facade: string }[];
};

const status = (page: Page) => page.locator('abb360-editor footer.status');
const step = (page: Page, name: string) => page.locator('abb360-editor nav.steps button', { hasText: name }).click();
const tab = (page: Page, name: string) => page.locator('abb360-editor .tabs button', { hasText: name }).click();

/** Clicks the straightened wall at facade coordinates (u right, v down, 0..1). */
async function clickWall(page: Page, u: number, v: number) {
  const frame = page.locator('abb360-facade-view .frame');
  const box = await frame.boundingBox();
  if (!box) throw new Error('no facade view');
  await frame.click({ position: { x: u * box.width, y: v * box.height } });
}

test('editor round trip: corners, delete and re-create a corner stack, export, show in the widget', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the editor is a desktop tool');
  await page.goto('editor/index.html');
  await page.locator('abb360-editor').getByRole('button', { name: 'Load demo' }).click();
  await expect(status(page)).toContainText('Loaded the demo building');

  // Corners: nudge the front wall's top-left handle one step left with the keyboard.
  await step(page, 'Corners');
  await page.locator('abb360-corner-view .handle').first().focus();
  await page.keyboard.press('ArrowLeft');

  // Floors are already measured: 14 bands.
  await step(page, 'Floors');
  await expect(page.locator('abb360-editor #band-count')).toHaveValue('14');

  // Apartments: select 1203 on the front (level 12 band) and delete its whole stack (C).
  await step(page, 'Apartments');
  await tab(page, 'Front');
  await clickWall(page, 0.82, 0.132);
  await page.locator('abb360-editor').getByRole('button', { name: 'Delete its whole stack' }).click();
  await expect(status(page)).toContainText('Deleted 13 apartments');

  // Re-create it as a corner stack: front column 4 + right column 1, floors 1–13.
  await clickWall(page, 0.82, 0.5);
  await tab(page, 'Right side');
  await clickWall(page, 0.1, 0.5);
  await expect(page.locator('abb360-editor .selection')).toHaveText('Front column 4, Right side column 1');
  await expect(page.locator('abb360-editor #level-from')).toHaveValue('1');
  await expect(page.locator('abb360-editor #level-to')).toHaveValue('13');
  await page.locator('abb360-editor').getByRole('button', { name: 'Create apartments' }).click();
  await expect(status(page)).toContainText('Created 13 apartments: 103 … 1303');

  // Export and check the file.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('abb360-editor').getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('building.json');
  const exported = JSON.parse(await readFile((await download.path()) as string, 'utf8')) as Config;
  expect(exported.apartments).toHaveLength(104);
  expect(exported.facades.front?.image).toBe('assets/front.webp');
  expect(exported.facades.front?.corners.tl[0]).toBeCloseTo(0.19911, 5);
  expect(exported.apartments.filter((a) => a.number === '1203')).toHaveLength(1);
  expect(exported.apartments.every((a) => !a.planImage || a.planImage.startsWith('assets/'))).toBe(true);
  const newRegions = exported.regions.filter((r) => r.apartmentId === 'apt-1203').map((r) => r.facade);
  expect(newRegions.sort()).toEqual(['front', 'right']);

  // Show the exported config in the widget and tap one of the new apartments.
  await page.goto('demo/index.html');
  await page.waitForFunction(() => (window as unknown as { hostEvents: { type: string }[] }).hostEvents.some((e) => e.type === 'ready'));
  await page.evaluate((config) => {
    const el = document.querySelector('abb-building-360');
    if (el) el.config = config;
  }, exported);
  await page.waitForFunction(
    () => (window as unknown as { hostEvents: { type: string }[] }).hostEvents.filter((e) => e.type === 'ready').length === 2,
  );
  const pos = await page.evaluate(() => {
    const w = document.querySelector('abb-building-360');
    w?.openApartment('apt-1203');
    w?.closeApartment();
    return w?.getApartmentScreenPosition('apt-1203') ?? null;
  });
  expect(pos).not.toBeNull();
  await page.mouse.click(pos!.x, pos!.y);
  await expect(page.locator('abb-building-360 .panel h2')).toHaveText('Apartment 1203');
});

test('a new building from four photo files, with the draft restored after a reload', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the editor is a desktop tool');
  await page.goto('editor/index.html');
  const editor = page.locator('abb360-editor');
  const files = ['front', 'right', 'back', 'left'].map((f) => `public/demo/assets/${f}.webp`);
  for (const [i, file] of files.entries()) {
    await editor.locator('.photo').nth(i).locator('input[type=file]').setInputFiles(file);
  }
  await expect(editor.locator('.photo img')).toHaveCount(4);

  await step(page, 'Size');
  await editor.locator('#height').fill('42');
  await editor.locator('#height').dispatchEvent('change');
  await editor.getByRole('button', { name: 'Measure width and depth from the photos' }).click();
  await expect(status(page)).toContainText('Measured from the photos');

  await step(page, 'Floors');
  await editor.locator('#band-count').fill('4');
  await editor.getByRole('button', { name: 'Space evenly' }).click();
  await expect(status(page)).toContainText('4 floors, evenly spaced');

  await step(page, 'Columns');
  await tab(page, 'Front');
  await clickWall(page, 0.5, 0.5);
  await expect(page.locator('abb360-facade-view .divider-handle')).toHaveCount(1);

  await step(page, 'Apartments');
  await clickWall(page, 0.75, 0.5);
  await expect(editor.locator('.selection')).toHaveText('Front column 2');
  await page.locator('abb360-editor #level-from').fill('1');
  await page.locator('abb360-editor #level-from').dispatchEvent('change');
  await page.locator('abb360-editor #level-to').fill('3');
  await page.locator('abb360-editor #level-to').dispatchEvent('change');
  await editor.getByRole('button', { name: 'Create apartments' }).click();
  await expect(status(page)).toContainText('Created 3 apartments: 101 … 301');

  await editor.getByRole('button', { name: 'Preview as buyer' }).click();
  await expect(editor.locator('abb-building-360 .legend')).toContainText('Available 3');
  await editor.getByRole('button', { name: 'Close' }).click();

  // The draft survives a reload; local photos have to be picked again.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(status(page)).toContainText('Restored your last draft');
  await expect(editor.locator('.photo .thumb').first()).toContainText('Pick front.webp again');
  await step(page, 'Details');
  await expect(page.locator('abb360-apartment-table tbody tr')).toHaveCount(3);
});

test('depth: estimate all walls with the real runtime (stand-in model), tune strength, export', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the editor is a desktop tool');
  // A tiny model with Depth Anything's input and output, served instead of the 27 MB download.
  await page.addInitScript(() => {
    (window as unknown as { abb360DepthModelUrl: string }).abb360DepthModelUrl = 'https://models.test/stand-in.onnx';
  });
  const model = await readFile('tests/fixtures/stand-in-depth.onnx');
  await page.route('https://models.test/stand-in.onnx', (route) => route.fulfill({ body: model, contentType: 'application/octet-stream' }));

  await page.goto('editor/index.html');
  const editor = page.locator('abb360-editor');
  await editor.getByRole('button', { name: 'Load demo' }).click();
  await expect(status(page)).toContainText('Loaded the demo building');
  await step(page, 'Depth');
  await editor.getByRole('button', { name: 'Estimate all four walls' }).click();
  await expect(status(page)).toContainText('Depth added to 4 walls', { timeout: 60_000 });
  await expect(editor.locator('img.relief')).toBeVisible();

  const strength = editor.locator('#depth-strength');
  await strength.fill('1.5');
  await strength.dispatchEvent('input');
  await expect(editor.getByText('Strength: 1.5 m')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Export JSON' }).click();
  const exported = JSON.parse(await readFile((await (await downloadPromise).path()) as string, 'utf8')) as {
    facades: Record<string, { relief?: { image: string; depthM: number } }>;
  };
  for (const f of ['front', 'right', 'back', 'left']) {
    expect(exported.facades[f]?.relief?.image).toMatch(/^data:image\/png;base64,/);
  }
  expect(exported.facades.front?.relief?.depthM).toBe(1.5);
  expect(exported.facades.right?.relief?.depthM).toBe(0.8);
});
