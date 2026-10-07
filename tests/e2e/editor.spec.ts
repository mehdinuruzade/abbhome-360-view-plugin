import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('depth from the photos: all four walls, instantly and offline, then export', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the editor is a desktop tool');
  // Nothing may be downloaded for structure depth.
  await page.route('**/*.onnx', (route) => route.abort());
  await page.goto('editor/index.html');
  const editor = page.locator('abb360-editor');
  await editor.getByRole('button', { name: 'Load demo' }).click();
  await expect(status(page)).toContainText('Loaded the demo building');
  await step(page, 'Depth');
  for (const f of ['Front', 'Right', 'Back', 'Left']) {
    await editor.getByRole('tab', { name: f }).click();
    await editor.getByRole('button', { name: 'Remove depth from this wall' }).click();
  }
  await expect(editor.locator('img.relief')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Add depth from the photos' }).click();
  await expect(status(page)).toContainText('Depth added to 4 walls', { timeout: 30_000 });
  await expect(editor.locator('img.relief')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Export JSON' }).click();
  const exported = JSON.parse(await readFile((await (await downloadPromise).path()) as string, 'utf8')) as {
    facades: Record<string, { relief?: { image: string; depthM: number; source?: string } }>;
  };
  for (const f of ['front', 'right', 'back', 'left']) {
    expect(exported.facades[f]?.relief?.image).toMatch(/^data:image\/png;base64,/);
    expect(exported.facades[f]?.relief?.source).toBe('structure');
    expect(exported.facades[f]?.relief?.depthM).toBe(0.4);
  }
});

test('depth: refine all walls with the real AI runtime (stand-in model), tune strength, export', async ({ page, isMobile }) => {
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
  await editor.getByRole('button', { name: 'Refine with AI (27 MB download)' }).click();
  await expect(status(page)).toContainText('Depth added to 4 walls', { timeout: 60_000 });
  await expect(editor.locator('img.relief')).toBeVisible();

  const strength = editor.locator('#depth-strength');
  await strength.fill('1.5');
  await strength.dispatchEvent('input');
  await expect(editor.getByText('Strength: 1.50 m')).toBeVisible();

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

test('shape: an L template, a dragged corner, a podium block, resize, export', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the editor is a desktop tool');
  page.on('dialog', (d) => void d.accept());
  await page.goto('editor/index.html');
  const editor = page.locator('abb360-editor');
  await editor.getByRole('button', { name: 'Load demo' }).click();
  await expect(status(page)).toContainText('Loaded the demo building');
  await step(page, 'Shape');
  const view = page.locator('abb360-shape-view');
  // The demo's own shape: one notched block, its photos laid round the plan.
  await expect(view.locator('polygon')).toHaveCount(1);
  await expect(view.locator('image')).toHaveCount(4);

  await editor.getByRole('button', { name: 'L', exact: true }).click();
  await expect(status(page)).toContainText('Template applied');
  const corners = view.locator('circle.corner');
  await expect(corners).toHaveCount(6);

  // Drag the inner corner (x = W/2, d = D/2) a little towards the front-right.
  const inner = await corners.nth(3).boundingBox();
  if (!inner) throw new Error('no corner');
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 20, { steps: 5 });
  await page.mouse.up();
  await expect(editor.locator('#corner-x')).not.toHaveValue('14.7');
  const movedX = Number(await editor.locator('#corner-x').inputValue());
  expect(movedX).toBeGreaterThan(14.7);

  // Type an exact depth for that corner.
  await editor.locator('#corner-d').fill('9');
  await editor.locator('#corner-d').dispatchEvent('change');

  // A tower on the L: a second block, 30 m tall.
  await editor.getByRole('button', { name: 'Add block' }).click();
  await expect(view.locator('polygon')).toHaveCount(2);
  await editor.locator('#block-height').fill('30');
  await editor.locator('#block-height').dispatchEvent('change');

  // Doubling the width stretches the shape with it.
  await step(page, 'Size');
  const width = editor.getByLabel('Width, front and back (m)');
  const w0 = Number(await width.inputValue());
  await width.fill(String(w0 * 2));
  await width.dispatchEvent('change');

  const downloadPromise = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Export JSON' }).click();
  const exported = JSON.parse(await readFile((await (await downloadPromise).path()) as string, 'utf8')) as {
    dimensions: { width: number; depth: number; height: number };
    massing?: { blocks: { polygon: [number, number][]; height: number }[] };
  };
  const blocks = exported.massing?.blocks ?? [];
  expect(blocks).toHaveLength(2);
  expect(blocks[0]?.polygon).toHaveLength(6);
  const corner = blocks[0]?.polygon[3] as [number, number];
  expect(corner[0]).toBeCloseTo(movedX * 2, 1);
  expect(corner[1]).toBe(9);
  expect(blocks[1]?.height).toBe(30);
  expect(Math.max(...(blocks[0]?.polygon.map((p) => p[0]) ?? []))).toBeCloseTo(exported.dimensions.width, 1);
});

test.describe('opening a folder', () => {
  test.skip(({ isMobile }) => isMobile, 'the editor is a desktop tool');

  test('a folder of photos goes on the walls by their names; other files are left out', async ({ page }) => {
    const dir = await mkdtemp(join(tmpdir(), 'abb360-photos-'));
    // Deliberately out of order on disk and by name: the wall words decide.
    await copyFile('public/demo/assets/front.webp', join(dir, '3 Front.webp'));
    await copyFile('public/demo/assets/right.webp', join(dir, 'right side.webp'));
    await copyFile('public/demo/assets/back.webp', join(dir, '1 back.webp'));
    await copyFile('public/demo/assets/left.webp', join(dir, 'LEFT.webp'));
    await copyFile('public/demo/assets/front.webp', join(dir, 'cover.webp'));
    await writeFile(join(dir, '.DS_Store'), 'x');
    await writeFile(join(dir, 'notes.txt'), 'x');

    await page.goto('editor/index.html');
    const editor = page.locator('abb360-editor');
    await editor.locator('section.work input[webkitdirectory]').setInputFiles(dir);
    await expect(status(page)).toContainText('Photos added: front ← 3 Front.webp');
    await expect(status(page)).toContainText('back ← 1 back.webp');
    await expect(status(page)).toContainText('Not used: cover.webp.');
    await expect(editor.locator('.photo .thumb img')).toHaveCount(4);
    await expect(editor.locator('.photo .ref')).toHaveText(['3 Front.webp', 'right side.webp', '1 back.webp', 'LEFT.webp']);
  });

  test('an exported building folder opens with its photos, no picking again', async ({ page }) => {
    page.on('dialog', (d) => void d.accept());
    await page.goto('editor/index.html');
    const editor = page.locator('abb360-editor');
    await editor.getByRole('button', { name: 'Load demo' }).click();
    await expect(status(page)).toContainText('Loaded the demo building');
    const downloadPromise = page.waitForEvent('download');
    await editor.getByRole('button', { name: 'Export JSON' }).click();
    const json = await readFile((await (await downloadPromise).path()) as string, 'utf8');

    // The folder as it would be uploaded: building.json next to its assets, inside a named folder.
    const root = await mkdtemp(join(tmpdir(), 'abb360-export-'));
    const dir = join(root, 'Demo residence');
    await mkdir(join(dir, 'assets', 'plans'), { recursive: true });
    await writeFile(join(dir, 'building.json'), json);
    for (const f of ['front', 'right', 'back', 'left']) {
      await copyFile(`public/demo/assets/${f}.webp`, join(dir, 'assets', `${f}.webp`));
      await copyFile(`public/demo/assets/${f}-relief.png`, join(dir, 'assets', `${f}-relief.png`));
    }
    for (const plan of ['plan-2-room.svg', 'plan-3-room.svg']) {
      await copyFile(`public/demo/assets/plans/${plan}`, join(dir, 'assets', 'plans', plan));
    }

    await editor.getByRole('button', { name: 'New' }).click();
    await editor.locator('header input[webkitdirectory]').setInputFiles(dir);
    await expect(status(page)).toContainText('Imported building.json.');
    await expect(status(page)).not.toContainText('Pick the photos again');
    await step(page, 'Photos');
    await expect(editor.locator('.photo .thumb img')).toHaveCount(4);
    await step(page, 'Details');
    await expect(page.locator('abb360-apartment-table tbody tr')).toHaveCount(104);
  });

  test('photos dropped on the page go on the walls', async ({ page }) => {
    await page.goto('editor/index.html');
    await page.evaluate(async () => {
      const dt = new DataTransfer();
      for (const [name, f] of [['b-left.webp', 'left'], ['a-front.webp', 'front'], ['c-back.webp', 'back'], ['d-right.webp', 'right']]) {
        const blob = await (await fetch(new URL(`../demo/assets/${f}.webp`, location.href))).blob();
        dt.items.add(new File([blob], name as string, { type: 'image/webp' }));
      }
      document.querySelector('abb360-editor')?.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(status(page)).toContainText('Photos added: front ← a-front.webp, right side ← d-right.webp, back ← c-back.webp, left side ← b-left.webp.');
  });
});
