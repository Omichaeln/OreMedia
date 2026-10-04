import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { CreativeDocumentV1, Element } from '@oremedia/contracts/creative';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * STU-1b against the BUILT app and the in-process mock transport: the generate panel (defaults from the document and
 * the brand system, the preflight's cost and blocking issues), a durable job (progress, cancel, retry after a failure,
 * reattach after a reload), a first generation landing as an undoable revision with editable elements, a scoped
 * change to the selected headline, and a proposal accepted in part; keyboard at 1280 and 390. Opt-in
 * (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };
const brandPath = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}`;

describe.skipIf(!enabled)('studio generation and refinement (STU-1b, built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const documentId = () => decodeURIComponent(page.url().split('/studio/')[1]?.split('?')[0] ?? '');
  const head = () => backend.head(documentId());
  const doc = (): CreativeDocumentV1 => head().snapshot;
  const byName = (name: string): Element | undefined =>
    doc().pages[0]!.elements.find((e) => e.name.startsWith(name));
  const textOf = (name: string) => {
    const el = byName(name);
    return el?.type === 'text' ? el.text : null;
  };
  const panel = () => page.getByTestId('generate-panel');
  const jobState = () => page.getByTestId('generation-state').getAttribute('data-state');
  const saveKind = () => page.getByTestId('save-state').getAttribute('data-save-kind');
  const noHorizontalScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  const newPhotoFeature = async () => {
    await page.goto(`${origin}${brandPath}/studio`);
    const gallery = page.getByTestId('template-gallery');
    await gallery.getByTestId('gallery-card').first().waitFor({ timeout: 15_000 });
    await gallery.getByRole('button', { name: 'Use Photo feature' }).click();
    await page.waitForURL('**/studio/*', { timeout: 15_000 });
    await panel().waitFor({ timeout: 15_000 });
  };
  const generate = async (message: string) => {
    await panel().getByLabel('Key message').fill(message);
    await expect.poll(() => panel().getByTestId('preflight-cost').count(), { timeout: 15_000 }).toBe(1);
    const start = panel().getByTestId('generation-start');
    await expect.poll(() => start.isEnabled(), { timeout: 15_000 }).toBe(true);
    await start.click();
  };

  /** A finished job on a document a person has edited comes back as a proposal: decline it before the next step. */
  const finishJob = async () => {
    if (await page.getByTestId('proposal').count())
      await page.getByTestId('proposal').getByRole('button', { name: 'Reject' }).click();
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 15_000 }).toBe(0);
    await page.getByTestId('generation-job').getByRole('button', { name: 'Dismiss' }).click();
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    backend.facts.seedProofFacts();
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (err) => console.error('[page error]', err));
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('the panel starts from what is known: content type, format, channels for the format, facts in force; the preflight shows cost and blocks over budget', async () => {
    await newPhotoFeature();
    expect(await panel().getByTestId('gen-format').textContent()).toContain('Square 1080');
    for (const channel of ['instagram_business', 'facebook_page', 'linkedin_page'])
      expect(
        await panel()
          .getByRole('checkbox', { name: new RegExp(channel) })
          .isChecked(),
      ).toBe(true);
    expect(
      await panel()
        .getByRole('checkbox', { name: /\(x\)$/ })
        .isChecked(),
    ).toBe(false);
    expect(await panel().getByRole('checkbox', { name: 'Roasted in Harare every week' }).isVisible()).toBe(
      true,
    );
    // STU-2b: the images generation may use are stills only, never the brand's videos or music.
    await panel()
      .getByText(/^Images \(/)
      .click();
    const images = await panel()
      .getByRole('combobox', { name: /^How to use / })
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(images).toContain('How to use Sample photo');
    expect(images.filter((l) => /Beach walk|City lights|Upbeat music/.test(l ?? ''))).toEqual([]);
    // Nothing to check until the brief says something; then the cost and the outcome are shown.
    expect(await panel().getByTestId('generation-start').isEnabled()).toBe(false);
    await panel().getByLabel('Key message').fill('Fresh beans every week');
    await expect
      .poll(() => panel().getByTestId('preflight-cost').textContent(), { timeout: 15_000 })
      .toMatch(/Estimated cost .*left in the budget/);
    expect(await panel().getByTestId('preflight').textContent()).toContain('becomes the next revision');
    backend.generation.remainingMicros = 1;
    await panel().getByLabel('Objective').fill('Sell the October roast');
    await expect
      .poll(() => panel().getByTestId('preflight-blocking').textContent(), { timeout: 15_000 })
      .toContain('more than what remains of the generation budget');
    expect(await panel().getByTestId('generation-start').isEnabled()).toBe(false);
    backend.generation.remainingMicros = 20_000_000;
  }, 60_000);

  it('a first generation lands as an undoable revision: editable text, the photo placed, the logo untouched', async () => {
    const before = head();
    const logoBefore = doc().pages[0]!.elements.find((e) => e.type === 'logo');
    await panel().getByRole('checkbox', { name: 'Roasted in Harare every week' }).check();
    await generate('Roasted every week');
    await expect.poll(jobState, { timeout: 20_000 }).toBe('completed');
    await expect.poll(() => head().number, { timeout: 15_000 }).toBe(before.number + 1);
    expect(head().authorKind).toBe('agent');
    expect(head().generationInputs).toMatchObject({
      kind: 'generate',
      factIds: ['fact_e2e_roasted'],
      assetVersionIds: ['av_photo'],
    });
    expect(byName('Headline')).toMatchObject({
      type: 'text',
      text: 'Roasted every week',
      factRefs: ['fact_e2e_roasted'],
    });
    expect(doc().pages[0]!.elements.find((e) => e.type === 'image')).toMatchObject({
      assetVersionId: 'av_photo',
    });
    expect(doc().pages[0]!.elements.find((e) => e.type === 'logo')).toEqual(logoBefore);
    expect(await page.getByTestId('generation-job').textContent()).toMatch(
      /\d suggested changes? (was|were) refused/,
    );
    await expect
      .poll(() => page.getByTestId('save-state').textContent(), { timeout: 15_000 })
      .toContain(`revision ${before.number + 1}`);
    // Undo is a new revision that takes the generation back.
    await page.getByTestId('undo').click();
    await expect.poll(() => head().number, { timeout: 15_000 }).toBe(before.number + 2);
    expect(textOf('Headline')).toBe('A headline that names the benefit');
    expect(doc().pages[0]!.elements.some((e) => e.type === 'image')).toBe(false);
    await page.getByTestId('generation-job').getByRole('button', { name: 'Dismiss' }).click();
  }, 60_000);

  it('cancel stops a running job with nothing saved; Try again runs it to the end', async () => {
    const n = head().number;
    backend.generation.holdNext = true;
    await generate('Hold this one');
    await expect.poll(jobState, { timeout: 15_000 }).toBe('generating');
    expect(
      await page.getByRole('progressbar', { name: 'Generation progress' }).getAttribute('aria-valuenow'),
    ).toBe('30');
    await page.getByTestId('generation-cancel').click();
    await expect.poll(jobState, { timeout: 15_000 }).toBe('cancelled');
    expect(head().number).toBe(n);
    await page.getByTestId('generation-job').getByRole('button', { name: 'Try again' }).click();
    await expect.poll(jobState, { timeout: 20_000 }).toBe('completed');
    await expect.poll(() => panel().getByTestId('generation-job').textContent()).toContain('attempt 2');
    await finishJob();
  }, 60_000);

  it('a provider failure is said plainly and Try again recovers', async () => {
    backend.generation.failNext = true;
    await generate('Flaky provider');
    await expect.poll(jobState, { timeout: 20_000 }).toBe('failed');
    expect(await page.getByTestId('generation-job').textContent()).toContain(
      'The model provider did not answer',
    );
    await page.getByTestId('generation-job').getByRole('button', { name: 'Try again' }).click();
    await expect.poll(jobState, { timeout: 20_000 }).toBe('completed');
    await finishJob();
  }, 60_000);

  it('after a reload the panel finds the running job again', async () => {
    backend.generation.holdNext = true;
    await generate('Survive a reload');
    await expect.poll(jobState, { timeout: 15_000 }).toBe('generating');
    const held = [...backend.generation.jobs.values()].at(-1)!;
    await page.reload();
    await panel().waitFor({ timeout: 15_000 });
    await expect.poll(jobState, { timeout: 15_000 }).toBe('generating');
    backend.generation.release(held.id);
    await expect.poll(jobState, { timeout: 20_000 }).toBe('completed');
    await finishJob();
  }, 60_000);

  it('a change to the selected headline is scoped to it and comes back as a proposal; Accept applies it', async () => {
    const bodyBefore = textOf('Body');
    await page
      .getByTestId('layers')
      .getByRole('option', { name: /^Headline/ })
      .click();
    await panel().getByRole('button', { name: 'Change part of it' }).click();
    expect(await panel().getByTestId('refine-scope').textContent()).toContain('Only Headline');
    await panel().getByLabel('What should change').fill('Shorten this headline without changing the layout');
    // STU-2b: the image a refinement may use is a still, never a video or music track.
    await panel().getByLabel('Use an approved image (optional)').click();
    const choices = await page
      .getByRole('listbox')
      .filter({ has: page.getByRole('option', { name: 'No particular image' }) })
      .getByRole('option')
      .allTextContents();
    expect(choices).toContain('Sample photo');
    expect(choices.filter((c) => /Beach walk|City lights|Upbeat music/.test(c))).toEqual([]);
    await page.keyboard.press('Escape');
    const start = panel().getByTestId('refine-start');
    await expect.poll(() => start.isEnabled(), { timeout: 15_000 }).toBe(true);
    await start.click();
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 20_000 }).toBe(1);
    expect(await page.getByTestId('proposal-groups').textContent()).toContain('Shorter headline');
    expect(await page.getByTestId('proposal-overlay').count()).toBe(1);
    const n = head().number;
    await page.getByTestId('proposal-accept').click();
    await expect.poll(() => head().number, { timeout: 15_000 }).toBe(n + 1);
    expect(textOf('Headline')?.split(' ').length).toBeLessThanOrEqual(3);
    expect(textOf('Body')).toBe(bodyBefore);
    expect(head().generationInputs).toMatchObject({ kind: 'refine', acceptedGroupIds: ['g1'] });
  }, 60_000);

  it('a whole-page change is accepted in part: a group left out stays as it was; Undo takes the rest back', async () => {
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Escape'); // clear the selection: the whole page is in scope
    await expect.poll(() => panel().getByTestId('refine-scope').textContent()).toContain('Anything on');
    await panel().getByLabel('What should change').fill('Make the copy more prominent');
    const start = panel().getByTestId('refine-start');
    await expect.poll(() => start.isEnabled(), { timeout: 15_000 }).toBe(true);
    await start.click();
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 20_000 }).toBe(1);
    const groups = page.getByTestId('proposal-groups').getByRole('checkbox');
    expect(await groups.count()).toBeGreaterThanOrEqual(2);
    const styleOf = (name: string) => {
      const el = byName(name);
      return el?.type === 'text' ? el.style : null;
    };
    const bodyBefore = styleOf('Body');
    const headlineBefore = styleOf('Headline');
    await page.getByTestId('proposal-groups').getByRole('checkbox', { name: /body/i }).uncheck();
    expect(await page.getByTestId('proposal-accept').textContent()).toMatch(/^Accept \d of \d$/);
    const n = head().number;
    await page.getByTestId('proposal-accept').click();
    await expect.poll(() => head().number, { timeout: 15_000 }).toBe(n + 1);
    expect(styleOf('Body')).toEqual(bodyBefore);
    expect(styleOf('Headline')).toMatchObject({ sizePx: 80, weight: 800 });
    expect(head().generationInputs?.acceptedGroupIds?.length).toBeGreaterThanOrEqual(1);
    await expect.poll(saveKind, { timeout: 15_000 }).toBe('saved');
    await page.getByTestId('undo').click();
    await expect.poll(() => head().number, { timeout: 15_000 }).toBe(n + 2);
    expect(styleOf('Headline')).toEqual(headlineBefore);
  }, 60_000);

  it('works from the keyboard at 1280 and 390 without horizontal scrolling', async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('tab', { name: /^Generate/ }).focus();
      await page.keyboard.press('Enter');
      await panel().getByRole('button', { name: 'Generate the graphic' }).focus();
      await page.keyboard.press('Enter');
      const message = panel().getByLabel('Key message');
      await message.focus();
      await page.keyboard.type(`Keyboard at ${width}`);
      const start = panel().getByTestId('generation-start');
      await expect.poll(() => start.isEnabled(), { timeout: 15_000 }).toBe(true);
      expect(await noHorizontalScroll()).toBe(true);
      await start.focus();
      await page.keyboard.press('Enter');
      await expect.poll(jobState, { timeout: 20_000 }).toBe('completed');
      // The document had edits of a person (the accepted change, the undo): this one comes back as a proposal.
      await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 15_000 }).toBe(1);
      await page.getByTestId('proposal').getByRole('button', { name: 'Reject' }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 15_000 }).toBe(0);
      await page.getByTestId('generation-job').getByRole('button', { name: 'Dismiss' }).click();
      await message.fill('');
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }, 90_000);
});
