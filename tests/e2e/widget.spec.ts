import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

type HostEvent = { type: string; detail: { apartmentId?: string; apartments?: number } | null };

async function waitReady(page: Page) {
  await page.waitForFunction(() => (window as unknown as { hostEvents?: HostEvent[] }).hostEvents?.some((e) => e.type === 'ready'));
}

function events(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { hostEvents: HostEvent[] }).hostEvents.filter((e) => e.type !== 'apartment-hover'),
  );
}

/** Turns the camera to an apartment (no events), closes the panel and returns where it is on screen. */
async function aimAt(page: Page, id: string) {
  const pos = await page.evaluate((apartmentId) => {
    const w = document.querySelector('abb-building-360');
    if (!w) return null;
    w.openApartment(apartmentId);
    w.closeApartment();
    return w.getApartmentScreenPosition(apartmentId);
  }, id);
  expect(pos, `apartment ${id} should be on screen`).not.toBeNull();
  return pos as { x: number; y: number };
}

async function tap(page: Page, x: number, y: number, isMobile: boolean) {
  if (isMobile) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

const widget = (page: Page) => page.locator('abb-building-360');

test.describe('example host page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('demo/index.html');
    await waitReady(page);
  });

  test('loads the demo building and reports ready', async ({ page }) => {
    const ready = (await events(page)).find((e) => e.type === 'ready');
    expect(ready?.detail?.apartments).toBe(104);
    await expect(widget(page).locator('.legend')).toContainText('Available');
  });

  test('tap opens the details panel, Select notifies the host page', async ({ page, isMobile }) => {
    const pos = await aimAt(page, 'apt-1203');
    await tap(page, pos.x, pos.y, isMobile);
    const panel = widget(page).locator('.panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('h2')).toHaveText('Apartment 1203');
    expect((await events(page)).filter((e) => e.type === 'apartment-preview').map((e) => e.detail?.apartmentId)).toEqual([
      'apt-1203',
    ]);

    await panel.getByRole('button', { name: 'Select apartment' }).click();
    const select = (await events(page)).filter((e) => e.type === 'apartment-select');
    expect(select.map((e) => e.detail?.apartmentId)).toEqual(['apt-1203']);
    await expect(page.locator('#selection')).toContainText('Apartment 1203');
  });

  test('sold apartments show their details but cannot be selected', async ({ page }) => {
    const soldId = await page.evaluate(
      () => document.querySelector('abb-building-360')?.building?.apartments.find((a) => a.status === 'sold')?.id,
    );
    expect(soldId).toBeTruthy();
    await page.evaluate((id) => document.querySelector('abb-building-360')?.openApartment(id as string), soldId);
    const button = widget(page).locator('.panel .primary');
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('Sold');
  });

  test('host calls emit no events (no loops between host and widget)', async ({ page }) => {
    const before = (await events(page)).length;
    await page.getByRole('button', { name: 'Open apartment 1203' }).click();
    await expect(widget(page).locator('.panel h2')).toHaveText('Apartment 1203');
    await page.getByRole('button', { name: 'Mark 1203 as sold' }).click();
    await expect(widget(page).locator('.panel .badge')).toHaveText('Sold');
    expect((await events(page)).length).toBe(before);
  });

  test('a filter dims non-matching apartments and makes them untappable', async ({ page, isMobile }) => {
    const soldId = (await page.evaluate(
      () => document.querySelector('abb-building-360')?.building?.apartments.find((a) => a.status === 'sold' && a.floor > 3)?.id,
    )) as string;
    const pos = await aimAt(page, soldId);
    await page.getByRole('button', { name: 'Only available' }).click();
    await tap(page, pos.x, pos.y, isMobile);
    const previews = (await events(page)).filter((e) => e.type === 'apartment-preview');
    expect(previews.map((e) => e.detail?.apartmentId)).not.toContain(soldId);
  });

  test('the front wall is drawn from the photo, not left blank', async ({ page }) => {
    const pos = await aimAt(page, 'apt-602');
    const box = await widget(page).boundingBox();
    if (!box) throw new Error('no widget box');
    const png = PNG.sync.read(await page.screenshot({ clip: box }));
    const scale = png.width / box.width;
    const pixel = (x: number, y: number) => {
      const i = (Math.round(y * scale) * png.width + Math.round(x * scale)) * 4;
      return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
    };
    const bg = pixel(4, 4);
    let differing = 0;
    for (let dx = -20; dx <= 20; dx += 4) {
      for (let dy = -10; dy <= 10; dy += 4) {
        const p = pixel(pos.x - box.x + dx, pos.y - box.y + dy);
        if (Math.abs(p[0]! - bg[0]!) + Math.abs(p[1]! - bg[1]!) + Math.abs(p[2]! - bg[2]!) > 40) differing++;
      }
    }
    expect(differing).toBeGreaterThan(20);
  });
});

