import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { P5 } from './mock-phase5';
import { startStaticServer, watchCspViolations, type CspViolation } from './static-server';

/**
 * STU-2a in the BUILT app (apps/web/dist) against the in-process mock transport, with the production security
 * headers: a person uploads video (kind-aware file types and limits), sees it processing, then either the rejection
 * with its reason and detail (a damaged file) or the asset with its duration and an inline player over the editing
 * proxy; a reviewer plays the frozen video export inline with its poster and captions track, in the inbox and in the
 * external portal; no media load is refused by the CSP. Opt-in like the other smokes (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };
const brandPath = (rest: string) =>
  `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;

describe.skipIf(!enabled)('video and audio media (built app in Chromium, mock transport)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  const cspViolations: CspViolation[] = [];

  const signedIn = async (width: number): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'UTC' });
    const seen = await watchCspViolations(context);
    const page = await context.newPage();
    page.on('close', () => {
      cspViolations.push(...seen);
      void context.close();
    });
    page.on('pageerror', (err) => console.error('[page error]', err));
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
    return page;
  };
  /** Opens the upload sheet with the given kind chosen. */
  const openUpload = async (page: Page, kind: string) => {
    await page.goto(`${origin}${brandPath('assets')}`);
    await page.getByRole('button', { name: 'Upload' }).click();
    const sheet = page.getByRole('dialog', { name: 'Upload an asset' });
    await sheet.getByLabel('Kind').click();
    await page.getByRole('option', { name: kind, exact: true }).click();
    return sheet;
  };
  /** Waits until a <video> or <audio> has loaded its metadata (the file reached the browser and decodes). */
  const metadataLoaded = (page: Page, testId: string) =>
    page
      .getByTestId(testId)
      .first()
      .evaluate((el) => (el as HTMLMediaElement).readyState >= 1);

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

  it('upload: video takes video types with its limits; a damaged file is rejected with its reason and what was found', async () => {
    const page = await signedIn(1280);
    const sheet = await openUpload(page, 'video');
    const file = sheet.getByLabel('File');
    expect(await file.getAttribute('accept')).toBe('video/mp4,video/quicktime,video/webm');
    expect(await sheet.textContent()).toContain('up to 1 GB and 10 minutes');
    await file.setInputFiles({
      name: 'damaged-teaser.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.alloc(64, 1),
    });
    // Processing is announced first (aria-live via the status banner), then the outcome.
    await expect
      .poll(() => sheet.getByTestId('upload-queued').textContent(), { timeout: 15_000 })
      .toContain('Processing video or audio');
    const rejected = sheet.getByTestId('upload-rejected');
    await expect.poll(() => rejected.count(), { timeout: 20_000 }).toBe(1);
    expect(await rejected.getAttribute('data-reason')).toBe('media_malformed');
    const text = (await rejected.textContent()) ?? '';
    expect(text).toContain('The file is damaged or incomplete');
    expect(text).toContain('Found: stream 0, offset 0x1c550: partial file.');
    await page.close();
  }, 60_000);

  it('upload: an accepted video shows its duration in the library and plays its proxy inline with the poster', async () => {
    const page = await signedIn(1280);
    const sheet = await openUpload(page, 'video');
    await sheet
      .getByLabel('File')
      .setInputFiles({ name: 'launch-teaser.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(64, 2) });
    await expect.poll(() => sheet.getByTestId('upload-accepted').count(), { timeout: 20_000 }).toBe(1);
    await sheet.getByRole('button', { name: 'Inspect' }).click();
    const inspector = page.getByRole('dialog', { name: 'Asset' });
    const video = inspector.getByTestId('inline-video');
    await expect.poll(() => video.count(), { timeout: 15_000 }).toBe(1);
    expect(await video.getAttribute('aria-label')).toBe('Preview of launch-teaser.mp4');
    expect(await video.getAttribute('src')).toMatch(/\/e2e-object\/av_video_.+-proxy\.webm$/);
    expect(await video.getAttribute('poster')).toMatch(/-poster\.png$/);
    expect(await video.getAttribute('preload')).toBe('metadata');
    await expect.poll(() => metadataLoaded(page, 'inline-video'), { timeout: 15_000 }).toBe(true);
    const detail = (await inspector.textContent()) ?? '';
    expect(detail).toContain('Duration0:15');
    expect(detail).toContain('h264 · 1080×1920 · 30 fps');
    await page.keyboard.press('Escape');
    // The library lists it with its duration.
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'All assets' }).click();
    await expect
      .poll(() => page.getByTestId('asset-list').getByTestId('asset-duration').first().textContent(), {
        timeout: 15_000,
      })
      .toContain('0:15');
    await page.close();
  }, 60_000);

  it('upload: audio takes audio types and plays its proxy under the waveform', async () => {
    const page = await signedIn(390);
    const sheet = await openUpload(page, 'audio');
    expect(await sheet.getByLabel('File').getAttribute('accept')).toBe(
      'audio/mpeg,audio/wav,audio/mp4,audio/aac',
    );
    await sheet
      .getByLabel('File')
      .setInputFiles({ name: 'voiceover.m4a', mimeType: 'audio/x-m4a', buffer: Buffer.alloc(64, 3) });
    await expect.poll(() => sheet.getByTestId('upload-accepted').count(), { timeout: 20_000 }).toBe(1);
    // The browser's audio/x-m4a was declared as the accepted audio/mp4.
    expect([...backend.fontIntents.values()].at(-1)).toMatchObject({
      kind: 'audio',
      declaredMime: 'audio/mp4',
    });
    await sheet.getByRole('button', { name: 'Inspect' }).click();
    const inspector = page.getByRole('dialog', { name: 'Asset' });
    await expect.poll(() => inspector.getByTestId('inline-audio').count(), { timeout: 15_000 }).toBe(1);
    expect(await inspector.getByRole('img', { name: 'Waveform of voiceover.m4a' }).count()).toBe(1);
    await expect.poll(() => metadataLoaded(page, 'inline-audio'), { timeout: 15_000 }).toBe(true);
    await page.close();
  }, 60_000);

  it('review: the frozen video export plays inline with its poster and captions, in the inbox and the portal', async () => {
    backend.phase5.videoExportIds.add('exp_seed');
    try {
      const page = await signedIn(1280);
      await page.goto(`${origin}${brandPath('review')}?request=${P5.requests.open}`);
      const media = page.getByTestId('manifest-media');
      const video = media.getByTestId('inline-video');
      await expect.poll(() => video.count(), { timeout: 15_000 }).toBeGreaterThan(0);
      const first = video.first();
      expect(await first.getAttribute('src')).toBe('/e2e-object/exp_seed.webm');
      expect(await first.getAttribute('poster')).toBe('/e2e-object/exp_seed-poster.png');
      expect(await first.getAttribute('aria-label')).toMatch(/^Rendered video for /);
      const track = first.locator('track');
      expect(await track.getAttribute('kind')).toBe('captions');
      expect(await track.getAttribute('src')).toBe('/e2e-object/exp_seed.vtt');
      await expect.poll(() => metadataLoaded(page, 'inline-video'), { timeout: 15_000 }).toBe(true);
      expect(await media.textContent()).toContain('0:02 · 30 fps');
      // The same player in the external reviewer portal, through a request-bound link.
      await page.getByLabel('Reviewer email').fill('video.reviewer@example.com');
      await page.getByRole('button', { name: 'Create link' }).click();
      await expect.poll(() => page.getByTestId('link-once').count(), { timeout: 15_000 }).toBe(1);
      const link = await page.getByTestId('link-url').inputValue();
      await page.goto('about:blank');
      await page.goto(link);
      await expect
        .poll(() => page.getByTestId('inline-video').count(), { timeout: 15_000 })
        .toBeGreaterThan(0);
      await expect.poll(() => metadataLoaded(page, 'inline-video'), { timeout: 15_000 }).toBe(true);
      await page.close();
    } finally {
      backend.phase5.videoExportIds.clear();
    }
  }, 90_000);

  it('no media request was refused by the production CSP', () => {
    expect(cspViolations).toEqual([]);
  });
});
