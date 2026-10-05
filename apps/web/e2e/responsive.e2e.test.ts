import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * R1-E responsive parity (production UI programme): every brand screen and the portfolio at four widths (phone,
 * tablet, small laptop, desktop) without horizontal scrolling, at 200% zoom, and with long company and brand names;
 * the navigation reached by keyboard alone; focus restored when the drawer closes; reduced motion honoured.
 * Opt-in like the other smokes (OREMEDIA_E2E=1 against the built app).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const WIDTHS = [390, 768, 1024, 1440] as const;
const brandPath = (rest: string) =>
  `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;

interface Screen {
  name: string;
  path: string;
  /** Resolves once the screen's own content is on the page (not just the shell). */
  ready: (page: Page) => Promise<unknown>;
}
const h1 = (page: Page) => page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 15_000 });
const SCREENS: Screen[] = [
  {
    name: 'portfolio',
    path: '/portfolio',
    ready: (p) => p.getByRole('list', { name: 'Companies' }).waitFor(),
  },
  {
    name: 'portfolio performance',
    path: '/portfolio/performance',
    ready: (p) => p.getByTestId('company-performance').first().waitFor(),
  },
  {
    name: 'company',
    path: `/c/${encodeURIComponent(E2E.tenantId)}`,
    ready: (p) => p.getByRole('list', { name: 'Brands' }).waitFor(),
  },
  { name: 'brand home', path: brandPath('home'), ready: (p) => p.getByTestId('needs-you').waitFor() },
  { name: 'review', path: brandPath('review'), ready: h1 },
  { name: 'calendar', path: brandPath('calendar'), ready: h1 },
  { name: 'campaigns', path: brandPath('campaigns'), ready: h1 },
  { name: 'studio documents', path: brandPath('studio'), ready: h1 },
  {
    name: 'performance',
    path: brandPath('performance'),
    ready: (p) => p.getByRole('group', { name: 'Metric' }).waitFor(),
  },
  { name: 'inbox', path: brandPath('inbox'), ready: h1 },
  { name: 'intelligence', path: brandPath('intelligence'), ready: h1 },
  { name: 'experiments', path: brandPath('experiments'), ready: h1 },
  { name: 'agents', path: brandPath('agents'), ready: h1 },
  { name: 'brand system', path: brandPath('system'), ready: h1 },
  { name: 'assets', path: brandPath('assets'), ready: h1 },
  { name: 'settings', path: brandPath('settings'), ready: (p) => p.getByTestId('channels').waitFor() },
  {
    name: 'settings policy',
    path: brandPath('settings?tab=policy'),
    ready: (p) => p.getByTestId('release-policy').waitFor(),
  },
];

/** The page's own width overflow: anything wider than the viewport scrolls sideways (spec 21.3 reflow). */
const overflow = (page: Page) =>
  page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    // The widest element that pokes out of the viewport, named so a failure says where.
    offenders: [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.right > window.innerWidth + 1) || getComputedStyle(el).position === 'fixed')
          return false;
        // Clipped by an ancestor: it cannot widen the page, so it is not the cause.
        for (let p = el.parentElement; p; p = p.parentElement)
          if (/hidden|clip|auto|scroll/.test(getComputedStyle(p).overflowX)) return false;
        return true;
      })
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].slice(0, 4).join('.')}`,
      ),
  }));

