import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';
import { zip } from '../src/lib/unzip.test';

/**
 * Brand kit: voice and vocabulary extraction (spec 8.2 onboarding), and typography (fonts uploaded or imported from
 * Google Fonts, assigned to type roles with a live preview in the chosen font). The BUILT app at phone width against the
 * in-process mock transport: a draft carrying imported guidelines offers "Extract voice and vocabulary"; a known
 * agent principal starts a run and the page links to it; an unknown principal is refused in text; unsaved edits
 * must be saved or discarded first. Opt-in like the other smokes (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const systemPath = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/system?section=versions`;

describe.skipIf(!enabled)('brand kit: voice and vocabulary extraction (built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const openEditor = async () => {
    await page.goto(`${origin}${systemPath}`);
    await page.getByRole('button', { name: 'Edit brand kit' }).first().click({ timeout: 15_000 });
    await page.getByRole('heading', { name: 'Extract voice and vocabulary' }).waitFor({ timeout: 15_000 });
  };
  const extract = () => page.getByRole('button', { name: 'Extract voice and vocabulary' });

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('an unknown principal is refused in text; a known one starts the run and links to it', async () => {
    await openEditor();
    expect(await extract().getAttribute('aria-disabled')).toBe('true'); // no principal yet
    await page.getByLabel('Agent principal').fill('sp_unknown');
    await extract().click();
    await expect
      .poll(() => page.getByText('ServicePrincipal').count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(await page.getByText('Not started', { exact: false }).count()).toBeGreaterThan(0);
    await page.getByLabel('Agent principal').fill('sp_e2e_onboarding');
    await extract().click();
    const follow = page.getByRole('link', { name: 'Follow the run' });
    await follow.waitFor({ timeout: 15_000 });
    expect(await follow.getAttribute('href')).toBe(
      `/c/${E2E.tenantId}/b/${E2E.brandId}/agents?run=run_e2e_onboarding`,
    );
    expect(await page.getByText('The agent is reading the guidelines').count()).toBe(1);
  }, 45_000);

  it('with unsaved edits the extraction waits until they are saved or discarded', async () => {
    await openEditor();
    await page.getByLabel('Agent principal').fill('sp_e2e_onboarding');
    expect(await extract().getAttribute('aria-disabled')).toBeNull();
    await page.getByLabel('Summary', { exact: true }).fill('Edited but not saved.');
    expect(await extract().getAttribute('aria-disabled')).toBe('true');
    expect(await extract().getAttribute('title')).toBe('Save or discard your changes first');
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect.poll(() => extract().getAttribute('aria-disabled'), { timeout: 15_000 }).toBeNull();
  }, 45_000);

  it('brand skill import: a .skill package (a zip) is unpacked in the browser and becomes a draft; a plain file that is not an archive is refused in text', async () => {
    await page.goto(`${origin}${systemPath}`);
    const input = page.locator('input[type="file"][accept^=".skill"]');
    await input.waitFor({ state: 'attached', timeout: 15_000 });
    // The package Claude exports: a zip of SKILL.md and references, some entries deflated, one non-text file.
    await input.setInputFiles({
      name: 'kinsley-test-brand.skill',
      mimeType: '',
      buffer: zip([
        { path: 'references/', content: '' },
        { path: 'SKILL.md', content: '---\nname: kinsley-test-brand\n---\n# Kinsley test\n', deflate: true },
        { path: 'references/tokens.md', content: '| Primary | `#1f3a2e` |\n| Gold | `#c9a227` |\n' },
        { path: 'templates/index.css', content: ':root{--x:1}', deflate: true },
      ]),
    });
    await page.getByText('Draft version 3 created from kinsley-test-brand').waitFor({ timeout: 15_000 });
    const banner = page.getByText('Draft version 3 created from kinsley-test-brand').locator('..');
    expect(await banner.textContent()).toContain('2 guideline documents kept, 2 colours added');
    expect(await banner.textContent()).toContain('Not imported: templates/index.css');
    expect(backend.guidelineImports.at(-1)).toEqual({
      brandId: E2E.brandId,
      paths: ['SKILL.md', 'references/tokens.md', 'templates/index.css'],
    });
    // A file named .skill that is not a zip is refused before anything is sent.
    await input.setInputFiles({ name: 'notes.skill', mimeType: '', buffer: Buffer.from('# just text\n') });
    await page.getByText('notes.skill is not a zip archive', { exact: false }).waitFor({ timeout: 15_000 });
    expect(backend.guidelineImports).toHaveLength(1);
  }, 45_000);

  it('typography: upload a font, import a Google Fonts family, assign it to a role and preview it', async () => {
    const base = systemPath.replace('?section=versions', '');
    await page.goto(`${origin}${base}?section=typography`);
    await page
      .getByRole('group', { name: 'Version shown' })
      .getByRole('button', { name: /proposed/ })
      .click({ timeout: 15_000 });
    const fonts = page.getByRole('list', { name: 'Brand fonts' });
    await fonts.getByText('Karla').waitFor({ timeout: 15_000 });

    // Upload: a TTF whose browser type is empty is declared by its extension.
    await page.locator('input[type="file"][accept^=".woff2"]').setInputFiles({
      name: 'Brand Serif.ttf',
      mimeType: '',
      buffer: readFileSync(
        new URL('../../../tooling/test-fixtures/fonts/karla/Karla[wght].ttf', import.meta.url),
      ),
    });
    await page.getByText('Processing').first().waitFor({ timeout: 15_000 });
    expect([...backend.fontIntents.values()]).toContainEqual(
      expect.objectContaining({
        originalFilename: 'Brand Serif.ttf',
        declaredMime: 'font/ttf',
        kind: 'font',
      }),
    );
    await page.getByRole('button', { name: 'Refresh' }).first().click();
    await fonts.getByText('Brand Serif').waitFor({ timeout: 15_000 });

    // Google Fonts: an unknown family is refused in text; a known one lists its faces.
    await page.getByLabel('Family', { exact: true }).fill('Nope Sans');
    await page.getByRole('button', { name: 'Import family' }).click();
    await page
      .getByText('Google Fonts has no family "Nope Sans"', { exact: false })
      .waitFor({ timeout: 15_000 });
    await page.getByLabel('Family', { exact: true }).fill('Inter');
    await page.getByRole('button', { name: 'Import family' }).click();
    await page.getByText('Inter: 2 files importing').waitFor({ timeout: 15_000 });
    expect(backend.googleImports.at(-1)).toEqual({
      brandId: E2E.brandId,
      family: 'Inter',
      weights: [400, 700],
      styles: ['normal'],
    });
    // A variable family is one face covering its weight range, not one face per weight asked for.
    await expect.poll(() => fonts.getByText('Inter').count(), { timeout: 15_000 }).toBe(1);
    expect(await fonts.getByText('weights 100–900 (variable)', { exact: false }).count()).toBe(1);
    expect(await fonts.getByText('Google Fonts').count()).toBe(1);

    // Assign Inter at 700 to the body role; the preview line is drawn in it (both subset files registered).
    await page.getByLabel('Body font').click();
    await page.getByRole('option', { name: 'Inter 100–900 (woff2, variable)' }).click();
    await page.getByLabel('Body weight').click();
    await page.getByRole('option', { name: '700', exact: true }).click();
    const family = 'av_font_ast_inter_var';
    await expect
      .poll(
        () =>
          page.evaluate(
            (f) =>
              [...document.fonts]
                .filter((x) => x.family.replace(/"/g, '') === f && x.status === 'loaded')
                .map((x) => x.unicodeRange),
            family,
          ),
        { timeout: 15_000 },
      )
      .toHaveLength(2);
    const preview = page.getByTestId('type-preview-body');
    await expect
      .poll(() => preview.evaluate((el) => getComputedStyle(el).fontFamily), { timeout: 15_000 })
      .toContain(family);
    expect(await preview.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700');
    expect(await page.evaluate((f) => document.fonts.check(`700 16px "${f}"`, 'Aą'), family)).toBe(true);

    await page.getByRole('button', { name: 'Save brand kit' }).click();
    await expect
      .poll(() => backend.lastBrandDraftTypeRoles(), { timeout: 15_000 })
      .toContainEqual({ role: 'body', fontAssetId: 'ast_inter_var', weight: 700, minSizePx: 18 });
  }, 60_000);

  it('brand system: overview tiles open a section; the draft opens it in the editor and saves every voice field', async () => {
    const base = systemPath.replace('?section=versions', '');
    await page.goto(`${origin}${base}`);
    await page
      .getByRole('button', { name: /^Colour/ })
      .first()
      .waitFor({ timeout: 15_000 });
    await page
      .getByRole('main')
      .getByRole('button', { name: /^Voice & writing/ })
      .last()
      .click();
    await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe('voice');
    await page
      .getByRole('group', { name: 'Version shown' })
      .getByRole('button', { name: /proposed/ })
      .click();
    await page.getByLabel('Preferred terms').fill('roast instead of blend, mix');
    await page.getByLabel('Never write').fill('artisanal');
    await page.getByRole('button', { name: 'Save brand kit' }).click();
    await expect
      .poll(() => backend.lastBrandDraftVoice(), { timeout: 15_000 })
      .toMatchObject({
        preferredTerms: [{ use: 'roast', avoid: ['blend', 'mix'] }],
        prohibitedPhrases: ['artisanal'],
      });
  }, 45_000);
});
