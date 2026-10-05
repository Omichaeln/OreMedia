import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * Typography as a live specimen (brand system, Typography & layout): every type role the brand system defines,
 * drawn at 100% of its configured size in its own font file, with the values it is drawn with beside it; edits show
 * at once and are saved through the usual Save; the sample text is the preview's alone; a font that does not load,
 * or a weight its file lacks, is said on the specimen instead of passing a fallback off as the brand's font; and the
 * sizes hold at desktop, tablet and phone widths. The BUILT app against the in-process mock transport. Opt-in like
 * the other smokes (`OREMEDIA_E2E=1`). With `OREMEDIA_SCREENSHOT_DIR` set, the three widths are saved there.
 *
 * The fixture brand's roles (packages/editor/src/fixtures.ts) all name the Karla face (`ast_font`, listed as weight
 * 400 as an uploaded file is: its weight read from the subfamily), whose file is the variable Karla[wght].ttf.
 * Karla-Regular.ttf beside it is that file instanced at wght=400 with fontTools (`fonttools varLib.instancer
 * Karla[wght].ttf wght=400`), SIL Open Font License like the original: a static file with no weight 600.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const screenshotDir = process.env['OREMEDIA_SCREENSHOT_DIR'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };
const STATIC_KARLA = readFileSync(
  new URL('../../../tooling/test-fixtures/fonts/karla/Karla-Regular.ttf', import.meta.url),
);

