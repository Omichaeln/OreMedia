import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer, watchCspViolations, type CspViolation } from './static-server';

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

  // Every screen here is served with the production security headers (static-server.ts reads the Caddyfile).
  const cspViolations: CspViolation[] = [];
  const signedIn = async (width: number): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const seen = await watchCspViolations(context);
    const page = await context.newPage();
    page.on('close', () => {
      cspViolations.push(...seen);
      void context.close();
    });
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

  it('assets: All assets names every state with its issues; a pending asset is approved and rights recorded from the inspector; an upload settles (UX-05, R1-B)', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/assets')}`);
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'All assets' }).click();
    const list = page.getByTestId('asset-list');
    await expect.poll(() => list.getByRole('listitem').count(), { timeout: 15_000 }).toBe(4);
    expect(await page.getByTestId('asset-ast_pending').textContent()).toContain('Pending review');
    expect(await page.getByTestId('asset-ast_logo').textContent()).toContain('Missing rights');
    expect(await page.getByTestId('asset-ast_retired').textContent()).toContain('Retired');
    expect(await page.getByTestId('asset-ast_e2e').textContent()).toContain('Usable');
    // Needs attention keeps the three with an issue.
    await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Needs attention' }).click();
    await expect.poll(() => list.getByRole('listitem').count(), { timeout: 15_000 }).toBe(3);
    // Approve the pending one from the inspector: it leaves the attention list.
    await page.getByTestId('asset-ast_pending').getByRole('button').click();
    const sheet = page.getByRole('dialog', { name: 'Asset' });
    await sheet.getByRole('button', { name: 'Approve' }).click();
    await expect.poll(() => sheet.textContent(), { timeout: 15_000 }).toContain('Approved');
    // Record rights on it (the form is open because none are recorded): it saves and the badge changes.
    await sheet.getByLabel('Rights owner').fill('Studio');
    await sheet.getByRole('button', { name: 'Save rights' }).click();
    await expect.poll(() => sheet.textContent(), { timeout: 15_000 }).toContain('Rights recorded');
    await page.keyboard.press('Escape');
    await expect.poll(() => list.getByRole('listitem').count(), { timeout: 15_000 }).toBe(2);
    // Upload a photo: the sheet polls the intent until it settles and offers the new asset.
    await page.getByRole('button', { name: 'Upload' }).click();
    const upload = page.getByRole('dialog', { name: 'Upload an asset' });
    await upload.getByLabel('File').setInputFiles({
      name: 'new-hero.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    await expect.poll(() => upload.getByTestId('upload-accepted').count(), { timeout: 15_000 }).toBe(1);
    await upload.getByRole('button', { name: 'Inspect' }).click();
    await expect
      .poll(() => page.getByRole('dialog', { name: 'Asset' }).textContent(), { timeout: 15_000 })
      .toContain('new-hero.png');
    await page.close();
  }, 60_000);

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

  it('setup checklist (R1-D): a brand in setup lists the journey with each step read live; the standards gate Finish; done steps close it', async () => {
    const brand = backend.brands.find((b) => b.id === E2E.brandId)!;
    brand.status = 'setup';
    backend.addBrand('brd_e2e_setup', 'Fresh brand');
    const fresh = backend.brands.find((b) => b.id === 'brd_e2e_setup')!;
    fresh.status = 'setup';
    fresh.publishedVersionId = null;
    try {
      const page = await signedIn(1440);
      const checklist = page.getByTestId('setup-checklist');
      await checklist.waitFor({ timeout: 15_000 });
      // The e2e brand has published standards, a channel, assets, packages and review requests: every step is done.
      await expect
        .poll(
          () =>
            checklist
              .getByTestId('setup-step')
              .evaluateAll((els) => els.map((el) => el.getAttribute('data-done'))),
          {
            timeout: 15_000,
          },
        )
        .toEqual(['true', 'true', 'true', 'true', 'true']);
      expect(await checklist.textContent()).toContain('5 of 5');
      await checklist.getByRole('button', { name: 'Finish setup' }).click();
      await expect.poll(() => page.getByTestId('setup-checklist').count(), { timeout: 15_000 }).toBe(0);
      expect(brand.status).toBe('active');
      // A brand without published standards: the gate is named, Finish is refused with the reason, a channel can be skipped.
      await page.goto(`${origin}/c/${encodeURIComponent(E2E.tenantId)}/b/brd_e2e_setup/home`);
      const freshList = page.getByTestId('setup-checklist');
      await freshList.waitFor({ timeout: 15_000 });
      const standards = freshList.locator('[data-testid="setup-step"][data-step="standards"]');
      expect(await standards.textContent()).toContain('Needed');
      expect(await standards.getByRole('link', { name: 'Open brand system' }).count()).toBe(1);
      const finish = freshList.getByRole('button', { name: 'Finish setup' });
      expect(await finish.isDisabled()).toBe(true);
      await page.close();
    } finally {
      brand.status = undefined;
      backend.brands.splice(
        backend.brands.findIndex((b) => b.id === 'brd_e2e_setup'),
        1,
      );
    }
  }, 45_000);
  it('performance panels (UX-12): slots pool the rate, attributes are listed with their sample, a post opens its quality and links, briefs come from the workspace', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/performance')}`);
    const metric = page.getByRole('group', { name: 'Metric' });
    await metric.getByRole('button', { name: /^Impressions/ }).waitFor({ timeout: 15_000 });
    // Engagement rate is pooled from its operands over the three posts: (150 + 260 + 60) / 7,800.
    expect(await metric.getByRole('button', { name: /^Engagement rate/ }).textContent()).toContain('6.0%');
    // When it lands: 7 × 4 cells, the three posts in three cells, each cell a pooled rate (never summed).
    const heatmap = page.getByTestId('slot-heatmap');
    expect(await heatmap.getByTestId('slot-cell').count()).toBe(28);
    const withPosts = heatmap.locator('[data-testid="slot-cell"]:has-text("%")');
    expect(await withPosts.count()).toBe(3);
    expect(await withPosts.first().textContent()).toContain('1/1');
    // What the creative did: every captured value with its pooled rate; under the minimum sample it is listed, not compared.
    const attributes = page.getByTestId('creative-attributes');
    await expect
      .poll(() => attributes.getByTestId('attributes-brand').textContent(), { timeout: 15_000 })
      .toContain('Brand rate 6.0%');
    expect(await attributes.getByTestId('attributes-brand').textContent()).toContain(
      '3 of 3 with attributes',
    );
    // Under the minimum sample no slot is shaded (D-14); the rate is still shown.
    expect(await heatmap.locator('[data-testid="slot-cell"][data-sufficient="true"]').count()).toBe(0);
    const values = attributes.getByTestId('attribute-value');
    expect(await values.count()).toBeGreaterThan(0);
    expect(
      await values.evaluateAll((els) => els.every((el) => el.getAttribute('data-sufficient') === 'false')),
    ).toBe(true);
    expect(await attributes.textContent()).toContain('Small sample');
    expect(await attributes.textContent()).not.toContain('Above brand');
    // One post: its quality composite with what is unavailable named, and its tracked link with the clicks.
    const row = page.getByTestId('performance-posts').locator('[data-publication="pub_published"]');
    await row.getByRole('button', { name: 'Details' }).click();
    const detail = page.getByTestId('post-detail');
    await detail.getByTestId('post-quality').waitFor({ timeout: 15_000 });
    expect(new URL(page.url()).searchParams.get('post')).toBe('pub_published');
    const components = detail.getByTestId('quality-component');
    expect(await components.count()).toBe(5);
    expect(await components.first().textContent()).toContain('Saves');
    expect(await components.first().textContent()).toContain('14');
    expect(await components.nth(2).textContent()).toContain('Unavailable');
    expect(await detail.textContent()).toContain('never counted as zero');
    await detail.getByTestId('post-links').waitFor({ timeout: 15_000 });
    expect(await detail.getByTestId('post-links').textContent()).toContain('31 clicks');
    expect(await detail.getByTestId('post-links').textContent()).toContain('https://ore.link/k3n9qz');
    await detail.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => page.getByTestId('post-detail').count(), { timeout: 15_000 }).toBe(0);
    expect(new URL(page.url()).searchParams.get('post')).toBeNull();
    // Next cycle: the workspace's open recommendations that propose a brief, on the same card as the workspace.
    const next = page.getByTestId('next-cycle');
    await next.getByTestId('recommendation').first().waitFor({ timeout: 15_000 });
    expect(await next.getByTestId('recommendation').count()).toBe(1);
    expect(await next.textContent()).toContain('Answer the shipping question in a post');
    expect(await next.textContent()).not.toContain('Test price-first carousels');
    await page.close();
  }, 60_000);

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
    // UX-17: the imported brand skill's draft is evaluated, then published, then bound to this brand.
    await imported.getByRole('button', { name: /Open Acme voice/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Skill' });
    await expect.poll(() => sheet.getByTestId('skill-version-1').count(), { timeout: 15_000 }).toBe(1);
    const v1 = sheet.getByTestId('skill-version-1');
    expect(await v1.textContent()).toContain('Draft');
    await v1.getByRole('button', { name: 'Evaluate' }).click();
    await expect.poll(() => v1.textContent(), { timeout: 15_000 }).toContain('passed');
    await v1.getByRole('button', { name: 'Publish' }).click();
    await expect.poll(() => v1.textContent(), { timeout: 15_000 }).toContain('Published');
    await v1.getByRole('button', { name: 'Use for this brand' }).click();
    await expect.poll(() => v1.textContent(), { timeout: 15_000 }).toContain('Bound to this brand');
    await page.keyboard.press('Escape');
    await expect.poll(() => imported.textContent(), { timeout: 15_000 }).toContain('Published');
    // Import a package: manifest.json names the skill; it appears as a new draft.
    await page.getByRole('button', { name: 'Import a skill package' }).click();
    await page.getByLabel('Skill package files').setInputFiles([
      {
        name: 'manifest.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, key: 'launch-hooks', title: 'Launch hooks' })),
      },
      { name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('# Launch hooks\n') },
    ]);
    await page.getByRole('button', { name: 'Import package' }).click();
    await expect.poll(() => page.getByTestId('skill-imported').count(), { timeout: 15_000 }).toBe(1);
    await expect.poll(() => skills.count(), { timeout: 15_000 }).toBe(4);
    expect(await skills.filter({ hasText: 'launch-hooks' }).textContent()).toContain('No published version');
    await page.close();
  }, 60_000);

  it('settings destinations (R2-0): seeded destinations with their health, registration adds one, a policy save moves its version on, a Business Profile row never offers Write', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings?tab=destinations')}`);
    await page.getByTestId('destinations').waitFor({ timeout: 15_000 });
    expect(await page.getByRole('tab', { name: 'Destinations' }).getAttribute('aria-selected')).toBe('true');
    const ga4 = page.getByTestId('destination-dst_e2e_ga4');
    await ga4.waitFor({ timeout: 15_000 });
    expect(await ga4.textContent()).toContain('Acme web');
    expect(await ga4.textContent()).toContain('properties/424242');
    expect(await ga4.textContent()).toContain('Healthy');
    expect(await ga4.getAttribute('data-destination-health')).toBe('healthy');
    expect(await page.getByTestId('destination-dst_e2e_gbp').textContent()).toContain('Not checked');
    // Register a Search Console site: it joins the list under its own kind, owned by the signed-in person.
    await page.locator('#destination-kind').click();
    await page.getByRole('option', { name: 'Search Console site' }).click();
    await page.getByLabel('External id').fill('sc-domain:acme.example');
    await page.getByLabel('Display name').fill('Acme search');
    await page.getByRole('button', { name: 'Register destination' }).click();
    // The kind's group already lists the seeded site (R2-1 part B); the registered one joins it.
    const searchGroup = page.getByTestId('destinations-search_console_site');
    await expect.poll(() => searchGroup.textContent(), { timeout: 15_000 }).toContain('Acme search');
    expect(await searchGroup.textContent()).toContain('Acme site');
    expect(
      backend.destinations.destinations.find((d) => d.externalId === 'sc-domain:acme.example'),
    ).toMatchObject({ kind: 'search_console_site', status: 'active', health: 'unknown' });
    // The policy table: the GA4 row offers Read and Retain; the Business Profile row only Read (D-17).
    const ga4Policy = page.getByTestId('source-use-sup_e2e_ga4_reports');
    await ga4Policy.waitFor({ timeout: 15_000 });
    expect(await ga4Policy.getByRole('checkbox', { name: 'Retain' }).count()).toBe(1);
    expect(await ga4Policy.getByRole('checkbox', { name: 'Write' }).count()).toBe(0);
    const gbpPolicy = page.getByTestId('source-use-sup_e2e_gbp_reviews');
    expect(await gbpPolicy.getByRole('checkbox', { name: 'Read' }).count()).toBe(1);
    expect(await gbpPolicy.getByRole('checkbox', { name: 'Retain' }).count()).toBe(0);
    expect(await gbpPolicy.getByRole('checkbox', { name: 'Write' }).count()).toBe(0);
    expect(await gbpPolicy.getByTestId('policy-version').textContent()).toContain('Version 2');
    // Retention is enabled only once Retain is ticked; a save records the next version.
    expect(await ga4Policy.getByTestId('policy-version').textContent()).toContain('Version 1');
    expect(await ga4Policy.getByLabel('Retention (days)').isDisabled()).toBe(true);
    await ga4Policy.getByRole('checkbox', { name: 'Retain' }).check();
    await ga4Policy.getByLabel('Retention (days)').fill('30');
    await ga4Policy.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => ga4Policy.getByTestId('policy-version').textContent(), { timeout: 15_000 })
      .toContain('Version 2');
    expect(backend.destinations.policies.find((p) => p.id === 'sup_e2e_ga4_reports')).toMatchObject({
      version: 2,
      allowedUses: ['read', 'retain'],
      retentionDays: 30,
    });
    // A validation detail lands on its field: Retain ticked on the Business Profile row cannot happen (no box),
    // so on the GA4 row the retention period is cleared and the save is refused by the server with the reason.
    await ga4Policy.getByLabel('Retention (days)').fill('');
    await ga4Policy.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => ga4Policy.getByText('Needed when data is retained').count(), { timeout: 15_000 })
      .toBe(1);
    // Add a data type: a new (kind, data type) row starts at version 1.
    const add = page.getByTestId('source-use-add');
    await add.locator('#policy-new-kind').click();
    await page.getByRole('option', { name: 'Website CMS' }).click();
    await add.getByLabel('Data type').fill('cms.articles');
    await add.getByRole('checkbox', { name: 'Write' }).check();
    await add.getByRole('button', { name: 'Save policy' }).click();
    const added = page.getByTestId('source-use').getByRole('listitem').filter({ hasText: 'cms.articles' });
    await expect.poll(() => added.count(), { timeout: 15_000 }).toBe(1);
    expect(await added.getByTestId('policy-version').textContent()).toContain('Version 1');
    // Registering the GA4 property again is a conflict the form explains, not a second row.
    await page.locator('#destination-kind').click();
    await page.getByRole('option', { name: 'Google Analytics 4 property' }).click();
    await page.getByLabel('External id').fill('properties/424242');
    await page.getByLabel('Display name').fill('Acme web again');
    await page.getByRole('button', { name: 'Register destination' }).click();
    await page.getByTestId('destination-conflict').waitFor({ timeout: 15_000 });
    expect(await page.getByTestId('destinations-ga4_property').getByRole('listitem').count()).toBe(1);
    // Disconnect behind a confirmation: the row stays, marked disconnected, with no further action.
    const gbp = page.getByTestId('destination-dst_e2e_gbp');
    await gbp.getByRole('button', { name: 'Disconnect' }).click();
    const dialog = page.getByRole('alertdialog', { name: /Disconnect Acme Harare/ });
    await dialog.waitFor({ timeout: 15_000 });
    await dialog.getByTestId('confirm-disconnect-destination').click();
    await expect.poll(() => gbp.textContent(), { timeout: 15_000 }).toContain('Disconnected');
    expect(await gbp.getByRole('button', { name: 'Disconnect' }).count()).toBe(0);
    expect(backend.destinations.destinations.find((d) => d.id === 'dst_e2e_gbp')).toMatchObject({
      status: 'disconnected',
      version: 1,
    });
    Object.assign(backend.destinations.destinations.find((d) => d.id === 'dst_e2e_gbp') ?? {}, {
      status: 'active',
      version: 0,
    });
    await page.close();
  }, 60_000);

  it('web performance (R2-1): a connected GA4 property shows coverage, tiles compared with the previous week, a drill-down tab and its opportunities', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/performance')}?period=7`);
    const section = page.getByTestId('web-performance');
    await section.waitFor({ timeout: 15_000 });
    const ga4 = section.getByTestId('web-destination-dst_e2e_ga4');
    await ga4.getByTestId('web-tile-sessions').waitFor({ timeout: 15_000 });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(await ga4.getByTestId('web-coverage').textContent()).toContain(`data to ${yesterday}`);
    expect(await ga4.getByTestId('web-coverage').textContent()).toContain('Fresh');
    // The last 7 days include today, which no platform has reported yet: six days of ga4.engagement sessions
    // (100 + a 0..4 wobble) summed, never averaged, against the full week before.
    const sessions = await ga4.getByTestId('web-tile-sessions').textContent();
    expect(sessions).toMatch(/6\d\d/);
    expect(sessions).toContain('% vs previous');
    expect(sessions).toContain('6 days with data');
    expect(await ga4.getByTestId('web-tile-engagementRate').textContent()).toMatch(/4\d\.\d%/); // pooled Σ engaged ÷ Σ sessions
    expect(await ga4.getByTestId('web-tile-keyEvents').textContent()).toContain('18'); // 3 × 6
    // The first drill-down is the acquisition channels; Landing pages lists /pricing with its own rate.
    const drilldown = ga4.getByTestId('web-drilldown');
    await expect.poll(() => drilldown.locator('tbody tr').count(), { timeout: 15_000 }).toBe(3);
    expect(await drilldown.locator('tbody tr').first().textContent()).toContain('Organic Search');
    await ga4.getByRole('tab', { name: 'Landing pages' }).click();
    await expect
      .poll(() => drilldown.locator('tr[data-dimension="/pricing"]').count(), { timeout: 15_000 })
      .toBe(1);
    expect(await drilldown.locator('tr[data-dimension="/pricing"]').textContent()).toContain('10.0%');
    expect(await ga4.getByRole('tab', { name: 'Landing pages' }).getAttribute('aria-selected')).toBe('true');
    // Opportunities: /pricing engages a tenth of its sessions against the property's near-half.
    const opportunities = ga4.getByTestId('web-opportunities');
    await opportunities.waitFor({ timeout: 15_000 });
    expect(await opportunities.getByRole('listitem').count()).toBe(1);
    expect(await opportunities.textContent()).toContain('Low engagement page');
    expect(await opportunities.textContent()).toContain('/pricing');
    // D-19: AI search is a labelled external link to the vendor console, never a figure.
    const ai = ga4.getByTestId('web-ai-search').getByRole('link');
    expect(await ai.getAttribute('href')).toBe('https://analytics.google.com/');
    expect(await ai.getAttribute('target')).toBe('_blank');
    expect(await ai.getAttribute('rel')).toContain('noopener');
    expect(await ga4.getByTestId('web-ai-search').textContent()).toContain('no figure is shown');
    await page.close();
  }, 60_000);

  it('web performance (R2-2): a connected Business Profile location shows its tiles, the surface drill-down and the console link, with no opportunity for a single location', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/performance')}?period=7`);
    const gbp = page.getByTestId('web-performance').getByTestId('web-destination-dst_e2e_gbp');
    await gbp.getByTestId('web-tile-impressions').waitFor({ timeout: 15_000 });
    // Six reported days of the last seven (today is not reported yet): flows summed, never averaged.
    expect(await gbp.getByTestId('web-tile-impressions').textContent()).toContain('900');
    expect(await gbp.getByTestId('web-tile-impressions').textContent()).toContain('6 days with data');
    expect(await gbp.getByTestId('web-tile-websiteClicks').textContent()).toContain('36');
    expect(await gbp.getByTestId('web-tile-callClicks').textContent()).toContain('18');
    expect(await gbp.getByTestId('web-tile-directionRequests').textContent()).toContain('24');
    expect(await gbp.getByTestId('web-tile-websiteClickRate').count()).toBe(0); // not a tile of this kind
    // The first drill-down is the day alone; Impressions by surface lists the four surfaces.
    await gbp.getByRole('tab', { name: 'Impressions by surface' }).click();
    const drilldown = gbp.getByTestId('web-drilldown');
    await expect.poll(() => drilldown.locator('tbody tr').count(), { timeout: 15_000 }).toBe(4);
    expect(await drilldown.locator('tbody tr').first().textContent()).toContain('Mobile Search');
    expect(await drilldown.locator('tr[data-dimension="Desktop Maps"]').textContent()).toContain('60');
    const opportunities = gbp.getByTestId('web-opportunities');
    expect(await opportunities.count()).toBe(0);
    expect(await gbp.textContent()).toContain('Nothing below half');
    // D-19: the console link, never a figure; the kind is not offered for connecting while the flag is off.
    const console = gbp.getByTestId('web-ai-search').getByRole('link');
    expect(await console.getAttribute('href')).toBe('https://business.google.com/');
    await page.goto(`${origin}${home.replace('/home', '/settings')}?tab=destinations`);
    const sources = page.getByTestId('destination-sources');
    await sources.waitFor({ timeout: 15_000 });
    expect(await sources.getByTestId('source-ga4_property').count()).toBe(1);
    expect(await sources.getByTestId('source-gbp_location').count()).toBe(0); // not enabled here
    await page.close();
  }, 60_000);

  it('web performance (R2-1): a 30-day period has no previous days and every tile reads insufficient sample', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/performance')}?period=30`);
    const ga4 = page.getByTestId('web-performance').getByTestId('web-destination-dst_e2e_ga4');
    await ga4.getByTestId('web-tile-sessions').waitFor({ timeout: 15_000 });
    const sessions = await ga4.getByTestId('web-tile-sessions').textContent();
    expect(sessions).toContain('insufficient sample (20 and 0 days of 5)');
    expect(sessions).not.toContain('% vs previous');
    expect(sessions).toContain('20 days with data'); // absent days stay absent, never zero
    expect(await ga4.getByTestId('web-tile-keyEvents').textContent()).toContain('60'); // 3 × 20
    await page.close();
  }, 45_000);

  it('web performance (R2-1): a source without a policy allowing reads says so and points at Settings → Destinations', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/performance')}?period=7`);
    const gsc = page.getByTestId('web-performance').getByTestId('web-destination-dst_e2e_gsc');
    await gsc.getByTestId('web-policy-blocked').waitFor({ timeout: 15_000 });
    expect(await gsc.getByTestId('web-policy-blocked').textContent()).toContain(
      'Reads not allowed by the source-use policy (no policy for gsc.reports)',
    );
    expect(await gsc.getByTestId('web-policy-blocked').getByRole('link').getAttribute('href')).toContain(
      'tab=destinations',
    );
    expect(await gsc.getByRole('tab').count()).toBe(0); // no drill-down, no figure
    expect(await gsc.getByTestId('web-tile-clicks').count()).toBe(0);
    expect(await gsc.getByTestId('web-ai-search').getByRole('link').getAttribute('href')).toBe(
      'https://search.google.com/search-console',
    );
    // An admin allows reads: the site's tiles and tabs appear with the search metrics.
    backend.destinations.policies.push({
      id: 'sup_e2e_gsc_reports',
      brandId: E2E.brandId,
      destinationKind: 'search_console_site',
      dataType: 'gsc.reports',
      allowedUses: ['read'],
      retentionDays: null,
      version: 1,
      reviewedAt: new Date().toISOString(),
      reviewDueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      reviewedById: 'usr_e2e',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await page.reload();
    await gsc.getByTestId('web-tile-clicks').waitFor({ timeout: 15_000 });
    expect(await gsc.getByTestId('web-tile-ctr').textContent()).toContain('10.7%'); // 32 ÷ 300 pooled
    expect(await gsc.getByTestId('web-tile-position').textContent()).toContain('weighted mean, not compared');
    await gsc.getByRole('tab', { name: 'Queries' }).click();
    await expect
      .poll(() => gsc.getByTestId('web-drilldown').locator('tr[data-dimension="acme pricing"]').count(), {
        timeout: 15_000,
      })
      .toBe(1);
    const opportunities = gsc.getByTestId('web-opportunities');
    await opportunities.waitFor({ timeout: 15_000 });
    expect(await opportunities.textContent()).toContain('Low CTR query');
    expect(await opportunities.textContent()).toContain('acme pricing');
    backend.destinations.policies.splice(
      backend.destinations.policies.findIndex((p) => p.id === 'sup_e2e_gsc_reports'),
      1,
    );
    await page.close();
  }, 60_000);

  it('settings destinations (R2-1): a source connect starts with Google’s URL as a new-tab link; only enabled sources are offered', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings?tab=destinations')}`);
    const sources = page.getByTestId('destination-sources');
    await sources.waitFor({ timeout: 15_000 });
    expect(await sources.getByTestId('source-ga4_property').count()).toBe(1);
    expect(await sources.getByTestId('source-search_console_site').count()).toBe(0); // not enabled here
    const row = sources.getByTestId('source-ga4_property');
    await row.getByRole('button', { name: 'Connect Google Analytics 4 property' }).click();
    const link = row.getByTestId('authorise-link');
    await expect.poll(() => link.count(), { timeout: 15_000 }).toBe(1);
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
    expect(await link.textContent()).toContain('Open Google authorisation'); // the vendor from sources.list
    const href = (await link.getAttribute('href')) ?? '';
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/connect/callback`);
    expect(await page.locator('iframe').count()).toBe(0);
    expect(backend.destinations.connectStates.size).toBe(1);
    await page.close();
  }, 45_000);

  it('settings destinations (R2-1): a completed flow with two targets offers the choice; confirming one adds the destination', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings?tab=destinations')}`);
    const row = page.getByTestId('destination-sources').getByTestId('source-ga4_property');
    await row.waitFor({ timeout: 15_000 });
    await row.getByRole('button', { name: 'Connect Google Analytics 4 property' }).click();
    await expect.poll(() => row.getByTestId('authorise-link').count(), { timeout: 15_000 }).toBe(1);
    const href = (await row.getByTestId('authorise-link').getAttribute('href')) ?? '';
    const state = new URL(href).searchParams.get('state') ?? '';
    // Google sends the person to the shared callback, which hands state and code to this brand's destinations tab.
    await page.goto(`${origin}/connect/callback?state=${encodeURIComponent(state)}&code=auth_code_ga4`);
    await page.getByTestId('destination-connect-callback').waitFor({ timeout: 15_000 });
    expect(page.url()).toContain('tab=destinations');
    expect(await page.getByRole('tab', { name: 'Destinations' }).getAttribute('aria-selected')).toBe('true');
    await page.getByRole('button', { name: 'Finish connecting' }).click();
    const choose = page.getByTestId('destination-connect-choose');
    await choose.waitFor({ timeout: 15_000 });
    expect(await choose.getByRole('group', { name: 'Choose what this brand reads' }).count()).toBe(1);
    expect(await choose.getByRole('radio').count()).toBe(2);
    expect(await page.getByTestId('destination-connect-completed').count()).toBe(0); // nothing registered yet
    const confirm = choose.getByRole('button', { name: 'Confirm' });
    expect(await confirm.getAttribute('aria-disabled')).toBe('true');
    await choose.getByRole('radio', { name: /Acme app/ }).check();
    await confirm.click();
    await page.getByTestId('destination-connect-completed').waitFor({ timeout: 15_000 });
    expect(await page.getByTestId('destination-connect-completed').textContent()).toContain(
      'Connected: Acme · Acme app (Google Analytics 4 property)',
    );
    const ga4Group = page.getByTestId('destinations-ga4_property');
    await expect.poll(() => ga4Group.textContent(), { timeout: 15_000 }).toContain('properties/9002');
    expect(await ga4Group.textContent()).not.toContain('properties/9001'); // only the chosen target
    expect(backend.destinations.connectChoices.size).toBe(0); // one-shot: the flow is consumed
    expect(backend.destinations.destinations.find((d) => d.externalId === 'properties/9002')).toMatchObject({
      kind: 'ga4_property',
      health: 'healthy',
      status: 'active',
    });
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => page.url()).not.toContain('code=');
    expect(page.url()).toContain('tab=destinations');
    backend.destinations.destinations.splice(
      backend.destinations.destinations.findIndex((d) => d.externalId === 'properties/9002'),
      1,
    );
    await page.close();
  }, 60_000);

  it('settings destinations (R2-1): cancelling the choice discards it and connects nothing', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings?tab=destinations')}`);
    const row = page.getByTestId('destination-sources').getByTestId('source-ga4_property');
    await row.waitFor({ timeout: 15_000 });
    await row.getByRole('button', { name: 'Connect Google Analytics 4 property' }).click();
    await expect.poll(() => row.getByTestId('authorise-link').count(), { timeout: 15_000 }).toBe(1);
    const href = (await row.getByTestId('authorise-link').getAttribute('href')) ?? '';
    const state = new URL(href).searchParams.get('state') ?? '';
    await page.goto(`${origin}/connect/callback?state=${encodeURIComponent(state)}&code=auth_code_ga4`);
    await page.getByTestId('destination-connect-callback').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Finish connecting' }).click();
    const choose = page.getByTestId('destination-connect-choose');
    await choose.waitFor({ timeout: 15_000 });
    const before = backend.destinations.destinations.length;
    await choose.getByRole('button', { name: 'Cancel' }).click();
    await expect
      .poll(() => page.getByTestId('destination-connect-choose').count(), { timeout: 15_000 })
      .toBe(0);
    await expect.poll(() => page.url()).not.toContain('code=');
    expect(backend.destinations.connectChoices.size).toBe(0);
    expect(backend.destinations.destinations.length).toBe(before);
    expect(await page.getByTestId('destinations-ga4_property').textContent()).not.toContain('properties/900');
    await page.close();
  }, 60_000);

  it('settings budgets: the month and day meters, the ledger by kind, and a day limit set by an admin (UX-16)', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings')}?tab=budgets`);
    const budgets = page.getByTestId('budgets');
    await expect.poll(() => budgets.getByTestId('budget-ledger').count(), { timeout: 15_000 }).toBe(1);
    const text = await budgets.textContent();
    expect(text).toContain('$42.50 of $100.00');
    expect(text).toContain('$3.10 of $20.00');
    expect(text).toContain('Model tokens');
    expect(text).toContain('$38.00');
    await page.locator('#budget-limit-day').fill('50');
    await page.locator('#budget-limit-day').press('Enter');
    await expect.poll(() => budgets.textContent(), { timeout: 15_000 }).toContain('$3.10 of $50.00');
    await page.close();
  }, 45_000);
  it('settings admin: the release policy defaults, kill switches with the company-wide override, model routing', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings')}`);
    const tabs = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab');
    await expect
      .poll(() => tabs.allTextContents(), { timeout: 15_000 })
      .toEqual([
        'Channels',
        'Destinations',
        'Mandates',
        'Policy',
        'Skills',
        'Members',
        'Budgets',
        'Model routing',
        'Account',
      ]);
    await page.getByRole('tab', { name: 'Policy' }).click();
    const policy = page.getByTestId('release-policy');
    await expect
      .poll(() => policy.textContent(), { timeout: 15_000 })
      .toContain('defaults below are in force');
    expect(await policy.textContent()).toContain('Hold on revoked facts');
    // No restriction set: generation may use any provider, never one that trains on the brand's content.
    expect(await policy.textContent()).toMatch(/Generation providers.*Any provider/);
    // D-11: a client brand without an active policy needs a distinct approver; an admin can make it internal.
    const brandType = page.getByTestId('brand-type');
    expect(await brandType.textContent()).toContain('Client brand.');
    expect(await policy.textContent()).toMatch(/Distinct approver.*Yes/);
    await page.getByLabel('Change the type').click();
    await page.getByRole('option', { name: 'Internal brand' }).click();
    await brandType.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => brandType.textContent(), { timeout: 15_000 }).toContain('Internal brand.');
    await expect.poll(() => policy.textContent(), { timeout: 15_000 }).toMatch(/Distinct approver.*No/);
    // UX-20 (D-13): the brand-version choice is recorded as a new policy version; `flag` is offered but not enabled.
    expect(await policy.textContent()).toMatch(/On brand version published.*\(default\)/);
    await page.getByLabel('On brand version published').click();
    const flag = page.getByRole('option', { name: /Keep approvals and flag/ });
    expect(await flag.getAttribute('data-disabled')).not.toBeNull();
    await page.keyboard.press('Escape');
    await policy.getByRole('button', { name: 'Save as a new policy version' }).click();
    await expect.poll(() => policy.textContent(), { timeout: 15_000 }).toContain('Policy version 1.');
    expect(await policy.textContent()).toMatch(
      /On brand version published.*Invalidate approvals and hold scheduled posts(?! \(default\))/,
    );
    expect(backend.brands.find((b) => b.id === E2E.brandId)?.classification).toBe('internal');
    await page.getByLabel('Change the type').click();
    await page.getByRole('option', { name: 'Client brand' }).click();
    await brandType.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => brandType.textContent(), { timeout: 15_000 }).toContain('Client brand.');
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
    // Destinations: a brand manager reads the policy table and registers nothing.
    await page.getByRole('tab', { name: 'Destinations' }).click();
    await page.getByTestId('source-use-sup_e2e_gbp_reviews').waitFor({ timeout: 15_000 });
    expect(await page.getByTestId('source-use').getByRole('button', { name: 'Save' }).count()).toBe(0);
    expect(await page.getByTestId('register-destination').count()).toBe(0);
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
    // UX-20: the preview names what the publish reaches, from the review and publishing stores. Whether the
    // settings test above recorded a choice or not, the policy line names today's behaviour.
    const impact = changes.getByTestId('publish-impact');
    await expect
      .poll(() => impact.textContent(), { timeout: 15_000 })
      .toMatch(/Publishing version 2 reaches/);
    const openRequests = [...backend.phase5.requests.values()].filter((r) => r.state === 'open').length;
    const scheduled = [...backend.phase5.publications.values()].filter((p) => p.state === 'scheduled').length;
    expect(await impact.textContent()).toContain(
      `${openRequests} open review ${openRequests === 1 ? 'request' : 'requests'}`,
    );
    expect(await impact.textContent()).toContain(
      `${scheduled} scheduled ${scheduled === 1 ? 'post' : 'posts'}`,
    );
    expect(await impact.getByTestId('publish-impact-policy').textContent()).toContain(
      'Policy: Invalidate approvals and hold scheduled posts',
    );
    const recorded = backend.policyVersions.some((p) => p.state === 'active');
    const policyLine = (await impact.getByTestId('publish-impact-policy').textContent()) ?? '';
    expect(policyLine.includes('(no choice recorded; this is the default)')).toBe(!recorded);
    await page.goto(`${origin}${home.replace('/home', '/system?section=voice')}`);
    await page.getByLabel('Draft copy').fill('A cheap and cheerful roast');
    const findings = page.getByTestId('draft-findings');
    await expect.poll(() => findings.textContent(), { timeout: 15_000 }).toContain('Never write “cheap”');
    await page.close();
  }, 45_000);

  // Runs last: the screens above (home, switcher, portfolio, menu, assets, performance, settings, brand system) under
  // the production CSP.
  it('audit (R2-4): the website shows its last run as tiles labelled lab data, findings with a copyable task and pages by severity', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/performance')}?period=7`);
    const section = page.getByTestId('seo-audit');
    await section.waitFor({ timeout: 15_000 });
    const site = section.getByTestId('seo-audit-dst_e2e_cms');
    await site.getByTestId('seo-audit-tile-pages').waitFor({ timeout: 15_000 });
    expect(await site.getByTestId('seo-audit-tile-pages').textContent()).toContain('42');
    expect(await site.getByTestId('seo-audit-tile-critical').textContent()).toContain('1');
    expect(await site.getByTestId('seo-audit-tile-major').textContent()).toContain('1');
    expect(await site.getByTestId('seo-audit-tile-minor').textContent()).toContain('1');
    // Lab data only: the note is the contract's, and the caps the run hit are named.
    expect(await site.getByTestId('seo-audit-data-note').textContent()).toBe(
      'lab data only; field data not connected',
    );
    expect(await site.getByTestId('seo-audit-limits').textContent()).toContain('depth 3');
    expect(await site.getByTestId('seo-audit-meta').textContent()).toContain('weekly sweep');
    // Findings: worst first, each with its count, example URLs and the task a person copies into a brief.
    const findings = site.getByTestId('seo-audit-findings');
    await findings.waitFor({ timeout: 15_000 });
    expect(await findings.getByRole('listitem').count()).toBe(3);
    const first = findings.getByRole('listitem').first();
    expect(await first.textContent()).toContain('Pages excluded by robots meta');
    expect(await first.textContent()).toContain('Critical');
    expect(await first.textContent()).toContain('/old-offer');
    expect(await first.textContent()).toContain('Confirm 1 page should carry noindex');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await first.getByRole('button', { name: 'Copy task for Pages excluded by robots meta' }).click();
    await expect.poll(() => first.getByRole('button').textContent(), { timeout: 5_000 }).toBe('Task copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      'Confirm 1 page should carry noindex',
    );
    // Pages: all four, then the severity filter narrows to the one critical page.
    const pages = site.getByTestId('seo-audit-pages');
    await expect.poll(() => pages.locator('tbody tr').count(), { timeout: 15_000 }).toBe(4);
    await site.getByRole('button', { name: 'Critical', pressed: false }).click();
    await expect.poll(() => pages.locator('tbody tr').count(), { timeout: 15_000 }).toBe(1);
    expect(await pages.locator('tbody tr').first().getAttribute('data-severity')).toBe('critical');
    expect(await pages.locator('tbody tr').first().textContent()).toContain('robots meta (noindex)');
    await page.close();
  }, 60_000);

  it('audit (R2-4): "Run audit" opens a run for an admin and is disabled while it runs; an analyst cannot start one', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/performance')}?period=7`);
    const site = page.getByTestId('seo-audit').getByTestId('seo-audit-dst_e2e_cms');
    const button = site.getByTestId('seo-audit-run');
    await button.waitFor({ timeout: 15_000 });
    expect(await button.isDisabled()).toBe(false);
    await button.click();
    await expect.poll(() => button.textContent(), { timeout: 15_000 }).toBe('Audit running…');
    expect(await button.isDisabled()).toBe(true);
    expect(backend.destinations.auditRuns.filter((r) => r.outcome === 'running')).toHaveLength(1);
    // The last finished run stays on screen while the new one runs; the summary says so.
    expect(await site.getByTestId('seo-audit-meta').textContent()).toContain('Running');
    expect(await site.getByTestId('seo-audit-tile-pages').textContent()).toContain('42');
    backend.destinations.auditRuns.splice(1);
    backend.role = 'analyst';
    await page.reload();
    await site.getByTestId('seo-audit-run').waitFor({ timeout: 15_000 });
    expect(await site.getByTestId('seo-audit-run').isDisabled()).toBe(true);
    expect(await site.getByTestId('seo-audit-run').getAttribute('title')).toContain('admins and publishers');
    backend.role = 'owner';
    await page.close();
  }, 60_000);

  it('audit (R2-4): a website without a policy allowing cms.audit reads says so and points at Settings → Destinations; nothing is listed', async () => {
    const policies = backend.destinations.policies;
    const removed = policies.splice(
      policies.findIndex((p) => p.dataType === 'cms.audit'),
      1,
    );
    try {
      const page = await signedIn(1440);
      await page.goto(`${origin}${home.replace('/home', '/performance')}?period=7`);
      const site = page.getByTestId('seo-audit').getByTestId('seo-audit-dst_e2e_cms');
      await site.getByTestId('seo-audit-policy-blocked').waitFor({ timeout: 15_000 });
      expect(await site.getByTestId('seo-audit-policy-blocked').textContent()).toContain(
        'no policy for cms.audit',
      );
      expect(
        await site.getByTestId('seo-audit-policy-blocked').getByRole('link').getAttribute('href'),
      ).toContain('tab=destinations');
      expect(await site.getByTestId('seo-audit-tile-pages').count()).toBe(0);
      expect(await site.getByTestId('seo-audit-run').count()).toBe(0);
      await page.close();
    } finally {
      policies.push(...removed);
    }
  }, 60_000);

  it('settings destinations (R2-3): a website is connected with its address, username and application password; the secret is never echoed', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/settings?tab=destinations')}`);
    const form = page.getByTestId('destination-sources').getByTestId('connect-website');
    await form.waitFor({ timeout: 15_000 });
    expect(await form.locator('#website-secret').getAttribute('type')).toBe('password');
    const connect = form.getByRole('button', { name: 'Connect website' });
    expect(await connect.getAttribute('aria-disabled')).toBe('true');
    await form.locator('#website-url').fill('https://blog.acme.example');
    await form.locator('#website-username').fill('ore-editor');
    await form.locator('#website-secret').fill('abcd efgh ijkl mnop');
    await connect.click();
    await form.getByTestId('website-connected').waitFor({ timeout: 15_000 });
    expect(await form.getByTestId('website-connected').textContent()).toContain(
      'Connected: blog.acme.example',
    );
    expect(await form.locator('#website-secret').inputValue()).toBe(''); // typed once, cleared, never shown
    const group = page.getByTestId('destinations-cms_site');
    await expect.poll(() => group.textContent(), { timeout: 15_000 }).toContain('blog.acme.example');
    const added = backend.destinations.destinations.find((d) => d.externalId === 'https://blog.acme.example');
    expect(added).toMatchObject({ kind: 'cms_site', health: 'unknown', grantedScopes: ['articles:write'] });
    expect(JSON.stringify(backend.destinations.destinations)).not.toContain('abcd efgh');
    expect(await group.getByTestId(`destination-${added?.id ?? ''}`).textContent()).toContain('Not checked');
    // A second connect of the same site is a conflict the form explains, not a second row.
    await form.locator('#website-url').fill('https://blog.acme.example');
    await form.locator('#website-username').fill('ore-editor');
    await form.locator('#website-secret').fill('abcd efgh ijkl mnop');
    await connect.click();
    await form.getByTestId('website-conflict').waitFor({ timeout: 15_000 });
    expect(
      backend.destinations.destinations.filter((d) => d.externalId === 'https://blog.acme.example'),
    ).toHaveLength(1);
    backend.destinations.destinations.splice(backend.destinations.destinations.indexOf(added!), 1);
    await page.close();
  }, 60_000);

  it('campaigns (R2-3): a website article package is created with the block editor, revised with a FAQ block, and offered to the website as a target', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/campaigns?brief=brf_accepted')}`);
    await page.locator('#pkg-title').waitFor({ timeout: 15_000 });
    await page.locator('#pkg-title').fill('Why ore and tar last');
    await page.locator('#pkg-kind').click();
    await page.getByRole('option', { name: 'Website article' }).click();
    await page.locator('#pkg-article-title').fill('Why ore and tar last');
    expect(await page.locator('#pkg-article-slug').inputValue()).toBe('why-ore-and-tar-last'); // follows the title
    await page.locator('#pkg-article-excerpt').fill('A short answer.');
    await page.locator('#pkg-article-block-0-text').fill('Ore is heavy.');
    await page.locator('#pkg-article-add').click();
    await page.getByRole('option', { name: 'FAQ (question and answer)' }).click();
    await page.locator('#pkg-article-block-1-question').fill('Is it safe?');
    await page.locator('#pkg-article-block-1-answer').fill('Yes, mostly.');
    await page.getByRole('button', { name: 'Create package' }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('package') ?? '', { timeout: 15_000 })
      .toMatch(/^pkg_/);
    const packageId = new URL(page.url()).searchParams.get('package') ?? '';
    const detail = page.getByTestId('package-detail');
    const summary = detail.getByTestId('article-summary');
    await summary.waitFor({ timeout: 15_000 });
    expect(await summary.textContent()).toContain('/why-ore-and-tar-last');
    expect(await summary.locator('[data-block-type="faq"]').textContent()).toContain(
      'Is it safe? — Yes, mostly.',
    );
    // Revise with the editor: the heading moves above the paragraph and the title changes; revision 2 shows it.
    const editor = detail.getByTestId('article-editor');
    await editor.locator(`#revise-${packageId}-title`).fill('Why ore and tar last longer');
    await editor.locator(`#revise-${packageId}-add`).click();
    await page.getByRole('option', { name: 'Heading' }).click();
    await editor.locator(`#revise-${packageId}-block-2-text`).fill('The question');
    await editor.getByRole('button', { name: 'Move block 3 up' }).click();
    await editor.getByRole('button', { name: 'Move block 2 up' }).click();
    await detail.getByRole('button', { name: 'Create next revision' }).click();
    await expect
      .poll(() => summary.textContent(), { timeout: 15_000 })
      .toContain('Why ore and tar last longer');
    expect(await detail.getByTestId('revision-history').getByRole('listitem').count()).toBe(2);
    expect(await summary.locator('li').first().getAttribute('data-block-type')).toBe('heading');
    const revision = [...backend.phase5.revisions.values()].find(
      (r) => r.contentPackageId === packageId && r.state === 'draft',
    );
    expect(revision?.copy.article?.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'faq']);
    // The website is offered as a target because the package carries an article; a channel stays beside it.
    await detail.getByTestId('target-dst_e2e_cms').getByRole('checkbox').check();
    await detail.getByRole('button', { name: 'Generate variants' }).click();
    await expect
      .poll(() => detail.locator('[data-testid="variant"][data-variant-target="destination"]').count(), {
        timeout: 15_000,
      })
      .toBe(1);
    const row = detail.locator('[data-testid="variant"][data-variant-target="destination"]');
    expect(await row.textContent()).toContain('acme.example (website)');
    expect(await row.getByTestId('variant-publish-mode').textContent()).toContain('draft');
    const variantId = (await row.locator('code').first().textContent()) ?? '';
    expect(variantId).toMatch(/^cv_/);
    expect(backend.phase5.variants.get(variantId)).toMatchObject({
      destinationId: 'dst_e2e_cms',
      channelConnectionId: null,
      settings: { publishMode: 'draft' },
    });
    // The schedule form names the website as the target instead of a channel.
    await page.goto(
      `${origin}${home.replace('/home', `/calendar?schedule=${encodeURIComponent(variantId)}`)}`,
    );
    const badge = page.getByTestId('schedule-target-website');
    await badge.waitFor({ timeout: 15_000 });
    expect(await badge.textContent()).toContain('acme.example (website)');
    await page.close();
  }, 90_000);

  it('calendar (R2-3): a published article shows its read-back and validation; validating again records the new result; it can be reverted to a draft', async () => {
    const page = await signedIn(1440);
    await page.goto(`${origin}${home.replace('/home', '/calendar?publication=pub_article')}`);
    const panel = page.getByTestId('article-panel');
    await panel.waitFor({ timeout: 15_000 });
    expect(await page.getByTestId('publication-target-website').textContent()).toContain(
      'acme.example (website)',
    );
    expect(await panel.getByTestId('article-readback').textContent()).toContain('Read back: draft');
    expect(await panel.getByTestId('article-validation').textContent()).toContain('Page validated');
    await panel.getByTestId('validate-article').click();
    await expect
      .poll(() => panel.getByTestId('article-validation').textContent(), { timeout: 15_000 })
      .toContain('Page validation failed');
    expect(await panel.getByTestId('article-checks').locator('[data-ok="false"]').count()).toBeGreaterThan(0);
    expect(
      backend.phase5.evidence.filter(
        (e) => e.publicationId === 'pub_article' && e.kind === 'rendered_validation',
      ),
    ).toHaveLength(2);
    await page.getByTestId('revert-to-draft').click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByLabel('Reason').fill('Wrong launch date');
    await dialog.getByRole('button', { name: 'Request revert' }).click();
    await expect
      .poll(() => backend.phase5.publication('pub_article').remoteChanges[0]?.kind ?? '', { timeout: 15_000 })
      .toBe('unpublish');
    backend.phase5.settleRemoteChanges('pub_article', 'done');
    await page.reload();
    await expect.poll(() => page.getByTestId('article-unpublished').count(), { timeout: 15_000 }).toBe(1);
    await page.close();
  }, 60_000);

  it('no screen above triggered a Content-Security-Policy violation', () => {
    expect(cspViolations).toEqual([]);
  });
});