describe.skipIf(!enabled)('responsive parity (built app in Chromium, mock transport)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;

  const signedIn = async (
    width: number,
    options: { reducedMotion?: 'reduce' | 'no-preference' } = {},
  ): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext({
      viewport: { width, height: width < 500 ? 844 : 900 },
      timezoneId: 'UTC',
      reducedMotion: options.reducedMotion ?? 'reduce',
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
    return { context, page };
  };
  const open = async (page: Page, screen: Screen) => {
    await page.goto(`${origin}${screen.path}`);
    await screen.ready(page);
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, {
      timeout: 15_000,
    });
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  for (const width of WIDTHS)
    describe(`${width} px`, () => {
      let context: BrowserContext;
      let page: Page;
      beforeAll(async () => {
        ({ context, page } = await signedIn(width));
      }, 60_000);
      afterAll(async () => {
        await context?.close();
      });

      it.each(SCREENS.map((s) => [s.name, s] as const))(
        '%s: no horizontal scrolling, one h1, the shell for this width',
        async (name, screen) => {
          await open(page, screen);
          const o = await overflow(page);
          expect(
            o.scrollWidth,
            `${name} at ${width}px overflows: ${o.offenders.join(', ')}`,
          ).toBeLessThanOrEqual(o.innerWidth);
          expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
          if (screen.path.startsWith('/c/') && screen.path.includes('/b/')) {
            // Spec 11.1: the sidebar from 1024 px; below it the top bar names company and brand and opens a drawer.
            const sidebar = page.getByRole('complementary', { name: 'Brand navigation' });
            const menu = page.getByRole('button', { name: 'Menu' });
            expect(await sidebar.isVisible()).toBe(width >= 1024);
            expect(await menu.isVisible()).toBe(width < 1024);
          }
        },
        45_000,
      );
    });

  it('at 200% browser zoom on a 1440 px desktop (a 720 px CSS viewport) the brand home, calendar and settings reflow without horizontal scrolling', async () => {
    // Browser zoom halves the CSS viewport, so media queries and layout both see 720 px; a CSS `zoom` would not.
    const { context, page } = await signedIn(1440);
    await page.setViewportSize({ width: 720, height: 450 });
    for (const screen of SCREENS.filter((s) => ['brand home', 'calendar', 'settings'].includes(s.name))) {
      await open(page, screen);
      const o = await overflow(page);
      expect(
        o.scrollWidth,
        `${screen.name} at 200% zoom overflows: ${o.offenders.join(', ')}`,
      ).toBeLessThanOrEqual(o.innerWidth);
      expect(await page.getByRole('button', { name: 'Menu' }).isVisible()).toBe(true);
    }
    await context.close();
  }, 60_000);

  it('long company and brand names stay inside the shell at every width', async () => {
    const brand = backend.brands.find((b) => b.id === E2E.brandId)!;
    // The company name is fixed for the other suites; this one renames it for the duration of the test.
    const names = backend as { companyName: string };
    const nameBefore = brand.name;
    const companyBefore = names.companyName;
    brand.name = 'The Northern Hemisphere Collective for Artisanal Lamps and Lighting Design Studio';
    names.companyName = 'Consolidated Holdings of Very Long Company Names International Limited';
    try {
      for (const width of WIDTHS) {
        const { context, page } = await signedIn(width);
        await open(
          page,
          SCREENS.find((s) => s.name === 'brand home')!,
        );
        const o = await overflow(page);
        expect(
          o.scrollWidth,
          `brand home at ${width}px with long names overflows: ${o.offenders.join(', ')}`,
        ).toBeLessThanOrEqual(o.innerWidth);
        await context.close();
      }
    } finally {
      brand.name = nameBefore;
      names.companyName = companyBefore;
    }
  }, 90_000);

  it('keyboard only: Tab reaches the brand navigation and Enter opens a section; the drawer returns focus to Menu', async () => {
    const { context, page } = await signedIn(1024);
    await open(
      page,
      SCREENS.find((s) => s.name === 'brand home')!,
    );
    // Walk the Tab order until the Calendar link in the sidebar has focus, then Enter.
    // A nav link's text carries its count badge when the section has one, so match the label at the start.
    let focused = '';
    const stops: string[] = [];
    for (let i = 0; i < 80 && !/^Calendar/.test(focused); i += 1) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? '',
      );
      stops.push(focused);
    }
    expect(focused, `Tab stops: ${stops.join(' | ')}`).toMatch(/^Calendar/);
    await page.keyboard.press('Enter');
    await page.waitForURL('**/calendar*', { timeout: 15_000 });
    await context.close();

    const phone = await signedIn(390);
    await open(
      phone.page,
      SCREENS.find((s) => s.name === 'brand home')!,
    );
    const menu = phone.page.getByRole('button', { name: 'Menu' });
    await menu.focus();
    await phone.page.keyboard.press('Enter');
    const drawer = phone.page.getByRole('dialog', { name: 'Brand navigation' });
    await drawer.waitFor({ timeout: 15_000 });
    await phone.page.keyboard.press('Escape');
    await expect.poll(() => drawer.count()).toBe(0);
    // Radix's focus scope hands focus back to the trigger on a zero-delay timer after the dialog unmounts, so the
    // dialog can be gone a tick before focus returns: wait for it rather than reading it once.
    await expect
      .poll(() =>
        phone.page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label')),
      )
      .toBe('Menu');
    await phone.context.close();
  }, 60_000);

  it('reduced motion: no transition or animation runs longer than the stylesheet allows', async () => {
    const { context, page } = await signedIn(390, { reducedMotion: 'reduce' });
    await open(
      page,
      SCREENS.find((s) => s.name === 'brand home')!,
    );
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('dialog', { name: 'Brand navigation' }).waitFor({ timeout: 15_000 });
    const longest = await page.evaluate(() => {
      const ms = (v: string) => (v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);
      let max = 0;
      for (const el of document.querySelectorAll<HTMLElement>('body *')) {
        const s = getComputedStyle(el);
        for (const v of [...s.transitionDuration.split(','), ...s.animationDuration.split(',')])
          max = Math.max(max, ms(v.trim()) || 0);
      }
      return max;
    });
    expect(longest).toBeLessThanOrEqual(0.01);
    await context.close();
  }, 45_000);
});