test.describe('living inside a host page', () => {
  test('a plain mouse wheel scrolls the page; Ctrl + wheel zooms instead', async ({ page, isMobile }) => {
    test.skip(isMobile, 'mouse wheel only');
    await page.goto('demo/index.html');
    await waitReady(page);
    const pos = await aimAt(page, 'apt-602');
    await page.mouse.move(pos.x, pos.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -400);
    await page.keyboard.up('Control');
    await expect
      .poll(() => page.evaluate(() => document.querySelector('abb-building-360')?.getApartmentScreenPosition('apt-602')?.y))
      .not.toBeCloseTo(pos.y, 0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('a vertical swipe over the widget scrolls the page; a sideways swipe rotates it', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch only');
    await page.goto('demo/index.html');
    await waitReady(page);
    const box = await widget(page).boundingBox();
    if (!box) throw new Error('no widget box');
    const cdp = await page.context().newCDPSession(page);
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    // Raw touch events: the browser decides between page scroll and pointer events from touch-action.
    const swipe = async (dx: number, dy: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * dx, y: y + i * dy }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };

    await swipe(0, -20);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);

    await page.evaluate(() => window.scrollTo(0, 0));
    const at = () => page.evaluate(() => document.querySelector('abb-building-360')?.getApartmentScreenPosition('apt-602'));
    const before = await at();
    await swipe(15, 0);
    await expect.poll(async () => JSON.stringify(await at())).not.toBe(JSON.stringify(before));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('the classic <script> embed works and survives 20 mount/destroy cycles', async ({ page, isMobile }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (/WebGL|context/i.test(m.text())) warnings.push(m.text());
    });
    await page.goto('demo/embed-iife.html');
    await waitReady(page);
    const pos = await aimAt(page, 'apt-1203');
    await tap(page, pos.x, pos.y, isMobile);
    await widget(page).locator('.panel').getByRole('button', { name: 'Select apartment' }).click();
    expect((await events(page)).some((e) => e.type === 'apartment-select' && e.detail?.apartmentId === 'apt-1203')).toBe(
      true,
    );

    const cycles = await page.evaluate(async () => {
      const api = (window as unknown as {
        AbbBuilding360: { mount: (el: HTMLElement, o: object) => { destroy(): void } };
      }).AbbBuilding360;
      const host = document.createElement('div');
      host.style.width = '480px';
      document.body.append(host);
      let done = 0;
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve, reject) => {
          const instance = api.mount(host, {
            configUrl: 'building.json',
            onReady: () => {
              instance.destroy();
              resolve();
            },
            onError: (e: unknown) => reject(new Error(JSON.stringify(e))),
          });
        });
        done++;
      }
      return done;
    });
    expect(cycles).toBe(20);
    expect(warnings).toEqual([]);
  });
});

