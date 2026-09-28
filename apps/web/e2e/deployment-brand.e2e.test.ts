import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { auditPage, formatViolations } from './a11y';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * D-12 deployment branding in the built app: the pack the web server names (OREMEDIA_DEPLOYMENT_BRAND) sets the
 * product name, the chrome's tokens and the logo before the first render; no pack, or a key with no pack, is the
 * neutral brand. The Ore & Tar pack passes the same audit as the neutral tokens (contrast included) in both themes.
 * Opt-in like the other smokes.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

describe.skipIf(!enabled)('deployment brand packs (built app in Chromium, mock transport)', () => {
  const backend = new MockBackend();
  const servers: Array<() => Promise<void>> = [];
  const origins: Record<string, string> = {};
  let browser: Browser;

  const open = async (pack: string, theme: 'light' | 'dark', path = '/sign-in'): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('oremedia.theme', t);
      } catch {
        // storage blocked: the colour scheme preference still applies
      }
    }, theme);
    const page = await context.newPage();
    await page.goto(`${origins[pack]}${path}`);
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15_000 });
    return page;
  };
  const token = (page: Page, name: string) =>
    page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    for (const pack of ['oremedia', 'ore-and-tar', 'no-such-pack']) {
      const served = await startStaticServer({
        dist,
        trpcHandler: createMockHandler(backend),
        deploymentBrand: pack,
      });
      origins[pack] = served.origin;
      servers.push(served.close);
    }
    browser = await chromium.launch(launchOptions);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    for (const close of servers) await close();
  });

  it('the neutral pack, and a key with no pack, show the product name and no logo', async () => {
    for (const pack of ['oremedia', 'no-such-pack']) {
      const page = await open(pack, 'light');
      await expect(page.title()).resolves.toBe('Oremedia');
      await expect(page.getByRole('heading', { level: 1 }).textContent()).resolves.toBe(
        'Sign in to Oremedia',
      );
      expect(await page.getByRole('img', { name: 'Oremedia' }).count()).toBe(0);
      await page.context().close();
    }
  });

  it('the Ore & Tar pack names the deployment, applies its tokens and shows the logo for the theme', async () => {
    const light = await open('ore-and-tar', 'light');
    await expect(light.title()).resolves.toBe('Ore & Tar');
    await expect(light.getByRole('heading', { level: 1 }).textContent()).resolves.toBe(
      'Sign in to Ore & Tar',
    );
    await expect(token(light, '--primary')).resolves.toBe('oklch(0.25 0.05 260)');
    await expect(light.locator('.deployment-logo-light').isVisible()).resolves.toBe(true);
    await expect(light.locator('.deployment-logo-dark').isVisible()).resolves.toBe(false);
    await light.context().close();

    const dark = await open('ore-and-tar', 'dark');
    await expect(token(dark, '--primary')).resolves.toBe('oklch(0.72 0.12 190)');
    await expect(dark.locator('.deployment-logo-dark').isVisible()).resolves.toBe(true);
    await expect(dark.locator('.deployment-logo-light').isVisible()).resolves.toBe(false);
    await dark.context().close();
  });

  it('the Ore & Tar legal pages name the controller, link to each other and pass the audit; the neutral pack has none', async () => {
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme });
      const page = await context.newPage();
      for (const path of ['/legal/privacy', '/legal/data-deletion']) {
        const res = await page.goto(`${origins['ore-and-tar']}${path}`);
        expect(res?.status()).toBe(200);
        await expect(page.getByRole('heading', { level: 1 }).isVisible()).resolves.toBe(true);
        await expect(
          page.getByRole('link', { name: 'manenji@oreandtar.com' }).getAttribute('href'),
        ).resolves.toBe('mailto:manenji@oreandtar.com');
        const found = await auditPage(page, { narrow: true });
        expect(found, formatViolations(`${path} (ore-and-tar, ${colorScheme})`, found)).toEqual([]);
      }
      await context.close();
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origins['ore-and-tar']}/legal/privacy`);
    await expect(
      page.getByText('Ore and Tar Enterprises (Pvt) Ltd, Harare, Zimbabwe').isVisible(),
    ).resolves.toBe(true);
    await page.getByRole('link', { name: 'data deletion instructions' }).click();
    await page.waitForURL('**/legal/data-deletion');
    await page.getByRole('link', { name: 'privacy policy' }).click();
    await page.waitForURL('**/legal/privacy');
    await context.close();
    for (const pack of ['oremedia', 'no-such-pack'])
      expect((await fetch(`${origins[pack]}/legal/privacy`)).status).toBe(404);
  }, 45_000);

  for (const theme of ['light', 'dark'] as const)
    it(`the Ore & Tar tokens pass the audit on sign-in and the portfolio (${theme})`, async () => {
      const page = await open('ore-and-tar', theme);
      const signIn = await auditPage(page, { narrow: false });
      expect(signIn, formatViolations(`sign-in (ore-and-tar, ${theme})`, signIn)).toEqual([]);
      await page.getByLabel('Session token').fill(E2E.token);
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.waitForURL('**/portfolio*', { timeout: 15_000 });
      await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15_000 });
      await expect(page.getByRole('link', { name: 'Ore & Tar' }).first().isVisible()).resolves.toBe(true);
      const portfolio = await auditPage(page, { narrow: false });
      expect(portfolio, formatViolations(`portfolio (ore-and-tar, ${theme})`, portfolio)).toEqual([]);
      await page.context().close();
    }, 45_000);
});
