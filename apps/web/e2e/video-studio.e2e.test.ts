import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { VideoProjectV1 } from '@oremedia/contracts/video';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * STU-2b video studio in the BUILT app (apps/web/dist) against the in-process mock transport (the real pure timeline
 * reducer behind applyVideo): create a video, build a sequence from the library, trim, split, reorder by dragging,
 * add and edit a caption, undo and redo as new revisions, move a clip with the keyboard, render with progress, cancel
 * and a finished export to play and download; then the same document at 390 px in the list editor. Opt-in like the
 * other smokes (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };
const brandPath = (rest: string) =>
  `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;

describe.skipIf(!enabled)('video studio (built app in Chromium, mock transport)', () => {
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
  const videoItems = () => head().tracks.find((t) => t.kind === 'video')?.items ?? [];
  const saved = () =>
    expect
      .poll(() => page.getByTestId('save-state').getAttribute('data-save-kind'), { timeout: 15_000 })
      .toBe('saved');
  const signIn = async (width: number) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'UTC' });
    const p = await context.newPage();
    p.on('pageerror', (err) => console.error('[page error]', err));
    await p.goto(`${origin}/sign-in`);
    await p.getByLabel('Session token').fill(E2E.token);
    await p.getByRole('button', { name: 'Continue' }).click();
    await p.waitForURL('**/portfolio*', { timeout: 15_000 });
    return p;
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    page = await signIn(1280);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('creates a 9:16 video at 30 fps and opens the timeline studio', async () => {
    await page.goto(`${origin}${brandPath('studio')}`);
    await page.getByLabel('New document title').fill('Launch reel');
    await page.getByLabel('Kind').click();
    await page.getByRole('option', { name: 'Video (timeline)' }).click();
    await page.getByRole('button', { name: 'Create and open' }).click();
    await page.waitForURL('**/studio/doc_*', { timeout: 15_000 });
    documentId = decodeURIComponent(page.url().split('/studio/')[1]?.split('?')[0] ?? '');
    await expect.poll(() => page.getByTestId('video-studio').count()).toBe(1);
    expect(head().format).toEqual({ key: 'video_9x16', width: 1080, height: 1920, fps: 30 });
    await expect.poll(() => page.getByTestId('timeline').count()).toBe(1);
    expect(await page.getByRole('group', { name: 'Video (Video track)' }).count()).toBe(1);
  }, 60_000);

  it('builds a sequence from the library: two clips and music, saved as one revision', async () => {
    const library = page.getByTestId('video-library');
    await library.getByRole('button', { name: /Add Beach walk/ }).click();
    await library.getByRole('button', { name: /Add City lights/ }).click();
    await library.getByRole('tab', { name: 'Audio' }).click();
    await library.getByRole('button', { name: /Add Upbeat music/ }).click();
    await saved();
    expect(videoItems().map((c) => [c.name, c.startMs, c.sourceOutMs - c.sourceInMs])).toEqual([
      ['Beach walk', 0, 6_000],
      ['City lights', 6_000, 4_000],
    ]);
    expect(head().durationMs).toBe(20_000); // the music is 20 s: the project grew to fit it
    expect(await page.getByTestId('timeline-item').count()).toBe(3);
    // Thumbnails from the strip and a waveform from its peaks.
    await expect.poll(() => page.getByTestId('clip-thumbnails').count()).toBeGreaterThan(0);
    await expect.poll(() => page.getByTestId('waveform').count()).toBe(1);
  }, 60_000);

  it('trims a clip in the inspector and splits it at the playhead', async () => {
    await page.getByRole('button', { name: /^Beach walk, 0:00\.00 to 0:06\.00/ }).click();
    const length = page.locator('#clip-length');
    await length.fill('4');
    await length.press('Enter');
    await saved();
    expect(videoItems()[0]).toMatchObject({ startMs: 0, sourceInMs: 0, sourceOutMs: 4_000 });
    // Move the playhead to 2 s from the lanes with the keyboard (Shift+arrow is one second).
    await page.getByTestId('timeline-lanes').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => page.getByTestId('time-readout').textContent()).toContain('0:02.00');
    await page.getByRole('button', { name: /^Beach walk, 0:00\.00 to 0:04\.00/ }).click();
    await page.getByTestId('split').click();
    await saved();
    expect(videoItems().map((c) => [c.startMs, c.sourceInMs, c.sourceOutMs])).toEqual([
      [0, 0, 2_000],
      [2_000, 2_000, 4_000],
      [6_000, 0, 4_000],
    ]);
  }, 60_000);

  it('reorders by dragging a clip onto another (ripple insert)', async () => {
    const city = page.getByRole('button', { name: /^City lights, 0:06\.00 to 0:10\.00/ });
    const first = page.getByRole('button', { name: /^Beach walk, 0:00\.00 to 0:02\.00/ });
    const from = await city.boundingBox();
    const to = await first.boundingBox();
    if (!from || !to) throw new Error('no boxes');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    await saved();
    expect(videoItems().map((c) => [c.name, c.startMs])).toEqual([
      ['City lights', 0],
      ['Beach walk', 4_000],
      ['Beach walk', 6_000],
    ]);
  }, 60_000);

  it('adds a caption and edits its text and timing', async () => {
    await page.getByTestId('add-caption').click();
    await page.getByRole('button', { name: /^Caption “New caption”/ }).click();
    const text = page.getByTestId('caption-text');
    await text.fill('Launch day is here');
    await saved();
    const captions = head().tracks.find((t) => t.kind === 'caption');
    expect(captions?.kind === 'caption' && captions.items.map((c) => c.text)).toEqual(['Launch day is here']);
    const end = page.locator('#caption-end');
    await end.fill('5');
    await end.press('Enter');
    await saved();
    const after = head().tracks.find((t) => t.kind === 'caption');
    expect(after?.kind === 'caption' && after.items[0]?.endMs).toBe(5_000);
  }, 60_000);

  it('undo and redo commit new revisions with the earlier and later timeline', async () => {
    const before = headNumber();
    await page.getByTestId('undo').click();
    await saved();
    expect(headNumber()).toBe(before + 1);
    const undone = head().tracks.find((t) => t.kind === 'caption');
    expect(undone?.kind === 'caption' && undone.items[0]?.endMs).toBe(2_000 + 2_500); // back to its default length (added at 2 s)
    await page.getByTestId('redo').click();
    await saved();
    expect(headNumber()).toBe(before + 2);
    const redone = head().tracks.find((t) => t.kind === 'caption');
    expect(redone?.kind === 'caption' && redone.items[0]?.endMs).toBe(5_000);
  }, 60_000);

  it('moves the selected clip with the keyboard (Shift+arrow: one second) and announces the playhead', async () => {
    const last = page.getByRole('button', { name: /^Beach walk, 0:06\.00 to 0:08\.00/ });
    await last.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await saved();
    expect(videoItems().at(-1)?.startMs).toBe(7_000);
    await expect.poll(() => page.getByTestId('time-live').textContent()).toMatch(/Playhead at/);
  }, 60_000);

  it('renders with progress, cancels, renders again and offers the finished MP4 to play and download', async () => {
    await page.getByRole('tab', { name: 'Render' }).click();
    await page.getByTestId('render-video').click();
    await expect.poll(() => page.getByTestId('render-progress').count(), { timeout: 15_000 }).toBe(1);
    await page.getByTestId('cancel-render').click();
    await expect.poll(() => page.getByText('Render cancelled').count(), { timeout: 15_000 }).toBe(1);
    await page.getByRole('button', { name: 'Render again' }).click();
    await expect
      .poll(() => page.getByTestId('render-progress').getAttribute('aria-valuenow'), { timeout: 15_000 })
      .not.toBe('0');
    await expect.poll(() => page.getByTestId('render-ready').count(), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => page.getByTestId('inline-video').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('download-export').getAttribute('href')).toMatch(/\.webm$/);
    // The project stays open for more edits after the export.
    expect(await page.getByTestId('timeline').count()).toBe(1);
  }, 90_000);

  it('at 390 px the list editor reaches every operation: select, move earlier, inspector, keyboard preview', async () => {
    const narrow = await signIn(390);
    await narrow.goto(`${origin}${brandPath(`studio/${encodeURIComponent(documentId)}`)}`);
    await expect.poll(() => narrow.getByTestId('list-editor').count(), { timeout: 15_000 }).toBe(1);
    expect(await narrow.getByTestId('timeline').count()).toBe(0);
    const before = videoItems().map((c) => c.id);
    await narrow
      .getByRole('button', { name: /Move Beach walk earlier/ })
      .first()
      .click();
    await expect
      .poll(() => narrow.getByTestId('save-state').getAttribute('data-save-kind'), { timeout: 15_000 })
      .toBe('saved');
    expect(videoItems().map((c) => c.id)).toEqual([before[1], before[0], before[2]]);
    await narrow.getByTestId('list-item').first().click();
    await expect.poll(() => narrow.getByTestId('inspector').count()).toBe(1);
    expect(await narrow.getByTestId('split').count()).toBe(0); // the timeline toolbar is not there; the inspector is
    expect(await narrow.getByRole('button', { name: 'Split at playhead' }).count()).toBe(1);
    // The preview is keyboard operable: Space plays and pauses.
    await narrow.getByTestId('preview-stage').focus();
    await narrow.keyboard.press('Space');
    await expect.poll(() => narrow.getByTestId('play-toggle').getAttribute('aria-pressed')).toBe('true');
    await narrow.keyboard.press('Space');
    await expect.poll(() => narrow.getByTestId('play-toggle').getAttribute('aria-pressed')).toBe('false');
    // No horizontal page scroll at 390 px.
    expect(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    await narrow.close();
  }, 60_000);
});
