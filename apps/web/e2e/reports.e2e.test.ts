import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ReportFiguresV1 } from '@oremedia/contracts/reports';
import { auditPage, formatViolations, keyboardPath } from './a11y';
import { createMockHandler, createMockRouter, E2E, MockBackend, t } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * D-29 Reports in the BUILT app against the in-process mock transport: the Recent list, a draft created and
 * updated at its version, the sections switching pages on and off with their numbers, the executive summary edited
 * and saved, the preview's figures equal to what the mock's measurement data composes (flows summed, the rate
 * pooled, reach never totalled), the assistant's draft added and the honest "unavailable" answer, the send path
 * that records a send and never claims an email, the auto-draft switch's honest label, the keyboard path and the
 * accessibility audit at 390 and 1280 px. Opt-in like the other smokes (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };
const fmtN = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-GB'));
const fmtRate = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

describe.skipIf(!enabled)('reports (built app in Chromium, mock transport)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const brandPath = (rest: string) =>
    `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;
  const month = new Date().toISOString().slice(0, 7);
  /** What the mock composes for the month, as the API would: the expectation the preview is checked against. */
  const figures = (): Promise<ReportFiguresV1> =>
    t.createCallerFactory(createMockRouter(backend))({
      headers: { authorization: `Bearer ${E2E.token}`, 'x-oremedia-tenant': E2E.tenantId },
      correlationId: 'e2e-reports',
    }).reports.figures({ brandId: E2E.brandId, periodMonth: month, compareMode: 'previous_month' });

  const open = async (rest = 'reports') => {
    await page.goto('about:blank');
    await page.goto(`${origin}${brandPath(rest)}`);
    await page.getByTestId('report-page-cover').waitFor({ timeout: 20_000 });
  };
  const newContext = async (width: number, theme: 'light' | 'dark' = 'light') => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, timezoneId: 'UTC', reducedMotion: 'reduce' });
    await ctx.addInitScript((th) => {
      try {
        localStorage.setItem('oremedia.theme', th);
      } catch {
        // storage blocked
      }
    }, theme);
    const p = await ctx.newPage();
    p.on('pageerror', (err) => console.error('[page error]', err));
    await p.goto(`${origin}/sign-in`);
    await p.getByLabel('Session token').fill(E2E.token);
    await p.getByRole('button', { name: 'Continue' }).click();
    await p.waitForURL('**/portfolio*', { timeout: 15_000 });
    return { ctx, p };
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    ({ ctx: context, p: page } = await newContext(1280));
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('Reports is in the brand navigation after Performance; the Recent list names brand, month and state', async () => {
    await page.goto(`${origin}${brandPath('home')}`);
    const nav = page.getByRole('navigation', { name: 'Brand sections' });
    const labels = await nav.getByRole('link').allTextContents();
    const perf = labels.findIndex((l) => l.startsWith('Performance'));
    expect(labels[perf + 1]).toMatch(/^Reports/);
    await nav.getByRole('link', { name: /^Reports/ }).click();
    await page.waitForURL('**/reports*', { timeout: 15_000 });
    await page.getByTestId('report-page-cover').waitFor({ timeout: 20_000 });
    const recent = page.getByRole('list', { name: 'Recent reports' });
    const rows = recent.getByRole('button');
    expect(await rows.count()).toBe(1);
    expect(await rows.nth(0).textContent()).toContain(E2E.brandName);
    expect(await rows.nth(0).textContent()).toContain('Sent');
    expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('Reports');
  }, 45_000);

  it('the preview’s figures are the mock’s measurement data composed under D-15 (flows summed, the rate pooled, reach never totalled)', async () => {
    await open();
    const f = await figures();
    const impressions = f.figures.find((x) => x.key === 'impressions')!;
    const engagement = f.figures.find((x) => x.key === 'engagement')!;
    const rate = f.figures.find((x) => x.key === 'rate:engagement/impressions')!;
    expect(impressions.value).not.toBeNull();
    expect(await page.getByTestId('report-figure-impressions').textContent()).toContain(fmtN(impressions.value));
    expect(await page.getByTestId('report-figure-engagement').textContent()).toContain(fmtN(engagement.value));
    expect(await page.getByTestId('report-figure-rate:engagement/impressions').textContent()).toContain(fmtRate(rate.value));
    expect(await page.getByTestId('report-figure-reach').textContent()).toContain('Not summed');
    expect(await page.getByTestId('report-sample').textContent()).toContain(`${f.sample.current}`);
    if (!f.sample.sufficient) expect(await page.getByTestId('report-sample').textContent()).toContain('insufficient sample');
    for (const c of f.channels) {
      const row = page.getByTestId(`report-channel-${c.channelConnectionId}`);
      expect(await row.textContent()).toContain(c.displayName);
      expect(await row.textContent()).toContain(fmtN(c.impressions));
      expect(await row.textContent()).toContain(fmtRate(c.engagementRate));
    }
    const top = f.posts.ranked[0];
    if (top) expect(await page.getByTestId(`report-post-${top.publicationId}`).textContent()).toContain(fmtN(top.engagement));
    for (const r of f.recommendations)
      expect(await page.getByTestId(`report-recommendation-${r.id}`).textContent()).toContain(r.title);
  }, 45_000);

  it('sections switch pages on and off and renumber; at least one content page stays', async () => {
    await open();
    expect(await page.getByTestId('report-section-channels').textContent()).toContain('p. 3');
    await page.getByTestId('report-section-channels').click();
    await expect.poll(() => page.getByTestId('report-page-channels').count()).toBe(0);
    expect(await page.getByTestId('report-section-posts').textContent()).toContain('p. 3');
    expect(await page.getByTestId('report-section-channels').textContent()).toContain('—');
    expect(await page.getByTestId('report-page-posts').textContent()).toContain('3 / 4');
    await page.getByTestId('report-section-channels').click();
    await expect.poll(() => page.getByTestId('report-page-channels').count()).toBe(1);
    for (const s of ['overview', 'channels', 'posts', 'recommendations']) await page.getByTestId(`report-section-${s}`).click();
    // The fourth click is refused: the toggle stays on and the toast says why.
    expect(await page.getByTestId('report-section-recommendations').getAttribute('aria-checked')).toBe('true');
    await page.getByText('Keep at least one content section').waitFor({ timeout: 5_000 });
  }, 45_000);

  it('the summary is edited and saved as the month’s draft (version 0), then updated at its version; Recent lists it', async () => {
    await open();
    await page.getByTestId('report-summary').fill('September in one paragraph.');
    expect(await page.getByTestId('report-summary-preview').textContent()).toContain('September in one paragraph.');
    const before = backend.requests.filter((r) => r.path === 'reports.save').length;
    await page.getByTestId('report-save').click();
    await page.getByText('Draft saved').waitFor({ timeout: 10_000 });
    const calls = backend.requests.filter((r) => r.path === 'reports.save').slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['idempotency-key']).toBeTruthy();
    const saved = backend.reports.reports.get(month)!;
    expect(saved).toMatchObject({ executiveSummary: 'September in one paragraph.', state: 'draft', version: 0 });
    await page.getByTestId('report-summary').fill('September, edited.');
    await page.getByTestId('report-save').click();
    await expect.poll(() => backend.reports.reports.get(month)?.version, { timeout: 10_000 }).toBe(1);
    const recent = page.getByRole('list', { name: 'Recent reports' });
    await expect.poll(() => recent.getByRole('button').count(), { timeout: 10_000 }).toBe(2);
    expect(await recent.getByRole('button').nth(0).textContent()).toContain('Draft');
    await page.reload();
    await page.getByTestId('report-page-cover').waitFor({ timeout: 20_000 });
    expect(await page.getByTestId('report-summary').inputValue()).toBe('September, edited.');
  }, 60_000);

  it('Re-draft fills the summary from the gateway, labelled a draft over the computed facts; without a gateway it says so', async () => {
    await open();
    await page.getByRole('button', { name: 'Re-draft' }).click();
    await expect.poll(() => page.getByTestId('report-summary').inputValue(), { timeout: 10_000 }).toContain('Draft:');
    expect(await page.getByTestId('report-summary-note').textContent()).toContain('a draft, edit freely');
    expect(backend.reports.drafts.at(-1)?.facts.join('\n')).toContain('Impressions');
    backend.reports.drafterAvailable = false;
    await page.getByRole('button', { name: 'Re-draft' }).click();
    await page.getByText('No AI model is configured for this service.').first().waitFor({ timeout: 10_000 });
    // The assistant answers the same way, and the summary stays editable.
    await page.getByLabel('What’s missing from the report?').fill('We should test a weekly reel series next month');
    await page.getByRole('button', { name: 'Ask' }).click();
    await page.getByRole('log', { name: 'Assistant conversation' }).getByText('No AI model is configured for this service.').waitFor({ timeout: 10_000 });
    backend.reports.drafterAvailable = true;
    await page.getByLabel('What’s missing from the report?').fill('We should test a weekly reel series next month');
    await page.getByRole('button', { name: 'Ask' }).click();
    const proposal = page.getByTestId('report-proposal');
    await proposal.waitFor({ timeout: 10_000 });
    expect(await proposal.textContent()).toContain('Recommendations · draft');
    await proposal.getByRole('button', { name: 'Add to report' }).click();
    await expect.poll(() => page.getByTestId('report-page-recommendations').textContent(), { timeout: 10_000 }).toContain('We should test a weekly reel series next month.');
  }, 60_000);

  it('Send to client: email is not configured, so the send is recorded as "Mark as sent" with the PDF, never claimed', async () => {
    await open();
    await page.getByRole('button', { name: 'Send to client' }).click();
    const form = page.getByTestId('report-send');
    await form.waitFor({ timeout: 10_000 });
    expect(await form.textContent()).toContain('Email delivery is not configured');
    expect(await form.textContent()).toContain('no mail service');
    expect(await form.getByRole('button').allTextContents()).not.toContain('Send report');
    await form.getByLabel('Sent to').fill('kofi@acme.example');
    await form.getByRole('button', { name: 'Mark as sent' }).click();
    await page.getByText('Nothing was emailed: send the PDF yourself.').waitFor({ timeout: 10_000 });
    expect(backend.reports.reports.get(month)).toMatchObject({ state: 'sent', sentTo: 'kofi@acme.example' });
    const recent = page.getByRole('list', { name: 'Recent reports' });
    await expect.poll(() => recent.getByRole('button').nth(0).textContent(), { timeout: 10_000 }).toContain('Sent');
    // Download PDF prints: the pages carry their print attributes and the browser's print is what runs.
    await page.evaluate(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => {
        (window as unknown as { __printed: number }).__printed += 1;
      };
    });
    await page.getByRole('button', { name: 'Download PDF' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed), { timeout: 5_000 }).toBe(1);
    expect(await page.locator('[data-report-page]').count()).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('the auto-draft switch is a stored preference whose label says the schedule is not active', async () => {
    await open();
    const sw = page.getByTestId('report-auto-draft');
    expect(await sw.textContent()).toContain('not active on this deployment yet');
    expect(await sw.getAttribute('aria-checked')).toBe('false');
    await sw.click();
    await expect.poll(() => sw.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true');
    expect(backend.reports.preferences.autoDraft).toBe(true);
    await page.getByText('no job drafts on the 1st').waitFor({ timeout: 10_000 });
  }, 45_000);

  it('a reviewer reads the report and its figures but cannot save, draft or send (the server’s refusal is shown)', async () => {
    backend.role = 'reviewer';
    try {
      await open();
      await page.getByTestId('report-summary').fill('A reviewer typed.');
      await page.getByTestId('report-save').click();
      await page.getByText('report.edit').waitFor({ timeout: 10_000 });
    } finally {
      backend.role = 'owner';
    }
  }, 45_000);

  for (const width of [390, 1280])
    it(`keyboard path and accessibility audit at ${width} px, light and dark`, async () => {
      for (const theme of ['light', 'dark'] as const) {
        const { ctx, p } = await newContext(width, theme);
        try {
          await p.goto(`${origin}${brandPath('reports')}`);
          await p.getByTestId('report-page-cover').waitFor({ timeout: 20_000 });
          await p.getByRole('button', { name: 'Send to client' }).click();
          await p.getByTestId('report-send').waitFor({ timeout: 10_000 });
          const violations = await auditPage(p, { narrow: width <= 400 });
          expect(violations, formatViolations(`reports (${theme}, ${width}px)`, violations)).toEqual([]);
          expect(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          if (theme === 'light') {
            const result = await keyboardPath(p);
            expect(result.unreached, formatViolations('reports keyboard reach', result.unreached)).toEqual([]);
            expect(result.invisibleFocus, formatViolations('reports focus visible', result.invisibleFocus)).toEqual([]);
          }
        } finally {
          await ctx.close();
        }
      }
    }, 180_000);
});
