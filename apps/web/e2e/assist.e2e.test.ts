import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { auditPage, dialogFocusTrap, formatViolations } from './a11y';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * BSC-4 / BSC-5 in the Brand System: the guided setup (sources with their statuses and reasons, the cost before
 * starting, progress by stage and section, review by section with the source passage opened in context), the
 * decisions (accept, edit, reject, undo, accept all, answer a question) and "Review and apply" through the usual save;
 * the section assistant (a ready-made request, a statement kept, suggestions inline as a diff, accept, undo, reject,
 * request alternatives); the history (compare with now, restore with what it reaches shown first); keyboard use and
 * reflow at 1280, 768 and 390 px. The BUILT app against the in-process mock transport (`OREMEDIA_E2E=1`); the cases
 * run in order on one backend.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const systemPath = (query = '') =>
  `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/system${query}`;

describe.skipIf(!enabled)('AI-assisted setup, assistants and history (built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const card = (label: string) =>
    page
      .getByTestId('suggestion-card')
      .filter({ has: page.getByTestId('suggestion-label').filter({ hasText: label }) });
  const sourceRow = (text: string) => page.getByTestId('source-row').filter({ hasText: text });
  const signIn = async (width: number) => {
    page = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 } });
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
  };
  const noHorizontalScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const noIds = async () => {
    const text = (await page.locator('main').textContent()) ?? '';
    return ['bsug_', 'baj_', 'bsrc_', 'bv_'].filter((p) => text.includes(p));
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
    it('adds sources with their status, shows the cost, follows the job and reviews by section with sources', async () => {
      await page.goto(`${origin}${systemPath()}`);
      await page.getByRole('button', { name: 'Import sources' }).click({ timeout: 15_000 });
      const setup = page.getByTestId('assist-setup');
      await setup.waitFor({ timeout: 15_000 });
      expect(await page.getByTestId('source-explainer').count()).toBe(1);
      await page.getByLabel('Website').fill('ore.example');
      await page.getByRole('button', { name: 'Add website' }).click();
      await sourceRow('ore.example').waitFor({ timeout: 10_000 });
      expect(await sourceRow('ore.example').getByTestId('source-status').textContent()).toContain(
        'Read when you start',
      );
      await page.getByLabel('Website').fill('https://blocked.example/');
      await page.getByRole('button', { name: 'Add website' }).click();
      await sourceRow('blocked.example').waitFor({ timeout: 10_000 });
      await page.getByLabel('Title').fill('Tone notes');
      await page.getByLabel('Text', { exact: true }).fill('We write plainly. We never shout.');
      await page.getByRole('button', { name: 'Add text' }).click();
      await sourceRow('Tone notes').waitFor({ timeout: 10_000 });
      expect(await sourceRow('Tone notes').getByTestId('source-status').textContent()).toContain('Read');
      await page.locator('input[type="file"][multiple]').setInputFiles({
        name: 'guide.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
      });
      await sourceRow('guide.pdf').waitFor({ timeout: 10_000 });
      expect(backend.assist.sources.find((s) => s.fileName === 'guide.pdf')).toMatchObject({
        kind: 'document',
        mime: 'application/pdf',
      });
      // The document is not part of this job (left out by the person).
      await page.getByRole('checkbox', { name: 'Use guide.pdf' }).uncheck();
      await page.getByTestId('assist-estimate').getByText('Estimated cost').waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Read the sources and suggest' }).click();
      await page.getByTestId('assist-progress').waitFor({ timeout: 10_000 });
      await page.getByRole('heading', { name: 'Suggestions ready' }).waitFor({ timeout: 30_000 });
      const job = backend.assist.jobs[0]!;
      expect(job.sourceIds.length).toBe(3);
      expect(job.sections.length).toBe(8);
      // The blocked site says why and what to do.
      await page.getByRole('button', { name: 'Import more sources' }).click();
      await sourceRow('blocked.example').getByTestId('source-reason').waitFor({ timeout: 15_000 });
      expect(await sourceRow('blocked.example').getByTestId('source-reason').textContent()).toContain(
        'robots.txt',
      );
      for (const heading of ['Voice & personality', 'Vocabulary', 'Messaging', 'Channel guidance', 'Facts'])
        await page
          .getByRole('heading', { level: 3, name: new RegExp(`^${heading}`) })
          .first()
          .waitFor({ timeout: 10_000 });
      const summary = card('Voice summary');
      expect(await summary.getByTestId('suggestion-diff').textContent()).toContain(
        'Plain-spoken and warm; we explain before we sell.',
      );
      expect(await summary.getByText('From your sources').count()).toBe(1);
      await summary.getByRole('button', { name: 'Open in source' }).click();
      const dialog = page.getByRole('dialog', { name: 'ore.example' });
      await dialog.getByTestId('source-excerpt').locator('mark').waitFor({ timeout: 10_000 });
      expect(await dialog.locator('mark').textContent()).toBe('We roast single-origin coffee in Leeds.');
      expect(await dialogFocusTrap(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: 5_000 });
      expect(await card('Personality trait "Curious"').getByText('No source says this').count()).toBe(1);
      expect(await noIds()).toEqual([]);
      const violations = await auditPage(page, { narrow: false });
      expect(violations, formatViolations('assist setup review (1280px)', violations)).toEqual([]);
    }, 90_000);

    it('accepts, edits, undoes, rejects, accepts a section, answers a question, then reviews and applies the update', async () => {
      await card('Voice summary')
        .getByRole('button', { name: /^Accept Voice summary/ })
        .click();
      await card('Voice summary')
        .getByTestId('suggestion-status')
        .filter({ hasText: 'Accepted' })
        .waitFor({ timeout: 10_000 });
      const proposal = () =>
        backend
          .brandVersionsOf(E2E.brandId)
          .filter((v) => v.state === 'draft')
          .sort((a, b) => b.number - a.number)[0]!;
      expect(proposal().document.voice.summary).toBe('Plain-spoken and warm; we explain before we sell.');
      const curious = card('Personality trait "Curious"');
      await curious.getByRole('button', { name: /^Edit / }).click();
      const edit = page.getByRole('dialog', { name: 'Edit: Personality trait "Curious"' });
      await edit.getByLabel('note').fill('We ask first.');
      await edit.getByRole('button', { name: 'Accept with edits' }).click();
      await curious
        .getByTestId('suggestion-status')
        .filter({ hasText: 'Accepted with your edits' })
        .waitFor({ timeout: 10_000 });
      expect(proposal().document.voice.personality).toEqual([
        {
          trait: 'Curious',
          note: 'We ask first.',
          provenance: { origin: 'user', suggestionId: expect.any(String) },
        },
      ]);
      await page.getByTestId('review-summary').getByRole('button', { name: 'Undo last decision' }).click();
      await curious.getByRole('button', { name: /^Accept / }).waitFor({ timeout: 10_000 });
      expect(proposal().document.voice.personality ?? []).toEqual([]);
      await card('Term "blend"')
        .getByRole('button', { name: /^Reject / })
        .click();
      await card('Term "blend"')
        .getByTestId('suggestion-status')
        .filter({ hasText: 'Rejected' })
        .waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Accept all in Channel guidance' }).click();
      await card('Channel default: cta')
        .getByTestId('suggestion-status')
        .filter({ hasText: 'Accepted' })
        .waitFor({ timeout: 10_000 });
      await page.getByLabel('Do you write in British or American English?').fill('British English.');
      await page.getByRole('button', { name: 'Send answers and update suggestions' }).click();
      await page.getByText('Updated with your answers').waitFor({ timeout: 15_000 });
      expect(backend.assist.jobs[0]!.parentJobId).toBe(backend.assist.jobs[1]!.id);
      const saves = backend.brandSystemSaves.length;
      await page
        .getByTestId('review-summary')
        .last()
        .getByRole('button', { name: 'Review and apply' })
        .click();
      await page.getByTestId('proposal-review').waitFor({ timeout: 15_000 });
      await page.getByTestId('brand-kit-editor').getByRole('button', { name: 'Save', exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Save and apply the brand system?' });
      await confirm
        .getByTestId('publish-impact')
        .getByText('Saving the brand system reaches')
        .waitFor({ timeout: 15_000 });
      await confirm.getByRole('button', { name: 'Save and apply' }).click();
      await page.getByText('Brand system saved').waitFor({ timeout: 15_000 });
      expect(backend.brandSystemSaves.length).toBe(saves + 1);
      expect(backend.brandSystemSaves.at(-1)!.document.voice.summary).toBe(
        'Plain-spoken and warm; we explain before we sell.',
      );
      expect(backend.brandSystemSaves.at(-1)!.document.channelBaseline?.cta).toBe(
        'One clear call to action, last.',
      );
    }, 90_000);

    it('the section assistant suggests inline as a diff; accept, undo and reject; request alternatives', async () => {
      await page.goto(`${origin}${systemPath('?section=voice')}`);
      await page.getByRole('button', { name: 'Ask AI about Voice & personality' }).click({ timeout: 15_000 });
      const dialog = page.getByRole('dialog', { name: 'Ask AI: Voice & personality' });
      await dialog
        .getByRole('button', { name: 'Infer our writing style from these approved examples' })
        .click();
      expect(await dialog.getByLabel('What should it do?').inputValue()).toBe(
        'Infer our writing style from these approved examples',
      );
      const keep = dialog.getByRole('checkbox', { name: /^Summary: / });
      await keep.check();
      await dialog.getByTestId('assist-estimate').getByText('Estimated cost').waitFor({ timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Suggest', exact: true }).click();
      const results = page.getByTestId('section-assistant-results');
      await results.waitFor({ timeout: 10_000 });
      await results.getByRole('heading', { name: 'Suggestions ready' }).waitFor({ timeout: 30_000 });
      const job = backend.assist.jobs[0]!;
      expect(job).toMatchObject({ kind: 'section', sections: ['voice'], preserve: ['voice.summary'] });
      const curious = results.getByTestId('suggestion-card').filter({ hasText: 'Curious' });
      expect(await curious.getByTestId('suggestion-diff').textContent()).toContain('Nothing yet');
      expect(await results.getByText('Voice summary').count()).toBe(0); // kept as it is
      await curious.getByRole('button', { name: /^Accept / }).click();
      await curious
        .getByTestId('suggestion-status')
        .filter({ hasText: 'Accepted' })
        .waitFor({ timeout: 10_000 });
      await results.getByRole('button', { name: 'Undo last decision' }).click();
      await curious.getByRole('button', { name: /^Reject / }).waitFor({ timeout: 10_000 });
      await curious.getByRole('button', { name: /^Reject / }).click();
      await curious
        .getByTestId('suggestion-status')
        .filter({ hasText: 'Rejected' })
        .waitFor({ timeout: 10_000 });
      await results.getByRole('button', { name: 'Request alternatives' }).first().click();
      await expect.poll(() => backend.assist.jobs[0]!.alternativesFor, { timeout: 10_000 }).toBe(job.id);
      await page
        .getByTestId('section-assistant-results')
        .first()
        .getByRole('heading', { name: 'Suggestions ready' })
        .waitFor({ timeout: 30_000 });
    }, 90_000);

    it('lists the history, compares a state with now and restores it with what it reaches shown first', async () => {
      await page.goto(`${origin}${systemPath('?section=history')}`);
      await page.getByTestId('brand-history').waitFor({ timeout: 15_000 });
      expect(await page.getByTestId('history-entry').count()).toBeGreaterThanOrEqual(2);
      const older = page.getByTestId('history-entry').nth(1);
      await older.getByRole('button', { name: /^Compare with now/ }).click();
      const compare = page.getByTestId('history-compare');
      await compare.getByText('Changed: Voice summary').waitFor({ timeout: 10_000 });
      await compare.getByRole('button', { name: 'Restore this state' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Restore this earlier state?' });
      await confirm
        .getByTestId('publish-impact')
        .getByText('Saving the brand system reaches')
        .waitFor({ timeout: 15_000 });
      expect(await dialogFocusTrap(page)).toEqual([]);
      await confirm.getByRole('button', { name: 'Restore and apply' }).click();
      await page.getByText('Earlier state restored and applied').waitFor({ timeout: 15_000 });
      expect(backend.assist.restores).toHaveLength(1);
      expect(await noIds()).toEqual([]);
    }, 60_000);
  });

  describe('tablet (768 px)', () => {
    beforeAll(async () => {
      await page.close();
      await signIn(768);
    }, 30_000);

    it('the setup reflows and is used by keyboard: a website is added with Tab and Enter', async () => {
      await page.goto(`${origin}${systemPath('?assist=setup')}`);
      await page.getByTestId('assist-setup').waitFor({ timeout: 15_000 });
      expect(await noHorizontalScroll()).toBe(true);
      await page.getByLabel('Website').focus();
      await page.keyboard.type('https://keyboard.example');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await sourceRow('keyboard.example').waitFor({ timeout: 10_000 });
      const violations = await auditPage(page, { narrow: false });
      expect(violations, formatViolations('assist setup (768px)', violations)).toEqual([]);
    }, 45_000);
  });

  describe('phone (390 px)', () => {
    beforeAll(async () => {
      await page.close();
      await signIn(390);
    }, 30_000);

    it('suggestions, the assistant and the history reflow without horizontal scrolling and pass the audit', async () => {
      const latestSetup = backend.assist.jobs.find((j) => j.kind === 'setup')!;
      await page.goto(`${origin}${systemPath(`?assist=setup&job=${latestSetup.id}`)}`);
      await page.getByTestId('suggestion-review').waitFor({ timeout: 15_000 });
      await page.getByTestId('suggestion-card').first().waitFor({ timeout: 15_000 });
      expect(await noHorizontalScroll()).toBe(true);
      let violations = await auditPage(page, { narrow: true });
      expect(violations, formatViolations('suggestion review (390px)', violations)).toEqual([]);
      await page.goto(`${origin}${systemPath('?section=vocabulary')}`);
      await page.getByRole('button', { name: 'Ask AI about Vocabulary' }).click({ timeout: 15_000 });
      const dialog = page.getByRole('dialog', { name: 'Ask AI: Vocabulary' });
      await dialog.waitFor({ timeout: 10_000 });
      expect(await dialogFocusTrap(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await page.goto(`${origin}${systemPath('?section=history')}`);
      await page.getByTestId('brand-history').waitFor({ timeout: 15_000 });
      expect(await noHorizontalScroll()).toBe(true);
      violations = await auditPage(page, { narrow: true });
      expect(violations, formatViolations('history (390px)', violations)).toEqual([]);
    }, 60_000);
  });
});
