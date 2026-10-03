import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { LogoRuleV1 } from '@oremedia/contracts/brand';
import { fixtureDocument } from '@oremedia/editor/fixtures';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * BSC-2 logos as first-class files, the BUILT app against the in-process mock transport: an unsafe SVG is refused with
 * words that say what to remove; an SVG uploaded into the secondary slot is previewed as vector (the signed original in
 * an <img>) on a checkerboard and on its allowed ground, with usage guidance saved into the brand system and shown in
 * the read view, and downloaded as a PNG at a chosen width (an attachment). In the Studio a logo is inserted by
 * variant, defaulting to the one allowed on the page's background, carrying that rule's logo version. Phone width for
 * the brand system, desktop for the Studio. Opt-in like the other smokes (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const brandPath = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}`;
const SAFE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><circle cx="50" cy="50" r="40" fill="#e94e1b"/></svg>',
);
const UNSAFE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
);

describe.skipIf(!enabled)('logos: SVG first (built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;
  const svgGets: string[] = [];

  const signIn = async (p: Page) => {
    await p.goto(`${origin}/sign-in`);
    await p.getByLabel('Session token').fill(E2E.token);
    await p.getByRole('button', { name: 'Continue' }).click();
    await p.waitForURL('**/portfolio*', { timeout: 15_000 });
  };
  const applied = () => {
    const brand = backend.brands.find((b) => b.id === E2E.brandId);
    const v = backend.brandVersions.find((x) => x.id === brand?.publishedVersionId);
    if (!v) throw new Error('no applied brand system');
    return v;
  };
  const noHorizontalScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    // No pending proposal: the logo section edits the applied brand system.
    for (const v of backend.brandVersions) if (v.state === 'draft') v.state = 'retired';
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.endsWith('.svg')) svgGets.push(r.url());
    });
    await signIn(page);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('phone: an unsafe SVG is refused with what to remove; an SVG uploaded as secondary previews as vector on its ground and saves with guidance', async () => {
    await page.goto(`${origin}${brandPath}/system?section=logo`);
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: /^Edit / }).click({ timeout: 15_000 });
    const editor = page.getByTestId('brand-kit-editor');
    await editor.waitFor({ timeout: 15_000 });
    const slot = editor.getByTestId('logo-slot-secondary');
    await slot.waitFor({ timeout: 15_000 });
    expect(await slot.locator('input[type="file"]').getAttribute('accept')).not.toContain('pdf');
    expect(await slot.textContent()).toContain('SVG preferred');

    // An SVG carrying a script: refused, and the banner says what to take out.
    await slot
      .locator('input[type="file"]')
      .setInputFiles({ name: 'unsafe-logo.svg', mimeType: 'image/svg+xml', buffer: UNSAFE_SVG });
    const rejected = slot.getByTestId('upload-rejected');
    await rejected.waitFor({ timeout: 15_000 });
    expect(await rejected.textContent()).toContain('contains a script');
    expect(await rejected.textContent()).toContain('svg_script');

    // A clean SVG into the secondary slot: it fills the slot and previews as vector (the original, never inlined).
    await slot
      .locator('input[type="file"]')
      .setInputFiles({ name: 'acme-stacked.svg', mimeType: 'image/svg+xml', buffer: SAFE_SVG });
    await slot.getByTestId('upload-accepted').waitFor({ timeout: 15_000 });
    const grounds = slot.getByTestId('logo-grounds-secondary');
    await grounds.waitFor({ timeout: 15_000 });
    await expect
      .poll(() => grounds.locator('img[src$=".svg"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(await grounds.textContent()).toContain('SVG (vector)');
    expect(await grounds.textContent()).toContain('300×100');
    expect(await slot.locator('svg circle').count()).toBe(0); // the file's markup never enters the page

    // Allowed on paper: a ground tile appears with the logo on it. Guidance is written in plain fields.
    await slot.getByRole('checkbox', { name: 'paper' }).check();
    await expect.poll(() => grounds.getByTestId('logo-ground').count()).toBe(1);
    await slot.getByLabel('Backgrounds guidance').fill('Mid-tone photographs only.');
    await slot.getByLabel('Don’ts').fill('Never recolour the mark\nNever stretch it');
    expect(await noHorizontalScroll()).toBe(true);

    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Save and apply the brand system?' });
    await dialog.getByRole('button', { name: 'Save and apply' }).waitFor({ timeout: 15_000 });
    await expect
      .poll(() => dialog.getByRole('button', { name: 'Save and apply' }).isEnabled(), { timeout: 15_000 })
      .toBe(true);
    await dialog.getByRole('button', { name: 'Save and apply' }).click();
    await expect.poll(() => editor.count(), { timeout: 15_000 }).toBe(0);

    const uploaded = backend.assets.find((a) => a.name === 'acme-stacked.svg');
    expect(uploaded?.file?.mime).toBe('image/svg+xml');
    const rule = applied().document.logoRules.find((r) => r.variant === 'secondary');
    expect(rule).toEqual({
      assetId: uploaded?.id,
      assetVersionId: uploaded?.file?.versionId,
      variant: 'secondary',
      allowedBackgroundColourKeys: ['paper'],
      clearSpaceRatio: 0.5,
      minWidthPx: 96,
      usage: {
        backgroundsNote: 'Mid-tone photographs only.',
        donts: ['Never recolour the mark', 'Never stretch it'],
      },
    });
  }, 90_000);

  it('phone: the read view shows the guidance and downloads a PNG at a chosen width as an attachment', async () => {
    const view = page.getByTestId('logo-view-secondary');
    await view.waitFor({ timeout: 15_000 });
    expect(await view.textContent()).toContain('Never recolour the mark');
    expect(await view.textContent()).toContain('Mid-tone photographs only.');
    await expect.poll(() => view.locator('img[src$=".svg"]').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    await view.getByRole('combobox', { name: 'Secondary logo download format' }).click();
    await page.getByRole('option', { name: 'PNG, 512 px wide' }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      view.getByRole('button', { name: 'Download secondary logo' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('acme-stacked-512px.png');
    expect(backend.downloads.at(-1)).toMatchObject({ format: 'png', width: 512 });
    expect(await noHorizontalScroll()).toBe(true);
  }, 45_000);

  it('desktop Studio: insert a logo by variant, defaulting to the one allowed on the background; it carries that rule’s version', async () => {
    // The document's brand version names two logos with rights: primary on paper, secondary on accent.
    const secondary = backend.assets.find((a) => a.name === 'acme-stacked.svg');
    if (!secondary?.file) throw new Error('the uploaded logo is missing');
    secondary.rights = { owner: 'E2E', licenceRef: null, expiresAt: null };
    backend.assets.unshift({
      id: 'ast_logo_primary',
      kind: 'logo',
      name: 'acme-primary.svg',
      state: 'approved',
      rights: { owner: 'E2E', licenceRef: null, expiresAt: null },
      version: 1,
      createdAt: new Date().toISOString(),
      file: { versionId: 'av_logo_primary', mime: 'image/svg+xml', width: 300, height: 100 },
    });
    const base: Omit<LogoRuleV1, 'assetId' | 'variant'> = {
      allowedBackgroundColourKeys: [],
      clearSpaceRatio: 0.25,
      minWidthPx: 96,
    };
    const fixture = backend.brandVersions.find((v) => v.id === E2E.brandVersionId);
    if (!fixture) throw new Error('fixture brand version missing');
    fixture.document = {
      ...fixture.document,
      logoRules: [
        {
          ...base,
          assetId: 'ast_logo_primary',
          assetVersionId: 'av_logo_primary',
          variant: 'primary',
          allowedBackgroundColourKeys: ['paper'],
        },
        {
          ...base,
          assetId: secondary.id,
          assetVersionId: secondary.file.versionId,
          variant: 'secondary',
          allowedBackgroundColourKeys: ['accent'],
        },
      ],
    };
    const doc = backend.createDocument('Logo layout', {
      ...fixtureDocument(),
      brandVersionId: E2E.brandVersionId,
    });
    const studio = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    studio.on('request', (r) => {
      if (new URL(r.url()).pathname.endsWith('.svg')) svgGets.push(r.url());
    });
    await signIn(studio);
    await studio.goto(`${origin}${brandPath}/studio/${encodeURIComponent(doc.id)}`);
    await studio.getByTestId('document-title').waitFor({ timeout: 15_000 });
    await studio.getByRole('tab', { name: 'Assets' }).click();
    const variant = studio.getByRole('combobox', { name: 'Logo variant' });
    await variant.waitFor({ timeout: 15_000 });
    // The page's background is paper: primary is the one allowed there.
    expect(await variant.textContent()).toContain('Primary (suits this background)');
    await variant.click();
    await studio.getByRole('option', { name: /^Secondary/ }).click();
    expect(await studio.getByText('does not allow this variant on').count()).toBe(1);
    const before = backend.head(doc.id).number;
    await studio.getByRole('button', { name: 'Insert secondary logo' }).click();
    await expect.poll(() => backend.head(doc.id).number, { timeout: 15_000 }).toBe(before + 1);
    const logos = backend
      .head(doc.id)
      .snapshot.pages[0]?.elements.filter((e) => e.type === 'logo' && e.variant === 'secondary');
    expect(logos).toHaveLength(1);
    expect(logos?.[0]).toMatchObject({ assetVersionId: secondary.file.versionId, protected: true });
    // The canvas draws the inserted SVG logo from its vector original, as the export does.
    await expect
      .poll(() => svgGets.some((u) => u.includes(`/e2e-object/${secondary.file?.versionId}.svg`)), {
        timeout: 15_000,
      })
      .toBe(true);
    await studio.close();
  }, 90_000);
  it('a newer version of a pinned logo: the Studio explains why it cannot insert it; the brand system offers to use it', async () => {
    const secondary = backend.assets.find((a) => a.name === 'acme-stacked.svg');
    if (!secondary?.file) throw new Error('the uploaded logo is missing');
    const pinned = secondary.file.versionId;
    secondary.file = { ...secondary.file, versionId: `${pinned}_v2`, previousVersionIds: [pinned] };

    const doc = backend.createDocument('Logo layout 2', {
      ...fixtureDocument(),
      brandVersionId: E2E.brandVersionId,
    });
    const studio = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await signIn(studio);
    await studio.goto(`${origin}${brandPath}/studio/${encodeURIComponent(doc.id)}`);
    await studio.getByTestId('document-title').waitFor({ timeout: 15_000 });
    await studio.getByRole('tab', { name: 'Assets' }).click();
    const variant = studio.getByRole('combobox', { name: 'Logo variant' });
    await variant.waitFor({ timeout: 15_000 });
    await variant.click();
    await studio.getByRole('option', { name: /^Secondary/ }).click();
    const why = studio.getByTestId('logo-unavailable');
    await why.waitFor({ timeout: 15_000 });
    expect(await why.textContent()).toContain('earlier version of this logo');
    expect(
      await studio.getByRole('button', { name: 'Insert secondary logo' }).getAttribute('aria-disabled'),
    ).toBe('true');
    await studio.close();

    await page.goto(`${origin}${brandPath}/system?section=logo`);
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: /^Edit / }).click({ timeout: 15_000 });
    const editor = page.getByTestId('brand-kit-editor');
    const newer = editor.getByTestId('logo-newer-secondary');
    await newer.waitFor({ timeout: 15_000 });
    await newer.getByRole('button', { name: 'Use the newer version' }).click();
    await expect.poll(() => editor.getByTestId('logo-newer-secondary').count()).toBe(0);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Save and apply the brand system?' });
    await expect
      .poll(() => dialog.getByRole('button', { name: 'Save and apply' }).isEnabled(), { timeout: 15_000 })
      .toBe(true);
    await dialog.getByRole('button', { name: 'Save and apply' }).click();
    await expect.poll(() => editor.count(), { timeout: 15_000 }).toBe(0);
    expect(applied().document.logoRules.find((r) => r.variant === 'secondary')?.assetVersionId).toBe(
      `${pinned}_v2`,
    );
  }, 90_000);
});
