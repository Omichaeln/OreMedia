import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * Brand kit: voice and vocabulary extraction (spec 8.2 onboarding). The BUILT app at phone width against the
 * in-process mock transport: a draft carrying imported guidelines offers "Extract voice and vocabulary"; a known
 * agent principal starts a run and the page links to it; an unknown principal is refused in text; unsaved edits
 * must be saved or discarded first. Opt-in like the other smokes (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const systemPath = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/system`;

describe.skipIf(!enabled)('brand kit: voice and vocabulary extraction (built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const openEditor = async () => {
    await page.goto(`${origin}${systemPath}`);
    await page.getByRole('button', { name: 'Edit brand kit' }).first().click({ timeout: 15_000 });
    await page.getByRole('heading', { name: 'Extract voice and vocabulary' }).waitFor({ timeout: 15_000 });
  };
  const extract = () => page.getByRole('button', { name: 'Extract voice and vocabulary' });

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('an unknown principal is refused in text; a known one starts the run and links to it', async () => {
    await openEditor();
    expect(await extract().getAttribute('aria-disabled')).toBe('true'); // no principal yet
    await page.getByLabel('Agent principal').fill('sp_unknown');
    await extract().click();
    await expect
      .poll(() => page.getByText('ServicePrincipal').count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(await page.getByText('Not started', { exact: false }).count()).toBeGreaterThan(0);
    await page.getByLabel('Agent principal').fill('sp_e2e_onboarding');
    await extract().click();
    const follow = page.getByRole('link', { name: 'Follow the run' });
    await follow.waitFor({ timeout: 15_000 });
    expect(await follow.getAttribute('href')).toBe(
      `/c/${E2E.tenantId}/b/${E2E.brandId}/agents?run=run_e2e_onboarding`,
    );
    expect(await page.getByText('The agent is reading the guidelines').count()).toBe(1);
  }, 45_000);

  it('with unsaved edits the extraction waits until they are saved or discarded', async () => {
    await openEditor();
    await page.getByLabel('Agent principal').fill('sp_e2e_onboarding');
    expect(await extract().getAttribute('aria-disabled')).toBeNull();
    await page.getByLabel('Summary', { exact: true }).fill('Edited but not saved.');
    expect(await extract().getAttribute('aria-disabled')).toBe('true');
    expect(await extract().getAttribute('title')).toBe('Save or discard your changes first');
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect.poll(() => extract().getAttribute('aria-disabled'), { timeout: 15_000 }).toBeNull();
  }, 45_000);
});
