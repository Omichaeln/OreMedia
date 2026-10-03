import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { auditPage, dialogFocusTrap, formatViolations } from './a11y';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { PF } from './mock-facts';
import { startStaticServer } from './static-server';

/**
 * BSC-3 facts workspace in the Brand System: facts grouped by category with origin, sources (a URL opens in a new
 * tab, an asset shows by name), review and validity status and conflicts; filters and search; add a fact with a
 * web address source; a duplicate is reported; an AI suggestion without a source is approved only with a reviewer
 * note; correct (the original is superseded once the correction is approved); merge duplicates; resolve a
 * conflict; mark reviewed; edit a proposal; withdraw with a reason. The BUILT app at desktop and phone widths
 * against the in-process mock transport (`OREMEDIA_E2E=1`). The cases run in order on one backend.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const factsPath = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/system?section=facts`;

describe.skipIf(!enabled)('brand facts workspace (built app in Chromium)', () => {
  const backend = new MockBackend();
  backend.facts.seed();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const fact = (id: string) => {
    const f = backend.facts.facts.find((x) => x.id === id);
    if (!f) throw new Error(`no fact ${id}`);
    return f;
  };
  const card = (text: string) =>
    page
      .getByTestId('fact-card')
      .filter({ has: page.getByTestId('fact-statement').filter({ hasText: text }) });
  const open = async () => {
    await page.goto(`${origin}${factsPath}`);
    await page.getByTestId('facts-workspace').waitFor({ timeout: 15_000 });
    await page.getByTestId('fact-card').first().waitFor({ timeout: 15_000 });
  };
  const choose = async (label: string, option: string) => {
    await page.getByRole('combobox', { name: label }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  const dialog = (name: string) => page.getByRole('dialog', { name });

  const signIn = async (width: number) => {
    page = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 } });
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    await signIn(1280);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  describe('desktop (1280 px)', () => {
    it('groups facts by category with origin, sources, review and validity status and conflicts; no ids on the screen', async () => {
      await open();
      for (const heading of ['Company', 'Offers', 'Locations', 'Differentiators'])
        expect(await page.getByRole('heading', { level: 3, name: new RegExp(`^${heading}`) }).count()).toBe(
          1,
        );
      const website = card('Founded in Harare in 1998');
      expect(await website.getByTestId('fact-origin').textContent()).toBe('Extracted from source');
      const link = website.getByRole('link', { name: /About us/ });
      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('rel')).toContain('noopener');
      expect(await website.getByText('We opened our first studio in Harare in 1998.').count()).toBe(1);
      expect(await website.getByText(/Reviewed .* by E2E Owner/).count()).toBe(1);
      const offer = card('Winter sale');
      expect(await offer.getByText('Asset: Winter sale poster').count()).toBe(1);
      expect(await offer.getByText(/Expiring /).count()).toBe(1);
      expect(await card('seven days a week').getByText('Review due').count()).toBe(1);
      expect(await card('fast turnaround').getByTestId('fact-origin').textContent()).toBe('AI suggestion');
      expect(await card('Head office is in Bulawayo').getByTestId('fact-conflicts').textContent()).toContain(
        'Disagrees with “Founded in Harare in 1998”',
      );
      expect(await card('Founded in 1999').getByText('Superseded', { exact: true }).count()).toBe(1);
      expect(await page.getByText('fact_', { exact: false }).count()).toBe(0);
    }, 45_000);

    it('filters by view, state and category, and searches statements; an empty result offers to clear the filters', async () => {
      await open();
      await choose('Show', 'Due for review');
      await expect.poll(() => page.getByTestId('fact-card').count(), { timeout: 10_000 }).toBe(1);
      expect(await card('seven days a week').count()).toBe(1);
      await choose('Show', 'All facts');
      await page.getByRole('searchbox', { name: 'Search facts' }).fill('winter');
      await expect.poll(() => page.getByTestId('fact-card').count(), { timeout: 10_000 }).toBe(1);
      await page.getByRole('searchbox', { name: 'Search facts' }).fill('nothing like this');
      await page.getByRole('button', { name: 'Clear filters' }).waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await expect.poll(() => page.getByTestId('fact-card').count(), { timeout: 10_000 }).toBe(8);
      await choose('Category', 'Offers');
      await expect.poll(() => page.getByTestId('fact-card').count(), { timeout: 10_000 }).toBe(3);
      await choose('Category', 'Any category');
    }, 45_000);

    it('adds a fact with a web address and an excerpt; the same statement again is reported as already in the brand', async () => {
      await open();
      await page.getByRole('button', { name: 'Add a fact' }).first().click();
      const form = dialog('Add a fact');
      await choose('Category', 'Prices');
      await form.getByLabel('Statement').fill('Prints from $25');
      await form.getByLabel('Scope (optional)').fill('Zimbabwe');
      await form.getByRole('button', { name: 'Add a web address' }).click();
      await form.getByRole('button', { name: 'Propose fact' }).click();
      expect(await form.getByText('Enter a full web address (https://…)').count()).toBe(1); // refused in text
      await form.getByLabel('Web address').fill('https://example.test/prices');
      await form.getByLabel('Excerpt (optional)').fill('Prints start at $25.');
      await form.getByRole('button', { name: 'Propose fact' }).click();
      await card('Prints from $25').waitFor({ timeout: 10_000 });
      const added = backend.facts.facts.find((f) => f.statement === 'Prints from $25');
      expect(added).toMatchObject({
        category: 'price',
        scope: 'Zimbabwe',
        state: 'proposed',
        sources: [{ kind: 'url', ref: 'https://example.test/prices', excerpt: 'Prints start at $25.' }],
      });
      expect(await card('Prints from $25').getByTestId('fact-origin').textContent()).toBe('Entered by you');
      await page.getByRole('button', { name: 'Add a fact' }).first().click();
      await dialog('Add a fact').getByLabel('Statement').fill('prints FROM $25.');
      await dialog('Add a fact').getByRole('button', { name: 'Propose fact' }).click();
      await dialog('Add a fact').getByText('This fact is already in the brand').waitFor({ timeout: 10_000 });
      expect(
        backend.facts.facts.filter((f) => f.statement.toLowerCase().startsWith('prints from')),
      ).toHaveLength(1);
      await page.keyboard.press('Escape');
    }, 45_000);

    it('an AI suggestion without a source needs a reviewer note to be approved; the note is kept as its source', async () => {
      await open();
      await card('fast turnaround').getByRole('button', { name: 'Approve' }).click();
      const approve = dialog('Approve the fact');
      await approve.getByText('AI suggestion, with no source').waitFor({ timeout: 10_000 });
      expect(await dialogFocusTrap(page)).toEqual([]);
      await approve.getByRole('button', { name: 'Approve' }).click();
      expect(await approve.getByText('A reviewer note is required for this fact').count()).toBe(1);
      expect(fact(PF.suggestion).state).toBe('proposed');
      await approve.getByLabel('Reviewer note').fill('Matches the 2026 customer survey');
      await approve.getByRole('button', { name: 'Approve' }).click();
      await expect.poll(() => fact(PF.suggestion).state, { timeout: 10_000 }).toBe('approved');
      expect(fact(PF.suggestion).sources).toContainEqual(
        expect.objectContaining({ kind: 'reviewer', note: 'Matches the 2026 customer survey' }),
      );
      await card('fast turnaround').getByText('Reviewer note: Matches the 2026 customer survey').waitFor();
    }, 45_000);

    it('correcting an approved fact proposes a correction; approving it supersedes the original', async () => {
      await open();
      await card('Founded in Harare in 1998').getByRole('button', { name: 'Correct' }).click();
      const form = dialog('Correct the fact');
      await form.getByLabel('Statement').fill('Founded in Harare in March 1998');
      await form.getByRole('button', { name: 'Propose correction' }).click();
      const correction = card('Founded in Harare in March 1998');
      await correction.waitFor({ timeout: 10_000 });
      expect(await correction.getByText(/Correction$/).count()).toBe(1);
      expect(fact(PF.website).state).toBe('approved'); // applies until the correction is approved
      await correction.getByRole('button', { name: 'Approve' }).click();
      await dialog('Approve the fact').getByText('This is a correction').waitFor();
      await dialog('Approve the fact').getByRole('button', { name: 'Approve' }).click();
      await expect.poll(() => fact(PF.website).state, { timeout: 10_000 }).toBe('superseded');
    }, 45_000);

    it('merges a possible duplicate into the approved fact, resolves a conflict with a note, and marks a fact reviewed', async () => {
      await open();
      const dup = card('Free delivery on orders over $50');
      await dup.getByText('Possible duplicates').waitFor({ timeout: 10_000 });
      await dup.getByRole('button', { name: 'Merge these two facts' }).click();
      const merge = dialog('Merge facts');
      expect(await merge.getByRole('radio', { name: /Free delivery on orders over \$50/ }).isChecked()).toBe(
        true,
      );
      await merge.getByRole('button', { name: 'Merge 2 facts' }).click();
      await expect.poll(() => fact(PF.dupB).state, { timeout: 10_000 }).toBe('superseded');
      expect(fact(PF.dupA).state).toBe('approved');

      await card('Head office is in Bulawayo').getByRole('button', { name: 'Resolve this conflict' }).click();
      const resolve = dialog('Resolve the conflict');
      await resolve.getByRole('radio', { name: 'Both stand: explain why' }).check();
      await resolve.getByRole('button', { name: 'Resolve' }).click();
      expect(await resolve.getByText('Explain why both stand').count()).toBe(1);
      await resolve.getByLabel('Note').fill('Founded in Harare, head office moved later');
      await resolve.getByRole('button', { name: 'Resolve' }).click();
      await expect
        .poll(() => fact(PF.conflicting).conflicts[0]?.status, { timeout: 10_000 })
        .toBe('resolved');

      await card('seven days a week').getByRole('button', { name: 'Mark reviewed' }).click();
      await dialog('Mark the fact reviewed').getByRole('button', { name: 'Mark reviewed' }).click();
      await expect
        .poll(() => new Date(fact(PF.reviewDue).reviewDueAt ?? 0).getTime() > Date.now(), { timeout: 10_000 })
        .toBe(true);
      await expect.poll(() => card('seven days a week').getByText('Review due').count()).toBe(0);
    }, 60_000);

    it('edits a proposal and withdraws a fact only with a reason', async () => {
      await open();
      await card('Prints from $25').getByRole('button', { name: 'Edit' }).click();
      const form = dialog('Edit the proposed fact');
      await form.getByLabel('Statement').fill('Prints from $20');
      await form.getByRole('button', { name: 'Save proposal' }).click();
      await card('Prints from $20').waitFor({ timeout: 10_000 });
      await card('Winter sale').getByRole('button', { name: 'Withdraw' }).click();
      const withdraw = page.getByRole('alertdialog', { name: 'Withdraw the fact' });
      await withdraw.getByRole('button', { name: 'Withdraw' }).click();
      expect(await withdraw.getByText('Give a reason').count()).toBe(1);
      await withdraw.getByLabel('Reason').fill('The sale ended early');
      await withdraw.getByRole('button', { name: 'Withdraw' }).click();
      await expect.poll(() => fact(PF.offer).state, { timeout: 10_000 }).toBe('revoked');
      expect(fact(PF.offer).revokeReason).toBe('The sale ended early');
      await card('Winter sale').getByText('The sale ended early').waitFor();
    }, 45_000);

    it('the workspace passes the accessibility audit at desktop width', async () => {
      await open();
      const violations = await auditPage(page, { narrow: false });
      expect(violations, formatViolations('facts workspace (1280px)', violations)).toEqual([]);
    }, 30_000);
  });

  describe('phone (390 px)', () => {
    beforeAll(async () => {
      await page.close();
      await signIn(390);
    }, 30_000);

    it('reflows without horizontal scrolling, passes the audit, and adds a note-sourced fact by keyboard', async () => {
      await open();
      const violations = await auditPage(page, { narrow: true });
      expect(violations, formatViolations('facts workspace (390px)', violations)).toEqual([]);
      await page.getByRole('button', { name: 'Add a fact' }).first().focus();
      await page.keyboard.press('Enter');
      const form = dialog('Add a fact');
      await form.getByLabel('Statement').waitFor({ timeout: 10_000 });
      await form.getByLabel('Statement').focus();
      await page.keyboard.type('Studio parking is free for customers');
      await form.getByRole('button', { name: 'Add a note' }).focus();
      await page.keyboard.press('Enter');
      await form.getByLabel('Note').focus();
      await page.keyboard.type('Confirmed with the landlord');
      await form.getByRole('button', { name: 'Propose fact' }).focus();
      await page.keyboard.press('Enter');
      await card('Studio parking is free for customers').waitFor({ timeout: 10_000 });
      expect(backend.facts.facts.find((f) => f.statement.startsWith('Studio parking'))?.sources).toEqual([
        { kind: 'other', ref: 'Confirmed with the landlord' },
      ]);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(390);
    }, 45_000);
  });
});
