import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { auditPage, formatViolations } from './a11y';
import { deployedPeople, deployedWebOrigin, signInWithPasswordForm, type DeployedPerson } from './deployed';

/**
 * The deployed origin in Chromium (docs/runbooks/staging-acceptance.md): the UAT journeys a browser proves against
 * a real deployment with the acceptance fixtures, without a mock. U1: the fixture owner signs in with email and
 * password, lands on the portfolio, opens the company and the brand. The shell: the brand sections navigate.
 * U2: the brand system reads the saved brand system. Isolation: company B's owner opening company A's brand sees
 * only the restricted-access state. The audit of apps/web/e2e/a11y.ts runs on the real home and brand system.
 * Runs only with OREMEDIA_E2E_WEB_ORIGIN (the acceptance job sets it); never on plain `pnpm test`.
 */
const webOrigin = deployedWebOrigin();
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const brandPath = (p: Pick<DeployedPerson, 'tenantId' | 'brandId'>, rest: string) =>
  `/c/${encodeURIComponent(p.tenantId)}/b/${encodeURIComponent(p.brandId)}/${rest}`;

describe.skipIf(!webOrigin)('deployed origin (real web, api and fixtures in Chromium)', () => {
  const origin = webOrigin ?? '';
  const companyName = process.env['OREMEDIA_E2E_COMPANY_NAME'] ?? 'Acceptance A';
  const brandName = process.env['OREMEDIA_E2E_BRAND_NAME'] ?? 'Acceptance brand';
  let people: ReturnType<typeof deployedPeople>;
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  let page: Page;

  const fresh = async (width = 1440): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    contexts.push(context);
    const p = await context.newPage();
    p.on('pageerror', (err) => console.error('[page error]', err));
    return p;
  };
  const noViolations = async (p: Page, name: string) => {
    const violations = await auditPage(p, { narrow: false });
    expect(violations, formatViolations(name, violations)).toEqual([]);
  };
  /** The home has settled: rows need attention, or the empty state (a status) says nothing does. */
  const nothingNeedsYou = (p: Page) => p.getByRole('status').filter({ hasText: 'Nothing needs you' });
  const homeReady = (p: Page) =>
    p.getByTestId('needs-you').or(nothingNeedsYou(p)).waitFor({ timeout: 30_000 });

  beforeAll(async () => {
    people = deployedPeople();
    browser = await chromium.launch(launchOptions);
    page = await fresh();
  }, 60_000);

  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
  });

  it('U1: the owner signs in with email and password, sees the company on the portfolio, opens the brand home', async () => {
    await signInWithPasswordForm(page, origin, people.a);
    const companies = page.getByRole('list', { name: 'Companies' });
    await companies.waitFor({ timeout: 30_000 });
    const company = page.getByRole('region', { name: companyName });
    await company.getByRole('link', { name: 'Open' }).click();
    await page.getByRole('list', { name: 'Brands' }).waitFor({ timeout: 30_000 });
    await page.getByRole('region', { name: brandName }).getByRole('link', { name: 'Open' }).click();
    await page.waitForURL('**/home*', { timeout: 30_000 });
    expect(page.url()).toContain(brandPath(people.a, 'home'));
    await homeReady(page);
    expect(await page.getByLabel('Company').textContent()).toBe(companyName);
    await noViolations(page, 'brand home');
  }, 90_000);

  it('the shell: the brand sections navigate, and Studio opens its documents index', async () => {
    const nav = page.getByRole('navigation', { name: 'Brand sections' });
    await nav.waitFor({ timeout: 15_000 });
    for (const [label, path] of [
      ['Calendar', '/calendar'],
      ['Review', '/review'],
      ['Assets', '/assets'],
    ] as const) {
      await nav.getByRole('link', { name: new RegExp(`^${label}`) }).click();
      await page.waitForURL(`**${path}*`, { timeout: 30_000 });
      await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30_000 });
    }
    await nav.getByRole('link', { name: /^Studio/ }).click();
    await page.waitForURL('**/studio', { timeout: 30_000 });
    await expect
      .poll(() => page.getByRole('heading', { level: 1 }).textContent(), { timeout: 30_000 })
      .toBe('What are you making?');
    // The interface's create screen: Still and Motion, each opening the format step.
    await page.getByTestId('studio-kind').filter({ hasText: 'Still' }).waitFor({ timeout: 30_000 });
  }, 90_000);

  it('U2: the brand system shows the saved brand system of the fixture brand', async () => {
    await page.goto(`${origin}${brandPath(people.a, 'system')}`);
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30_000 });
    // D-22: the overview reads the applied brand system; there are no versions to choose between.
    await page
      .getByRole('main')
      .getByRole('button', { name: /^Colour/ })
      .first()
      .waitFor({ timeout: 30_000 });
    expect(await page.getByText('Set up your brand system').count()).toBe(0);
    expect(await page.getByRole('group', { name: 'Version shown' }).count()).toBe(0);
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, {
      timeout: 30_000,
    });
    await noViolations(page, 'brand system');
  }, 90_000);

  it("isolation: company B's owner cannot open company A's brand, only their own", async () => {
    const other = await fresh();
    await signInWithPasswordForm(other, origin, people.b);
    await other.goto(`${origin}${brandPath(people.a, 'home')}`);
    // The shell stays (its navigation names no brand: the brand never loaded); the screen is the refusal only.
    await other.getByText('Restricted access').waitFor({ timeout: 30_000 });
    expect(await other.getByText(brandName).count()).toBe(0);
    expect(await other.getByTestId('needs-you').count()).toBe(0);
    expect(await nothingNeedsYou(other).count()).toBe(0);
    await other.goto(`${origin}${brandPath(people.b, 'home')}`);
    await homeReady(other);
    await other.close();
  }, 90_000);

  it('signing out ends the session: the brand home then asks for a sign-in', async () => {
    const menu = page.getByRole('button', { name: 'Menu' });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('button', { name: 'Account and session' }).first().click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL('**/sign-in*', { timeout: 30_000 });
    await page.goto(`${origin}${brandPath(people.a, 'home')}`);
    await page.waitForURL('**/sign-in*', { timeout: 30_000 });
  }, 60_000);
});