const systemPath = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/system`;
const FAMILY = 'av_font_ast_font';
/** The fixture brand's roles as configured: [role, weight, size px]. */
const CONFIGURED: Array<[string, number, number]> = [
  ['display', 600, 40],
  ['heading', 600, 28],
  ['body', 400, 18],
  ['label', 500, 14],
  ['caption', 400, 12],
];

describe.skipIf(!enabled)('typography specimen (built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const openTypography = async () => {
    await page.goto(`${origin}${systemPath}?section=typography`);
    await page.getByTestId('type-specimen').waitFor({ timeout: 15_000 });
  };
  const preview = (role: string) => page.getByTestId(`type-preview-${role}`);
  const computed = (role: string) =>
    preview(role).evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        family: s.fontFamily,
        weight: s.fontWeight,
        size: s.fontSize,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
      };
    });
  const fontLoaded = () =>
    expect
      .poll(() => page.evaluate((f) => document.fonts.check(`400 16px "${f}"`, 'Aa'), FAMILY), {
        timeout: 15_000,
      })
      .toBe(true);
  const savedRoles = () => {
    const brand = backend.brands.find((b) => b.id === E2E.brandId);
    return backend.brandVersions.find((x) => x.id === brand?.publishedVersionId)?.document.tokens.typeRoles;
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('every configured role is a specimen in its font at its family, size, weight, line height and tracking, labelled with those values and its step in the scale', async () => {
    await openTypography();
    await fontLoaded();
    const rows = page.getByRole('list', { name: 'Type roles, largest first' }).getByRole('listitem');
    expect(await rows.count()).toBe(CONFIGURED.length);
    for (const [i, [role, weight, size]] of CONFIGURED.entries()) {
      const s = await computed(role);
      expect(s.family).toContain(FAMILY);
      expect(s.weight).toBe(String(weight));
      expect(s.size).toBe(`${size}px`);
      expect(parseFloat(s.lineHeight)).toBeCloseTo(size * 1.2, 1);
      expect(['0px', 'normal']).toContain(s.letterSpacing); // no tracking configured: drawn at 0
      expect(await page.getByTestId(`type-size-warning-${role}`).count()).toBe(0);
      const spec = (await page.getByTestId(`type-spec-${role}`).innerText()).replace(/\s+/g, ' ');
      expect(spec).toContain(`scale ${i + 1} of ${CONFIGURED.length}`);
      expect(spec).toContain(`role ${role}`);
      expect(spec).toContain('font Karla');
      expect(spec).toContain(`weight ${weight}`);
      // The fixture roles store a minimum and no size or line height: each is said, not presented as a rule.
      expect(spec).toContain(`specimen size ${size} px (the minimum; no size set)`);
      expect(spec).toContain(`minimum size ${size} px`);
      expect(spec).toContain('line height 1.2 (default; not set)');
      expect(spec).toContain('tracking 0 em (not set)');
    }
    // The variable Karla file draws 600 and 500 (the face is listed as 400): no warning on any specimen.
    expect(await page.locator('[data-testid^="type-warning-"]').count()).toBe(0);
    // The typeface card names the roles it carries; the composed example uses the configured styles.
    expect(await page.getByTestId('typeface-ast_font').innerText()).toContain(
      'Display · Heading · Body · Label · Caption',
    );
    const composedHeadline = page.getByTestId('type-composed').getByRole('heading', { level: 4 });
    expect(await composedHeadline.evaluate((el) => getComputedStyle(el).fontSize)).toBe('40px');
    // Spacing and radii from the brand system, as the reference lays them out.
    expect(await page.getByRole('heading', { name: 'Spacing scale' }).count()).toBe(1);
    expect(await page.getByRole('heading', { name: 'Radii' }).count()).toBe(1);
    // Specimen styles are inline on the specimen: the page's own heading keeps the app font.
    const appFont = await page
      .getByRole('heading', { level: 1 })
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(appFont).not.toContain(FAMILY);
  }, 60_000);

  it('sample text changes every specimen at once; reset restores the samples; nothing is saved', async () => {
    await openTypography();
    const savesBefore = backend.brandSystemSaves.length;
    const before = JSON.stringify(savedRoles());
    const defaultDisplay = await preview('display').innerText();
    await page.getByLabel('Sample text').fill('Harvest week, Nyeri');
    for (const [role] of CONFIGURED) expect(await preview(role).innerText()).toBe('Harvest week, Nyeri');
    await page.getByRole('button', { name: 'Reset sample text' }).click();
    expect(await preview('display').innerText()).toBe(defaultDisplay);
    await page.getByLabel('Sample text').fill('Only on this screen');
    await page.reload();
    await page.getByTestId('type-specimen').waitFor({ timeout: 15_000 });
    expect(await preview('display').innerText()).toBe(defaultDisplay);
    expect(backend.brandSystemSaves.length).toBe(savesBefore);
    expect(JSON.stringify(savedRoles())).toBe(before);
    expect(JSON.stringify(backend.savedBrandDocument ?? {})).not.toContain('Only on this screen');
  }, 45_000);

  it('editing size, weight, tracking and line height redraws the specimen immediately; Save applies it and it holds after a reload', async () => {
    await openTypography();
    await page.getByRole('button', { name: /^Edit / }).click({ timeout: 15_000 });
    const editor = page.getByTestId('brand-kit-editor');
    await editor.waitFor({ timeout: 15_000 });
    await editor.getByTestId('type-specimen').waitFor({ timeout: 15_000 });
    expect((await computed('display')).size).toBe('40px');

    await page.locator('#kit-type-display-min').fill('52');
    expect((await computed('display')).size).toBe('52px');
    await page.getByLabel('Display weight').click();
    await page.getByRole('option', { name: '700', exact: true }).click();
    expect((await computed('display')).weight).toBe('700');
    await page.locator('#kit-type-display-tracking').fill('-0.02');
    expect(parseFloat((await computed('display')).letterSpacing)).toBeCloseTo(52 * -0.02, 1);
    expect((await page.getByTestId('type-spec-display').innerText()).replace(/\s+/g, ' ')).toContain(
      'tracking -0.02 em',
    );
    await page.locator('#kit-type-display-line-height').fill('1.1');
    expect(parseFloat((await computed('display')).lineHeight)).toBeCloseTo(52 * 1.1, 1);
    const displaySpec = (await page.getByTestId('type-spec-display').innerText()).replace(/\s+/g, ' ');
    expect(displaySpec).toContain('line height 1.1');
    expect(displaySpec).not.toContain('default; not set');

    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Save and apply the brand system?' });
    await dialog.getByRole('button', { name: 'Save and apply' }).click({ timeout: 15_000 });
    await expect
      .poll(() => backend.lastSavedBrandTypeRoles(), { timeout: 15_000 })
      .toContainEqual({
        role: 'display',
        fontAssetId: 'ast_font',
        weight: 700,
        minSizePx: 52,
        tracking: -0.02,
        lineHeight: 1.1,
      });
    await expect.poll(() => editor.count(), { timeout: 15_000 }).toBe(0);

    await page.reload();
    await page.getByTestId('type-specimen').waitFor({ timeout: 15_000 });
    await expect.poll(async () => (await computed('display')).size, { timeout: 15_000 }).toBe('52px');
    expect((await computed('display')).weight).toBe('700');
    expect(parseFloat((await computed('display')).letterSpacing)).toBeCloseTo(52 * -0.02, 1);
    expect(parseFloat((await computed('display')).lineHeight)).toBeCloseTo(52 * 1.1, 1);
  }, 60_000);

  it('applied guidance with a size and line height draws them, labels the minimum apart and warns below it', async () => {
    const before = backend.appliedBrandDocument(E2E.brandId);
    const roles = before.tokens.typeRoles.map((r) =>
      r.role === 'body'
        ? { ...r, lineHeight: 1.5 }
        : r.role === 'heading'
          ? { ...r, sizePx: 24 } // its minimum is 28
          : r.role === 'caption'
            ? { ...r, sizePx: 13 } // its minimum is 12
            : r,
    );
    backend.applyBrandSystem(E2E.brandId, { ...before, tokens: { ...before.tokens, typeRoles: roles } });
    try {
      await openTypography();
      await fontLoaded();
      const spec = async (role: string) =>
        (await page.getByTestId(`type-spec-${role}`).innerText()).replace(/\s+/g, ' ');
      // The configured line height, not the default.
      expect(parseFloat((await computed('body')).lineHeight)).toBeCloseTo(18 * 1.5, 1);
      expect(await spec('body')).toContain('line height 1.5');
      expect(await spec('body')).not.toContain('default; not set');
      expect(parseFloat((await computed('label')).lineHeight)).toBeCloseTo(14 * 1.2, 1);
      expect(await spec('label')).toContain('line height 1.2 (default; not set)');
      // The intended size is drawn; the minimum is labelled beside it.
      expect((await computed('heading')).size).toBe('24px');
      expect(await spec('heading')).toContain('specimen size 24 px');
      expect(await spec('heading')).toContain('minimum size 28 px');
      expect((await computed('caption')).size).toBe('13px');
      expect(await spec('caption')).toContain('minimum size 12 px');
      // Below its minimum: said on that specimen only, apart from the font warnings.
      const warning = page.getByTestId('type-size-warning-heading');
      await warning.waitFor({ timeout: 15_000 });
      expect(await warning.innerText()).toContain('Set at 24 px, below this role’s 28 px minimum');
      expect(await warning.innerText()).toContain('Raise the size to at least 28 px');
      expect(await page.locator('[data-testid^="type-size-warning-"]').count()).toBe(1);
      expect(await page.locator('[data-testid^="type-warning-"]').count()).toBe(0);
    } finally {
      backend.applyBrandSystem(E2E.brandId, before);
    }
  }, 45_000);

  it('a font file that does not load is named on every specimen it affects, with what to do', async () => {
    await page.route(`**/e2e-object/${FAMILY}*`, (route) => route.fulfill({ status: 404, body: 'gone' }));
    try {
      await openTypography();
      const warning = page.getByTestId('type-warning-body');
      await warning.waitFor({ timeout: 15_000 });
      expect(await warning.innerText()).toContain('Karla 400 did not load');
      expect(await warning.innerText()).toContain('fallback font');
      expect(await warning.innerText()).toContain(
        'Re-import Karla from Google Fonts or upload its file again',
      );
      expect(await page.locator('[data-testid^="type-warning-"]').count()).toBe(CONFIGURED.length);
      expect(await page.getByTestId('typeface-ast_font').innerText()).toContain('The font file did not load');
    } finally {
      await page.unroute(`**/e2e-object/${FAMILY}*`);
    }
  }, 45_000);

  it('a weight the font file does not have is said on the specimen, not drawn under the configured weight', async () => {
    // A static Karla 400: weights 700 (display, saved above), 600 and 500 are not in it.
    await page.route(`**/e2e-object/${FAMILY}*`, (route) =>
      route.fulfill({ status: 200, contentType: 'font/ttf', body: STATIC_KARLA }),
    );
    try {
      await openTypography();
      const heading = page.getByTestId('type-warning-heading');
      await heading.waitFor({ timeout: 15_000 });
      expect(await heading.innerText()).toContain('Karla has no weight 600');
      expect(await heading.innerText()).toContain('Import or upload Karla at weight 600');
      expect(await page.getByTestId('type-warning-display').innerText()).toContain('no weight 700');
      // Weight 400 is the file's own: body and caption are drawn as labelled.
      expect(await page.getByTestId('type-warning-body').count()).toBe(0);
      expect(await page.getByTestId('type-warning-caption').count()).toBe(0);
    } finally {
      await page.unroute(`**/e2e-object/${FAMILY}*`);
    }
  }, 45_000);

  it('at 1280, 768 and 390 px every specimen keeps its configured size and the page never scrolls sideways', async () => {
    if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
    const expected: Record<string, string> = {
      display: '52px',
      heading: '28px',
      body: '18px',
      label: '14px',
      caption: '12px',
    };
    for (const [name, width] of [
      ['desktop', 1280],
      ['tablet', 768],
      ['mobile', 390],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await openTypography();
      await fontLoaded();
      for (const [role, size] of Object.entries(expected)) expect((await computed(role)).size).toBe(size);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      if (screenshotDir) {
        // The brand screens scroll inside their own column, so the window is made as tall as the page for the shot.
        await page.setViewportSize({ width, height: 3600 });
        await page.screenshot({ path: `${screenshotDir}/typography-${name}.png` });
      }
    }
  }, 90_000);
});