test.describe('live data from the host', () => {
  test.skip(({ isMobile }) => isMobile, 'same code path on every viewport');

  const statusOf = (page: Page, id: string) =>
    page.evaluate((apartmentId) => document.querySelector('abb-building-360')?.building?.apartments.find((a) => a.id === apartmentId)?.status, id);
  const readyCount = (page: Page) =>
    page.evaluate(() => (window as unknown as { hostEvents: HostEvent[] }).hostEvents.filter((e) => e.type === 'ready').length);

  test('updates sent while the photos are still loading are applied', async ({ page }) => {
    await page.route('**/demo/assets/*.webp', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto('demo/index.html');
    await page.waitForFunction(() => document.querySelector('abb-building-360')?.shadowRoot?.querySelector('.state'));
    await page.evaluate(() => document.querySelector('abb-building-360')?.setApartments([{ id: 'apt-1203', status: 'sold' }]));
    await waitReady(page);
    expect(await statusOf(page, 'apt-1203')).toBe('sold');
  });

  test('updates survive the widget being detached and re-attached', async ({ page }) => {
    await page.goto('demo/index.html');
    await waitReady(page);
    await page.evaluate(() => document.querySelector('abb-building-360')?.setApartments([{ id: 'apt-1203', status: 'sold' }]));
    await page.evaluate(async () => {
      const el = document.querySelector('abb-building-360');
      const parent = el?.parentElement;
      if (!el || !parent) return;
      el.remove();
      await new Promise((r) => setTimeout(r, 50));
      parent.prepend(el);
    });
    await expect.poll(() => readyCount(page)).toBe(2);
    expect(await statusOf(page, 'apt-1203')).toBe('sold');
  });

  test('switching to another building starts its live data fresh', async ({ page }) => {
    await page.goto('demo/index.html');
    await waitReady(page);
    const original = await statusOf(page, 'apt-1204');
    const unknown = await page.evaluate(() => {
      const el = document.querySelector('abb-building-360');
      el?.setApartments([{ id: 'apt-1204', status: 'sold' }]);
      if (el) el.configUrl = 'building.json?next';
      return el?.setApartments([{ id: 'apt-1203', status: 'reserved' }]);
    });
    expect(unknown).toEqual([]);
    await expect.poll(() => readyCount(page)).toBe(2);
    expect(await statusOf(page, 'apt-1203')).toBe('reserved');
    expect(await statusOf(page, 'apt-1204')).toBe(original);
  });

  test('wheel events over the widget still reach the host page', async ({ page }) => {
    await page.goto('demo/index.html');
    await waitReady(page);
    await page.evaluate(() => {
      (window as unknown as { wheels: number }).wheels = 0;
      window.addEventListener('wheel', () => (window as unknown as { wheels: number }).wheels++);
    });
    const box = await widget(page).boundingBox();
    if (!box) throw new Error('no widget box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => page.evaluate(() => (window as unknown as { wheels: number }).wheels)).toBeGreaterThan(0);
  });
});

test.describe('depth and the plain view', () => {
  test.skip(({ isMobile }) => isMobile, 'same code path on every viewport');

  test('the legend switch hides the status colours, and the attribute sets the start', async ({ page }) => {
    await page.goto('demo/index.html');
    await waitReady(page);
    const sw = widget(page).locator('.switch');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(widget(page).locator('.statuses')).toHaveClass(/off/);
    // Buyers' toggling is private to the widget: no events for the host.
    expect((await events(page)).map((e) => e.type)).toEqual(['ready']);

    await page.evaluate(() => document.querySelector('abb-building-360')?.setAttribute('availability', 'hidden'));
    await page.evaluate(() => document.querySelector('abb-building-360')?.setAttribute('availability', 'shown'));
    await expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  test('walls with relief still open and select apartments', async ({ page, isMobile }) => {
    await page.goto('demo/index.html');
    await waitReady(page);
    await page.evaluate(() => {
      const el = document.querySelector('abb-building-360');
      if (!el?.building) return;
      const cfg = structuredClone(el.building);
      for (const f of ['front', 'right', 'back', 'left'] as const) {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 96;
        const ctx = c.getContext('2d');
        if (!ctx) continue;
        const g = ctx.createLinearGradient(0, 0, 64, 0);
        g.addColorStop(0, '#808080');
        g.addColorStop(0.5, '#ffffff');
        g.addColorStop(1, '#808080');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 64, 96);
        cfg.facades[f].relief = { image: c.toDataURL('image/png'), depthM: 0.8 };
      }
      el.config = cfg;
    });
    await page.waitForFunction(
      () => (window as unknown as { hostEvents: HostEvent[] }).hostEvents.filter((e) => e.type === 'ready').length === 2,
    );
    const pos = await aimAt(page, 'apt-1203');
    await tap(page, pos.x, pos.y, isMobile);
    await expect(widget(page).locator('.panel h2')).toHaveText('Apartment 1203');
    await widget(page).locator('.panel').getByRole('button', { name: 'Select apartment' }).click();
    expect((await events(page)).filter((e) => e.type === 'apartment-select').map((e) => e.detail?.apartmentId)).toEqual(['apt-1203']);
  });
});

test.describe('building shapes', () => {
  test('an L-shaped building opens and selects an apartment on its recessed walls', async ({ page, isMobile }) => {
    await page.goto('demo/index.html');
    await waitReady(page);
    await page.evaluate(() => {
      const el = document.querySelector('abb-building-360');
      if (!el?.building) return;
      const cfg = structuredClone(el.building);
      const { width, depth, height } = cfg.dimensions;
      // The back-right quarter is missing: the right wall steps in to x = 12 m behind d = 10 m.
      cfg.massing = { blocks: [{ polygon: [[0, 0], [width, 0], [width, 10], [12, 10], [12, depth], [0, depth]], height }] };
      el.config = cfg;
    });
    await page.waitForFunction(
      () => (window as unknown as { hostEvents: HostEvent[] }).hostEvents.filter((e) => e.type === 'ready').length === 2,
    );
    // Stack E wraps the north-east corner: on the L both its walls are the recessed ones.
    const pos = await aimAt(page, 'apt-1105');
    await tap(page, pos.x, pos.y, isMobile);
    await expect(widget(page).locator('.panel h2')).toHaveText('Apartment 1105');
    await widget(page).locator('.panel').getByRole('button', { name: 'Select apartment' }).click();
    expect((await events(page)).filter((e) => e.type === 'apartment-select').map((e) => e.detail?.apartmentId)).toEqual(['apt-1105']);
  });
});
