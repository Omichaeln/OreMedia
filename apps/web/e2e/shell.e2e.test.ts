import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * Brand shell and home (the v3 prototype's navigation on this app's design language): a sidebar from 1024 px with
 * the company/brand switcher and counts taken from the lists the sections show; a Menu drawer at phone width; a
 * home whose "Needs you" rows match those counts and link to the exact item. Opt-in like the other smokes.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const home = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/home`;

describe.skipIf(!enabled)('brand shell and home (built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;

  const signedIn = async (width: number): Promise<Page> => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
    await page.goto(`${origin}${home}`);
    await page.getByTestId('needs-you').waitFor({ timeout: 15_000 });
    return page;
  };
  const countOf = async (page: Page, label: string) => {
    const link = page
      .getByRole('navigation', { name: 'Brand sections' })
      .getByRole('link', { name: new RegExp(`^${label}`) });
    const text = (await link.textContent()) ?? '';
    const match = /(\d+)\s*need you/.exec(text);
    return match ? Number(match[1]) : 0;
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

  it('the sidebar counts are the Needs you rows of each kind, and each row links to its item', async () => {
    const page = await signedIn(1440);
    const rows = page.getByTestId('needs-you').getByRole('listitem');
    const reviewRows = await rows
      .filter({ has: page.getByRole('link', { name: /^(Review|Decide)/ }) })
      .count();
    const publicationRows = await rows
      .filter({ has: page.getByRole('link', { name: /^(Reconcile|Open)/ }) })
      .count();
    expect(reviewRows).toBeGreaterThan(0);
    expect(await countOf(page, 'Review')).toBe(reviewRows);
    expect(await countOf(page, 'Calendar')).toBe(publicationRows);
    const decide = rows.getByRole('link', { name: /^Decide/ }).first();
    expect(await decide.getAttribute('href')).toMatch(/\/review\?request=/);
    await page.close();
  }, 45_000);

  it('the switcher names company and brand and lists the brands and the portfolio', async () => {
    const page = await signedIn(1440);
    const trigger = page.getByRole('button', { name: /Switch brand or company/ });
    expect(await trigger.textContent()).toContain(E2E.brandName);
    await trigger.click();
    await page.getByRole('menuitem', { name: 'All companies' }).waitFor({ timeout: 15_000 });
    expect(await page.getByRole('menuitem', { name: E2E.brandName }).getAttribute('aria-current')).toBe(
      'true',
    );
    await page.keyboard.press('Escape');
    await page.close();
  }, 45_000);

  it('portfolio and company page: counts from brand.summary, an overdue approval shows once it is past due', async () => {
    const pubs = [...backend.phase5.publications.values()].filter((p) => p.brandId === E2E.brandId);
    const needsPerson = pubs.filter((p) => ['failed', 'outcome_unknown', 'held'].includes(p.state)).length;
    expect(needsPerson).toBeGreaterThan(0);
    const open = [...backend.phase5.requests.values()].find((r) => r.state === 'open');
    expect(open).toBeDefined();
    const dueBefore = open!.dueAt;
    open!.dueAt = new Date(Date.now() - 3600_000).toISOString();
    try {
      const page = await signedIn(1280);
      await page.goto(`${origin}/portfolio`);
      const company = page.getByRole('region', { name: E2E.companyName }).getByTestId('summary-counts');
      await expect.poll(() => company.textContent(), { timeout: 15_000 }).toContain('1 overdue approval');
      expect(await company.textContent()).toContain(`${needsPerson} post`);
      await page.goto(`${origin}/c/${encodeURIComponent(E2E.tenantId)}`);
      const brand = page.getByRole('region', { name: E2E.brandName }).getByTestId('summary-counts');
      await expect.poll(() => brand.textContent(), { timeout: 15_000 }).toContain('1 overdue approval');
      expect(await brand.textContent()).toContain(
        `${needsPerson} ${needsPerson === 1 ? 'post failed or held' : 'posts failed or held'}`,
      );
      expect(await brand.textContent()).toMatch(/\d+ posts? due in the next 7 days/);
      await page.close();
    } finally {
      open!.dueAt = dueBefore;
    }
  }, 30_000);

  it('at phone width the navigation is a Menu drawer that closes on navigating', async () => {
    const page = await signedIn(390);
    expect(await page.getByRole('navigation', { name: 'Brand sections' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Menu' }).click();
    const nav = page.getByRole('navigation', { name: 'Brand sections' });
    await nav.getByRole('link', { name: /^Calendar/ }).click();
    await page.waitForURL('**/calendar*', { timeout: 15_000 });
    await expect.poll(() => page.getByRole('navigation', { name: 'Brand sections' }).count()).toBe(0);
    await page.close();
  }, 45_000);

  it('assets: purpose chips switch the eligibility search; a card and Upload open side sheets', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/assets')}`);
    const chips = page.getByRole('group', { name: 'Eligible for' });
    await chips.getByRole('button', { name: 'Reference' }).click();
    expect(await chips.getByRole('button', { name: 'Reference' }).getAttribute('aria-pressed')).toBe('true');
    await chips.getByRole('button', { name: 'Creative' }).click();
    await page.getByRole('list', { name: 'Eligible assets' }).getByRole('button').first().click();
    const sheet = page.getByRole('dialog', { name: 'Asset' });
    await sheet.getByRole('region', { name: 'Asset detail' }).waitFor({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Upload' }).click();
    await page
      .getByRole('dialog', { name: 'Upload an asset' })
      .getByLabel('File')
      .waitFor({ timeout: 15_000 });
    await page.close();
  }, 45_000);

  it('performance: totals stay within a kind, missing numbers are named, period and channel filter the posts', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/performance')}`);
    const metric = page.getByRole('group', { name: 'Metric' });
    const impressions = metric.getByRole('button', { name: /^Impressions/ });
    await impressions.waitFor({ timeout: 15_000 });
    // 1,840 (X) + 5,200 (LinkedIn) + 760 (X): impressions of both providers are one comparable group.
    expect(await impressions.textContent()).toContain((7800).toLocaleString('en-US'));
    expect(await page.getByTestId('coverage').textContent()).toContain('3 of 3 publications have numbers');
    expect(await page.getByTestId('coverage').textContent()).toContain('2 stale values');
    const clicks = metric.getByRole('button', { name: /^Clicks/ });
    expect(await clicks.textContent()).toContain('2 of 3 posts');
    await clicks.click();
    await expect.poll(() => clicks.getAttribute('aria-pressed')).toBe('true');
    const posts = page.getByTestId('performance-posts').getByRole('listitem');
    expect(await posts.count()).toBe(3);
    // LinkedIn did not return clicks: the row says so and sorts last, never shown as 0.
    await expect.poll(() => posts.last().textContent()).toContain('Unavailable');
    await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: '7 days' }).click();
    await expect.poll(() => posts.count(), { timeout: 15_000 }).toBe(2);
    await page.getByRole('group', { name: 'Channel' }).getByRole('button', { name: 'Acme LinkedIn' }).click();
    await expect.poll(() => posts.count(), { timeout: 15_000 }).toBe(1);
    expect(new URL(page.url()).searchParams.get('metric')).toBe('clicks');
    // A channel with nothing published in the period shows that, and none of the previous selection's totals.
    await page
      .getByRole('group', { name: 'Channel' })
      .getByRole('button', { name: 'Acme Instagram' })
      .click();
    await page.getByText('Nothing published in the last 7 days').waitFor({ timeout: 15_000 });
    expect(await page.getByRole('group', { name: 'Metric' }).count()).toBe(0);
    expect(await page.getByTestId('coverage').count()).toBe(0);
    await page.close();
  }, 45_000);
  it('performance trend: posts by day published at one age, against the previous period; young posts are pending', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/performance')}?period=7&age=1&metric=impressions`);
    const trend = page.getByTestId('daily-trend');
    const summary = trend.getByTestId('trend-summary');
    // This week: the LinkedIn post of three days ago (5,200) at one day; today's post is not a day old yet.
    // The previous seven days: the X post of twelve days ago (760), measured the same way.
    await expect.poll(() => summary.textContent(), { timeout: 15_000 }).toContain('5,200 per post at 1 day');
    expect(await summary.textContent()).toContain('across 1 of 2 posts');
    expect(await summary.textContent()).toContain('previous 7 days 760');
    expect(await summary.textContent()).toContain('(+584.2%)');
    expect(await trend.getByTestId('trend-day').count()).toBe(7);
    await trend.getByText('Show as a table').click();
    const rows = trend.getByTestId('trend-table').locator('tbody tr');
    expect(await rows.count()).toBe(2);
    expect(await rows.last().textContent()).toMatch(/1—100$/); // today: 1 post, no number, not measured yet
    // At seven days neither post of this week is old enough, and nothing stands in for their numbers.
    await trend.getByRole('group', { name: 'Measured at' }).getByRole('button', { name: '7 days' }).click();
    await expect
      .poll(() => summary.textContent(), { timeout: 15_000 })
      .toContain('No post in this period has a number at 7 days yet · 2 not measured at 7 days yet');
    expect(new URL(page.url()).searchParams.get('age')).toBe('7');
    await page.close();
  }, 45_000);

  it('settings: channels and skills are tabs; a skill without a published version says so', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings')}`);
    await page.getByTestId('channels').waitFor({ timeout: 15_000 });
    expect(await page.getByRole('tab', { name: 'Channels' }).getAttribute('aria-selected')).toBe('true');
    await page.getByRole('tab', { name: 'Skills' }).click();
    const skills = page.getByRole('list', { name: 'Skills' }).getByRole('listitem');
    await expect.poll(() => skills.count(), { timeout: 15_000 }).toBe(3);
    expect(new URL(page.url()).searchParams.get('tab')).toBe('skills');
    const imported = skills.filter({ hasText: 'acme-voice' });
    expect(await imported.textContent()).toContain('This brand');
    expect(await imported.textContent()).toContain('No published version');
    expect(await skills.filter({ hasText: 'brand-onboarding' }).textContent()).toContain('Built in');
    await page.close();
  }, 45_000);
  it('settings admin: the release policy defaults, kill switches with the company-wide override, model routing', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings')}`);
    const tabs = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab');
    await expect
      .poll(() => tabs.allTextContents(), { timeout: 15_000 })
      .toEqual(['Channels', 'Mandates', 'Policy', 'Skills', 'Members', 'Model routing']);
    await page.getByRole('tab', { name: 'Policy' }).click();
    const policy = page.getByTestId('release-policy');
    await expect
      .poll(() => policy.textContent(), { timeout: 15_000 })
      .toContain('defaults below are in force');
    expect(await policy.textContent()).toContain('Hold on revoked facts');
    // Engage agent starts for this brand, with a reason.
    const brandRow = page.getByTestId('kill-agent_starts-brand');
    await brandRow.getByRole('button', { name: 'Engage' }).click();
    await page.getByLabel('Reason').fill('Incident drill');
    await page.getByTestId('confirm-kill-agent_starts').click();
    await expect.poll(() => brandRow.textContent(), { timeout: 15_000 }).toContain('Engaged');
    expect(backend.killSwitches.get(`agent_starts:${E2E.brandId}`)).toEqual({
      engaged: true,
      reason: 'Incident drill',
    });
    // The company-wide mandate-publishing switch shows on the brand row and must be released on its own row.
    await page.getByTestId('kill-release_dispatch-company').getByRole('button', { name: 'Engage' }).click();
    await page.getByTestId('confirm-kill-release_dispatch').click();
    const mandateBrand = page.getByTestId('kill-release_dispatch-brand');
    await expect
      .poll(() => mandateBrand.textContent(), { timeout: 15_000 })
      .toContain('Engaged company-wide');
    expect(await mandateBrand.getByRole('button', { name: 'Release' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    await page.getByRole('tab', { name: 'Model routing' }).click();
    const routing = page.getByTestId('model-routing');
    await expect.poll(() => routing.textContent(), { timeout: 15_000 }).toContain('anthropic/claude-sonnet');
    // What is checked is apart from what is only recorded, and the model in use comes from the deployment.
    expect(await routing.getByTestId('model-in-use').textContent()).toContain('through OpenRouter in eu');
    expect(await routing.textContent()).toContain('Recorded, not enforced');
    expect(await routing.textContent()).not.toContain('retention');
    const storedBefore = backend.routingPolicy;
    await routing.getByRole('button', { name: 'Edit' }).click();
    const form = routing.getByTestId('routing-form');
    await form.getByLabel('Denied models').fill('vendor/old-model\n vendor/old-model \n');
    await form.getByLabel('Permitted regions').fill(' eu, us ,eu, ');
    await form.getByRole('button', { name: 'Save policy' }).click();
    await expect.poll(() => routing.textContent(), { timeout: 15_000 }).toContain('Stored version 3.');
    expect(backend.routingPolicy?.policy).toMatchObject({
      permittedVendors: ['anthropic', 'openrouter'],
      deniedModels: ['vendor/old-model'],
      permittedRegions: ['eu', 'us'],
    });
    expect(backend.routingPolicy?.policy).not.toHaveProperty('retention');
    // A region list without the deployment's region, or dropping the vendor in use, would stop every run: the
    // form says so and asks before saving.
    await routing.getByRole('button', { name: 'Edit' }).click();
    await form.getByLabel('Permitted regions').fill('us');
    expect(await form.textContent()).toContain('This policy stops every agent run for the company');
    await form.getByLabel('Permitted regions').fill('eu');
    expect(await form.textContent()).not.toContain('This policy stops every agent run for the company');
    await form.getByLabel('OpenRouter').uncheck();
    expect(await form.textContent()).toContain('This policy stops every agent run for the company');
    await form.getByRole('button', { name: 'Save policy' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Stop every agent run?' });
    await confirm.waitFor({ timeout: 15_000 });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect(backend.routingPolicy?.version).toBe(3);
    await form.getByRole('button', { name: 'Cancel' }).click();
    backend.routingPolicy = storedBefore;
    backend.killSwitches.clear();
    await page.close();
  }, 45_000);

  it('settings: members and invitations; mandates with their limits, paused behind a confirmation', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings?tab=members')}`);
    const members = page.getByRole('list', { name: 'Members' }).getByRole('listitem');
    await expect.poll(() => members.count(), { timeout: 15_000 }).toBe(3);
    expect(await members.filter({ hasText: 'lina@example.test' }).textContent()).toContain('Invited');
    expect(await members.filter({ hasText: 'Kofi Asare' }).textContent()).toContain(E2E.brandName);
    await page.getByLabel('Email').fill('new.person@example.test');
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await page.getByTestId('invite-sent').waitFor({ timeout: 15_000 });
    await page.getByRole('tab', { name: 'Mandates' }).click();
    const mandates = page.getByTestId('mandate');
    await expect.poll(() => mandates.count(), { timeout: 15_000 }).toBe(2);
    const active = mandates.filter({ hasText: 'Active' });
    expect(await active.textContent()).toContain('3 posts');
    expect(await active.textContent()).toContain('approved facts only');
    expect(await mandates.filter({ hasText: 'Revoked' }).getByRole('button').count()).toBe(0);
    await active.getByRole('button', { name: 'Pause' }).click();
    await page.getByTestId('confirm-pause-mandate').click();
    await expect
      .poll(() => backend.phase5.mandates.get('mnd_active')?.state, { timeout: 15_000 })
      .toBe('paused');
    await expect.poll(() => mandates.first().textContent(), { timeout: 15_000 }).toContain('Paused');
    Object.assign(backend.phase5.mandates.get('mnd_active') ?? {}, { state: 'active', version: 0 });
    await page.close();
  }, 45_000);

  it('settings: a brand manager sees neither the kill switches nor model routing', async () => {
    backend.role = 'brand_manager';
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings?tab=policy')}`);
    await page.getByTestId('release-policy').waitFor({ timeout: 15_000 });
    expect(await page.getByTestId('kill-switches').count()).toBe(0);
    expect(await page.getByRole('tab', { name: 'Model routing' }).count()).toBe(0);
    expect(await page.getByRole('tab', { name: 'Members' }).count()).toBe(0);
    await page.getByRole('tab', { name: 'Mandates' }).click();
    await expect.poll(() => page.getByTestId('mandate').count(), { timeout: 15_000 }).toBe(2);
    expect(await page.getByTestId('mandates').getByRole('button', { name: 'Pause' }).count()).toBe(0);
    backend.role = 'owner';
    await page.close();
  }, 45_000);

  it('brand system: a draft is read against the published version, and a draft check blocks prohibited phrases', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/system')}`);
    await page
      .getByRole('group', { name: 'Version shown' })
      .getByRole('button', { name: /proposed/ })
      .click();
    await page.getByTestId('viewing-draft').waitFor({ timeout: 15_000 });
    const nav = page.getByRole('navigation', { name: 'Brand system sections' });
    // The mock draft adds reference imagery and guidelines; nothing else differs.
    await expect
      .poll(() => nav.getByRole('button', { name: /Changed/ }).allTextContents(), { timeout: 15_000 })
      .toEqual(['ImageryChanged in this version', 'GuidelinesChanged in this version']);
    await page.getByRole('button', { name: 'Review changes' }).click();
    const changes = page.getByTestId('version-changes');
    await expect.poll(() => changes.textContent(), { timeout: 15_000 }).toContain('Imagery');
    expect(await changes.textContent()).toContain('approvals of this brand are invalidated');
    await page.goto(`${origin}${home.replace('/home', '/system?section=voice')}`);
    await page.getByLabel('Draft copy').fill('A cheap and cheerful roast');
    const findings = page.getByTestId('draft-findings');
    await expect.poll(() => findings.textContent(), { timeout: 15_000 }).toContain('Never write “cheap”');
    await page.close();
  }, 45_000);
});
