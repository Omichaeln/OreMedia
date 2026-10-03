import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { VideoProjectV1 } from '@oremedia/contracts/video';
import { auditPage, formatViolations } from './a11y';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * STU-3 video AI in the BUILT app (apps/web/dist) against the mock transport (the real storyboard check, assembly and
 * recut compilers and the real timeline reducer behind it; the "model" answers are scripted): write a storyboard
 * from a brief, see what was refused and the gaps, edit it (title, scene order, shot length, asset for the gap),
 * assemble it into the empty video, undo and redo with the keyboard, then ask for a recut, review the proposal's
 * diff, keep one group with the keyboard and accept it, and undo that. Opt-in like the other smokes
 * (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };
const brandPath = (rest: string) =>
  `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;

describe.skipIf(!enabled)('video AI: storyboard, assembly and recut (built app, mock transport)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;
  let documentId = '';

  const head = (): VideoProjectV1 => {
    const doc = backend.video.doc(documentId);
    if (!doc) throw new Error('no video document');
    return backend.video.head(doc).snapshot;
  };
  const headNumber = () => {
    const doc = backend.video.doc(documentId);
    return doc ? backend.video.head(doc).number : 0;
  };
  const clips = () => head().tracks.find((t) => t.kind === 'video')?.items ?? [];
  const saved = () =>
    expect
      .poll(() => page.getByTestId('save-state').getAttribute('data-save-kind'), { timeout: 15_000 })
      .toBe('saved');

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC' });
    page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
    documentId = backend.video.create('AI film', { formatKey: 'video_16x9', fps: 30 }).id;
    backend.videoAi.script.storyboard = {
      title: 'Beach launch',
      scenes: [
        {
          title: 'Hook',
          narration: 'Meet the beach bottle. It keeps drinks cold all day. The best bottle ever made.',
          onScreenText: 'Meet the bottle',
          claims: [
            { text: 'It keeps drinks cold all day.', factIds: ['fct_e2e_cold'] },
            { text: 'The best bottle ever made.', factIds: ['fct_not_approved'] },
          ],
          shots: [{ description: 'Walk on the beach', assetVersionId: 'av_video_beach', durationMs: 3_000 }],
        },
        {
          title: 'City',
          narration: 'From the beach to the city.',
          shots: [
            { description: 'City at night', assetVersionId: 'av_video_city', durationMs: 2_000 },
            { description: 'Drone over the bay', assetVersionId: 'av_invented', durationMs: 2_000 },
          ],
        },
      ],
      gaps: [],
      musicAssetVersionId: 'av_audio_music',
    };
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('writes a storyboard from a brief: refused parts and the gap with its alternatives are shown', async () => {
    await page.goto(`${origin}${brandPath(`studio/${encodeURIComponent(documentId)}`)}`);
    await expect.poll(() => page.getByTestId('video-studio').count(), { timeout: 15_000 }).toBe(1);
    await page.getByRole('tab', { name: 'Storyboard' }).click();
    await page.getByLabel('Objective').fill('Launch the beach bottle');
    await page.getByLabel('Key message').fill('Cold all day');
    await expect.poll(() => page.getByTestId('storyboard-preflight').count()).toBe(1);
    await page.getByTestId('generate-storyboard').click();
    await expect.poll(() => page.getByTestId('storyboard-editor').count(), { timeout: 20_000 }).toBe(1);
    expect(await page.getByTestId('video-job-status').textContent()).toBe('Storyboard ready');
    const panel = page.getByTestId('storyboard-panel');
    expect(await panel.textContent()).toContain(
      'A claim without an approved fact: “The best bottle ever made.”',
    );
    expect(await panel.textContent()).toContain('An asset that is not approved for use (av_invented)');
    const gaps = page.getByTestId('storyboard-gaps');
    expect(await gaps.textContent()).toMatch(/Use an approved still/);
    expect(await gaps.textContent()).toMatch(/Video generation is turned off/);
    // The unsupported claim is gone from the script; the approved one stays as a fact.
    expect(await page.getByLabel('Script (captions are made from it)').first().inputValue()).toBe(
      'Meet the beach bottle. It keeps drinks cold all day.',
    );
    expect(await page.getByTestId('storyboard-length').textContent()).toContain('0:07.00');
    const violations = await auditPage(page, { narrow: false });
    expect(violations, formatViolations('storyboard', violations)).toEqual([]);
  }, 60_000);

  it('edits the storyboard: a title, the scene order (keyboard), a shot length and an asset for the gap', async () => {
    await page.getByLabel('Scene 1 title').fill('Opening');
    await page.getByRole('button', { name: 'Move scene 2 up' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByLabel('Scene 1 title').inputValue()).toBe('City');
    const seconds = page.getByLabel('Seconds');
    await seconds.nth(0).fill('2.5');
    await page.getByLabel('Asset').nth(1).click();
    await page.getByRole('option', { name: /Sample photo/ }).click();
    await expect.poll(() => page.getByTestId('storyboard-length').textContent()).toContain('0:07.50');
    // The edits are kept on the job (server side), so a reload or another device picks them up.
    const draft = () =>
      [...backend.videoAi.jobs.values()].find((j) => j.kind === 'storyboard')?.result?.draft ?? null;
    await expect
      .poll(() => draft()?.scenes.map((sc) => sc.title), { timeout: 5_000 })
      .toEqual(['City', 'Opening']);
    await expect.poll(() => draft()?.scenes[0]?.shots[0]?.durationMs, { timeout: 5_000 }).toBe(2_500);
    // Another device saves the storyboard meanwhile: the next save here is a conflict, never a silent overwrite.
    const job = [...backend.videoAi.jobs.values()].find((j) => j.kind === 'storyboard');
    const theirs = {
      ...(draft() as NonNullable<ReturnType<typeof draft>>),
      title: 'Beach launch, from the phone',
    };
    backend.videoAi.saveDraft({
      jobId: job?.id ?? '',
      expectedVersion: job?.version ?? 0,
      storyboard: theirs,
    });
    await page.getByLabel('Scene 2 title').fill('Opening!');
    await expect
      .poll(() => page.getByTestId('storyboard-draft-conflict').count(), { timeout: 10_000 })
      .toBe(1);
    expect(draft()?.title).toBe('Beach launch, from the phone'); // theirs was not overwritten
    await page.getByTestId('draft-load-latest').click();
    await expect.poll(() => page.getByLabel('Scene 2 title').inputValue()).toBe('Opening');
    expect(await page.getByTestId('storyboard-panel').textContent()).toContain(
      'Beach launch, from the phone',
    );
    expect(await page.getByTestId('storyboard-draft-conflict').count()).toBe(0);
  }, 60_000);

  it('assembles into the empty video at once; undo and redo work from the keyboard', async () => {
    await page.getByTestId('assemble-storyboard').click();
    await expect.poll(() => page.getByTestId('assembled').count(), { timeout: 15_000 }).toBe(1);
    expect(headNumber()).toBe(2);
    // Assembled: the server keeps what was assembled and saves no later draft over it.
    expect(await page.getByTestId('storyboard-draft-stopped').count()).toBe(1);
    const sb = [...backend.videoAi.jobs.values()].find((j) => j.kind === 'storyboard');
    expect(sb?.result?.draft).toBeNull();
    expect(() =>
      backend.videoAi.saveDraft({
        jobId: sb?.id ?? '',
        expectedVersion: sb?.version ?? 0,
        storyboard: sb!.result!.storyboard!,
      }),
    ).toThrow();
    expect(clips().map((c) => [c.assetVersionId, c.startMs])).toEqual([
      ['av_video_city', 0],
      ['av_photo', 2_500],
      ['av_video_beach', 4_500],
    ]);
    expect(head().scenes.map((s) => s.title)).toEqual(['City', 'Opening']);
    const captions = head().tracks.find((t) => t.kind === 'caption')?.items ?? [];
    expect(captions.map((c) => ('text' in c ? c.text : ''))).toContain('It keeps drinks cold all day.');
    expect(head().tracks.find((t) => t.kind === 'audio')?.items[0]).toMatchObject({
      assetVersionId: 'av_audio_music',
    });
    await page.getByTestId('timeline-lanes').focus();
    await page.keyboard.press('Control+z');
    await saved();
    expect(headNumber()).toBe(3);
    expect(clips()).toEqual([]);
    await page.keyboard.press('Control+Shift+z');
    await saved();
    expect(headNumber()).toBe(4);
    expect(clips()).toHaveLength(3);
  }, 60_000);

  it('proposes a recut with a diff; keeping one group with the keyboard accepts only that part; undo restores', async () => {
    const [city] = clips();
    backend.videoAi.script.recut = {
      summary: 'Only the city and a call to action',
      actions: [
        { kind: 'keep_only', itemIds: [city?.id ?? ''] },
        { kind: 'add_cta', text: 'Shop the range', factIds: [] },
      ],
      unsupported: ['Add a drone shot'],
    };
    await page.getByRole('tab', { name: 'AI edit' }).click();
    const instruction = page.getByLabel('What should change?');
    await instruction.fill('Use only the city clip and finish with the call to action');
    await instruction.press('Control+Enter');
    await expect.poll(() => page.getByTestId('video-proposal').count(), { timeout: 20_000 }).toBe(1);
    const conflicts = page.getByTestId('recut-conflicts');
    expect(await conflicts.textContent()).toContain('Add a drone shot');
    const keepOnly = page.getByTestId('group-a1');
    expect(await keepOnly.textContent()).toMatch(/removed/);
    expect(await page.getByTestId('group-a2').textContent()).toMatch(/added/);
    const violations = await auditPage(page, { narrow: false });
    expect(violations, formatViolations('recut proposal', violations)).toEqual([]);
    // Leave out the call to action with the keyboard (Space toggles), accept with Enter.
    await page.getByTestId('keep-a2').focus();
    await page.keyboard.press('Space');
    expect(await page.getByTestId('keep-a2').isChecked()).toBe(false);
    await page.getByTestId('accept-proposal').focus();
    expect(await page.getByTestId('accept-proposal').textContent()).toBe('Accept 1 of 2');
    const before = headNumber();
    await page.keyboard.press('Enter');
    await expect.poll(() => headNumber(), { timeout: 15_000 }).toBe(before + 1);
    expect(clips().map((c) => c.assetVersionId)).toEqual(['av_video_city']);
    const overlays = head().tracks.find((t) => t.kind === 'overlay')?.items ?? [];
    expect(overlays.some((o) => o.element.type === 'text' && o.element.text === 'Shop the range')).toBe(
      false,
    );
    await page.getByTestId('undo').click();
    await saved();
    expect(clips()).toHaveLength(3);
  }, 60_000);

  it('the storyboard and AI edit panels reflow at 390 px without horizontal scrolling', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
    const narrow = await context.newPage();
    await narrow.goto(`${origin}/sign-in`);
    await narrow.getByLabel('Session token').fill(E2E.token);
    await narrow.getByRole('button', { name: 'Continue' }).click();
    await narrow.waitForURL('**/portfolio*', { timeout: 15_000 });
    await narrow.goto(`${origin}${brandPath(`studio/${encodeURIComponent(documentId)}`)}`);
    await expect.poll(() => narrow.getByTestId('video-studio').count(), { timeout: 15_000 }).toBe(1);
    for (const tab of ['Storyboard', 'AI edit']) {
      await narrow.getByRole('tab', { name: tab }).click();
      const violations = await auditPage(narrow, { narrow: true });
      expect(violations, formatViolations(`${tab} at 390 px`, violations)).toEqual([]);
    }
    await context.close();
  }, 60_000);
});
