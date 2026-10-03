import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';
import { zip } from './zip-writer';

/**
 * Brand system (D-22): one brand system per brand, edited in place section by section and applied when saved, with
 * what a save reaches confirmed first (UX-20) and a conflict when someone else saved since; proposed updates (an
 * imported brand skill, an agent's suggestion) reviewed and applied, or discarded. Also voice and vocabulary
 * extraction (spec 8.2 onboarding) into a proposal, and typography (fonts uploaded or imported from Google Fonts,
 * assigned to type roles with a live preview in the chosen font). The BUILT app at phone width against the
 * in-process mock transport: the principal is picked by name (RA-07: never typed as an id), one that may not edit
 * brand standards is offered disabled with the reason. Opt-in like the other smokes (`OREMEDIA_E2E=1`).
 *
 * The cases run in order on one backend: the proposals are handled first, then the saves build on each other.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const systemPath = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/system`;

describe.skipIf(!enabled)('brand system: one brand system, edited in place (built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const openSection = async (section: string) => {
    await page.goto(`${origin}${systemPath}?section=${section}`);
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15_000 });
  };
  const edit = async () => {
    await page.getByRole('button', { name: /^Edit / }).click({ timeout: 15_000 });
    await page.getByTestId('brand-kit-editor').waitFor({ timeout: 15_000 });
  };
  const editor = () => page.getByTestId('brand-kit-editor');
  const banner = () => page.getByTestId('proposed-update');
  /** Save; the mock brand has open requests and scheduled posts, so what the save reaches is confirmed first. */
  const saveAndApply = async () => {
    await editor().getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Save and apply the brand system?' });
    await dialog
      .getByTestId('publish-impact')
      .getByText('Saving the brand system reaches')
      .waitFor({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Save and apply' }).click();
  };
  const extract = () => page.getByRole('button', { name: 'Extract voice and vocabulary' });
  const pickPrincipal = async () => {
    await page.locator('#voice-extraction-principal').click();
    await page.getByRole('option', { name: /Onboarding agent/ }).click();
  };
  const applied = () => {
    const brand = backend.brands.find((b) => b.id === E2E.brandId);
    const v = backend.brandVersions.find((x) => x.id === brand?.publishedVersionId);
    if (!v) throw new Error('no applied brand system');
    return v;
  };

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

  it('extraction: the principal is picked by name; one that cannot edit brand standards is disabled with the reason; the onboarding agent writes into the pending proposal and the page links to the run', async () => {
    await openSection('guidelines');
    await expect.poll(() => page.locator('#voice-extraction-principal').count(), { timeout: 15_000 }).toBe(1);
    expect(await extract().getAttribute('aria-disabled')).toBe('true'); // no principal yet
    expect(await page.getByText('sp_', { exact: false }).count()).toBe(0); // RA-07: no ids on the screen
    await page.locator('#voice-extraction-principal').click();
    const agent = page.getByRole('option', { name: /E2E agent/ });
    expect(await agent.textContent()).toContain('cannot edit brand standards');
    expect(await agent.getAttribute('data-disabled')).not.toBeNull();
    await page.getByRole('option', { name: /Onboarding agent/ }).click();
    // RA-07: the limits the server holds the onboarding run to, before it starts.
    await expect.poll(() => page.getByTestId('effective-limits').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('effective-autonomy').textContent()).toContain('create');
    expect(await page.getByTestId('effective-budget').textContent()).toContain('$1.50');
    expect(await page.getByTestId('denied-actions').textContent()).toContain('None');
    await extract().click();
    const follow = page.getByRole('link', { name: 'Follow the run' });
    await follow.waitFor({ timeout: 15_000 });
    expect(await follow.getAttribute('href')).toBe(
      `/c/${E2E.tenantId}/b/${E2E.brandId}/agents?run=run_e2e_onboarding`,
    );
    expect(await page.getByText('The agent is reading the guidelines').count()).toBe(1);
    expect(
      await page.getByText('appears as a proposed update to review at the top', { exact: false }).count(),
    ).toBe(1);
    // The pending proposal (the imported guidelines) is where the suggestion lands; no second proposal is made.
    expect(backend.onboardingStarts.at(-1)).toEqual({ brandId: E2E.brandId, versionId: 'bv_e2e_draft' });
    expect(backend.brandVersionsOf(E2E.brandId).filter((v) => v.state === 'draft')).toHaveLength(1);
  }, 45_000);

  it('brand skill import: a .skill package (a zip) is unpacked in the browser and becomes a proposed update shown at the top; a plain file that is not an archive is refused in text', async () => {
    await openSection('guidelines');
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
    const imported = page.getByText('Imported kinsley-test-brand as a proposed update');
    await imported.waitFor({ timeout: 15_000 });
    const result = imported.locator('..');
    expect(await result.textContent()).toContain('2 guideline documents kept, 2 colours added');
    expect(await result.textContent()).toContain('Not imported: templates/index.css');
    expect(await result.textContent()).not.toMatch(/draft|version|publish/i);
    expect(backend.guidelineImports.at(-1)).toEqual({
      brandId: E2E.brandId,
      paths: ['SKILL.md', 'references/tokens.md', 'templates/index.css'],
    });
    // The import is now the proposed update waiting at the top, named by where it came from.
    await expect
      .poll(() => banner().textContent(), { timeout: 15_000 })
      .toContain('Imported from the brand skill kinsley-test-brand.');
    expect(await banner().textContent()).toContain('It changes Guidelines.');
    // A file named .skill that is not a zip is refused before anything is sent.
    await input.setInputFiles({ name: 'notes.skill', mimeType: '', buffer: Buffer.from('# just text\n') });
    await page.getByText('notes.skill is not a zip archive', { exact: false }).waitFor({ timeout: 15_000 });
    expect(backend.guidelineImports).toHaveLength(1);
  }, 45_000);

  it('a proposed update is discarded only after it is confirmed; the brand system stays as it is', async () => {
    const before = applied().id;
    const proposal = backend.brandVersionsOf(E2E.brandId)[0];
    expect(proposal?.document.guidelines?.source.name).toBe('kinsley-test-brand');
    await openSection('overview');
    await expect.poll(() => banner().textContent(), { timeout: 15_000 }).toContain('kinsley-test-brand');
    await banner().getByRole('button', { name: 'Discard' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Discard the proposed update?' });
    await dialog.waitFor({ timeout: 15_000 });
    // Keeping it changes nothing.
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    await expect.poll(() => dialog.count(), { timeout: 15_000 }).toBe(0);
    expect(proposal?.state).toBe('draft');
    await banner().getByRole('button', { name: 'Discard' }).click();
    await dialog.getByRole('button', { name: 'Discard' }).click();
    await page.getByText('Proposed update discarded').waitFor({ timeout: 15_000 });
    expect(proposal?.state).toBe('retired');
    expect(applied().id).toBe(before);
    // The older proposal (the e2e guidelines) is the one waiting now.
    await expect
      .poll(() => banner().textContent(), { timeout: 15_000 })
      .toContain('Imported from the brand skill e2e-brand.');
  }, 45_000);

  it('a proposed update opens in the full editor; saving applies it, with what it reaches confirmed, and closes it', async () => {
    await openSection('overview');
    await expect
      .poll(() => banner().textContent(), { timeout: 15_000 })
      .toContain('It changes Vocabulary, Imagery, Guidelines.');
    await banner().getByRole('button', { name: 'Review' }).click();
    const review = page.getByTestId('proposal-review');
    await expect
      .poll(() => review.textContent(), { timeout: 15_000 })
      .toContain('Changes Vocabulary, Imagery, Guidelines.');
    // Every section is open for review, the two new ones included.
    for (const heading of [
      'Brand guidelines',
      'Palette',
      'Voice',
      'Personality, style and claims',
      'Messaging',
      'Vocabulary',
      'Writing patterns',
      'Examples',
      'Copy templates',
      'Reference imagery',
      'Visual patterns',
      'Channel guidance',
    ])
      await review.getByRole('heading', { name: heading, exact: true }).waitFor({ timeout: 15_000 });
    expect(await banner().count()).toBe(0);
    // Where a proposed item came from is shown with it.
    expect(await review.getByText('Inferred from examples (2 cited)').count()).toBe(1);
    await saveAndApply();
    await page.getByText('Brand system saved').waitFor({ timeout: 15_000 });
    expect(backend.brandSystemSaves.at(-1)).toMatchObject({
      brandId: E2E.brandId,
      basedOnVersionId: E2E.brandVersionId,
      proposal: { versionId: 'bv_e2e_draft', expectedVersion: 0 },
    });
    expect(backend.brandVersions.find((v) => v.id === 'bv_e2e_draft')?.state).toBe('retired');
    expect(applied().document.guidelines?.source.name).toBe('e2e-brand');
    await expect.poll(() => page.getByTestId('proposal-review').count(), { timeout: 15_000 }).toBe(0);
    expect(await banner().count()).toBe(0);
    await openSection('guidelines');
    await page.getByText('references/tone.md').waitFor({ timeout: 15_000 });
  }, 60_000);

  it('extraction with no proposal waiting: a proposal is made from the brand system first and the agent writes into it', async () => {
    await openSection('guidelines');
    await expect.poll(() => page.locator('#voice-extraction-principal').count(), { timeout: 15_000 }).toBe(1);
    expect(await banner().count()).toBe(0);
    await pickPrincipal();
    expect(await extract().getAttribute('aria-disabled')).toBeNull();
    await extract().click();
    await page.getByRole('link', { name: 'Follow the run' }).waitFor({ timeout: 15_000 });
    const proposal = backend.brandVersionsOf(E2E.brandId)[0];
    expect(proposal?.state).toBe('draft');
    expect(proposal?.document).toEqual(applied().document);
    expect(backend.onboardingStarts.at(-1)).toEqual({ brandId: E2E.brandId, versionId: proposal?.id });
    await expect
      .poll(() => banner().textContent(), { timeout: 15_000 })
      .toContain('It has the same content as the brand system.');
    // Discard it so the saves below start from a brand system with nothing waiting.
    await banner().getByRole('button', { name: 'Discard' }).click();
    await page
      .getByRole('alertdialog', { name: 'Discard the proposed update?' })
      .getByRole('button', { name: 'Discard' })
      .click();
    await expect.poll(() => banner().count(), { timeout: 15_000 }).toBe(0);
  }, 45_000);

  it('typography: Edit, upload a font, import a Google Fonts family, assign it to a role, preview it and save', async () => {
    await openSection('typography');
    await edit();
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

    await saveAndApply();
    await expect
      .poll(() => backend.lastSavedBrandTypeRoles(), { timeout: 15_000 })
      .toContainEqual({ role: 'body', fontAssetId: 'ast_inter_var', weight: 700, minSizePx: 18 });
    // The editor closes on the saved brand system.
    await expect.poll(() => editor().count(), { timeout: 15_000 }).toBe(0);
    expect(applied().document.tokens.typeRoles).toContainEqual(
      expect.objectContaining({ role: 'body', fontAssetId: 'ast_inter_var', weight: 700 }),
    );
  }, 60_000);

  it('voice: overview tiles open a section; Edit opens it in place, every voice field is saved and the read view shows it; Cancel keeps nothing', async () => {
    await page.goto(`${origin}${systemPath}`);
    await page
      .getByRole('button', { name: /^Colour/ })
      .first()
      .waitFor({ timeout: 15_000 });
    // The overview is a summary: nothing to edit there.
    expect(await page.getByRole('button', { name: /^Edit / }).count()).toBe(0);
    await page
      .getByRole('main')
      .getByRole('button', { name: /^Voice & personality/ })
      .last()
      .click();
    await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe('voice');
    // Cancel drops the edit.
    await edit();
    await page.getByLabel('Never write').fill('discarded edit');
    await editor().getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => editor().count(), { timeout: 15_000 }).toBe(0);
    expect(await page.getByText('discarded edit').count()).toBe(0);

    const saves = backend.brandSystemSaves.length;
    await edit();
    await page.getByLabel('Preferred terms').fill('roast instead of blend, mix');
    await page.getByLabel('Never write').fill('artisanal');
    await saveAndApply();
    await page.getByText('Brand system saved').waitFor({ timeout: 15_000 });
    await expect
      .poll(() => backend.lastSavedBrandVoice(), { timeout: 15_000 })
      .toMatchObject({
        preferredTerms: [{ use: 'roast', avoid: ['blend', 'mix'] }],
        prohibitedPhrases: ['artisanal'],
      });
    expect(backend.brandSystemSaves).toHaveLength(saves + 1);
    expect(backend.brandSystemSaves.at(-1)?.proposal).toBeUndefined();
    await expect.poll(() => editor().count(), { timeout: 15_000 }).toBe(0);
    await page.getByRole('main').getByText('artisanal').first().waitFor({ timeout: 15_000 });
  }, 45_000);

  it('saving what is already applied changes nothing and says so', async () => {
    const before = applied().id;
    const versions = backend.brandVersions.length;
    await openSection('voice');
    await edit();
    await saveAndApply();
    await page.getByText('No changes to save').waitFor({ timeout: 15_000 });
    expect(applied().id).toBe(before);
    expect(backend.brandVersions).toHaveLength(versions);
  }, 45_000);

  it('conflict: someone saved since the editor opened; Reload discards the edit and reopens on the saved brand system', async () => {
    await openSection('colour');
    await edit();
    const hex = editor().getByLabel('Hex value').first();
    expect(await hex.inputValue()).toBe('#172120');
    await hex.fill('#000000');
    // Someone else saves meanwhile.
    const elsewhere = applied().document;
    const theirs = backend.applyBrandSystem(E2E.brandId, {
      ...elsewhere,
      tokens: {
        ...elsewhere.tokens,
        colours: elsewhere.tokens.colours.map((c) => (c.key === 'ink' ? { ...c, value: '#111111' } : c)),
      },
    });
    const saves = backend.brandSystemSaves.length;
    await saveAndApply();
    const conflict = page.getByTestId('brand-system-conflict');
    await conflict.waitFor({ timeout: 15_000 });
    expect(await conflict.textContent()).toContain('Someone saved the brand system since you opened it');
    expect(backend.brandSystemSaves).toHaveLength(saves); // refused: nothing recorded
    expect(applied().id).toBe(theirs.id);
    await conflict.getByRole('button', { name: 'Reload' }).click();
    // The editor reopens on their brand system; the local edit is gone.
    await expect
      .poll(() => editor().getByLabel('Hex value').first().inputValue(), { timeout: 15_000 })
      .toBe('#111111');
    expect(await page.getByTestId('brand-system-conflict').count()).toBe(0);
    await editor().getByLabel('Hex value').first().fill('#222222');
    await saveAndApply();
    await page.getByText('Brand system saved').waitFor({ timeout: 15_000 });
    expect(backend.brandSystemSaves.at(-1)?.basedOnVersionId).toBe(theirs.id);
    expect(applied().document.tokens.colours.find((c) => c.key === 'ink')?.value).toBe('#222222');
  }, 45_000);

  it('patterns: rows are added, keyed and described; a duplicate key blocks the save; examples and reference imagery are kept', async () => {
    const reference = applied().document.patterns.find((p) => p.key === 'reference-imagery');
    expect(reference?.exampleAssetIds).toEqual(['ast_e2e']);
    await openSection('patterns');
    await page.getByText('No patterns yet.').waitFor({ timeout: 15_000 });
    await edit();
    const patterns = editor().getByRole('list', { name: 'Patterns' });
    await editor().getByRole('button', { name: 'Add pattern' }).click();
    await patterns.getByLabel('Key').fill('Quote Card');
    expect(await patterns.getByLabel('Key').inputValue()).toBe('quote-card');
    await patterns.getByLabel('What it is for').fill('A pull quote over the paper colour.');
    await editor().getByRole('button', { name: 'Add pattern' }).click();
    await patterns.getByLabel('Key').last().fill('quote-card');
    const save = editor().getByRole('button', { name: 'Save', exact: true });
    expect(await save.getAttribute('aria-disabled')).toBe('true');
    expect(await save.getAttribute('title')).toBe('Fix the highlighted rows first');
    expect(await patterns.getByText('Another pattern has this key.').count()).toBe(1);
    await patterns.getByRole('button', { name: 'Remove pattern quote-card' }).last().click();
    await expect.poll(() => save.getAttribute('aria-disabled')).toBeNull();
    await saveAndApply();
    await page.getByText('Brand system saved').waitFor({ timeout: 15_000 });
    expect(applied().document.patterns).toEqual([
      reference,
      {
        key: 'quote-card',
        description: 'A pull quote over the paper colour.',
        exampleAssetIds: [],
        templateVersionIds: [],
      },
    ]);
    await page.getByRole('main').getByText('quote-card').waitFor({ timeout: 15_000 });
    expect(await page.getByRole('main').getByText('A pull quote over the paper colour.').count()).toBe(1);
  }, 45_000);

  /** Picks an option of a Radix select by the trigger's id. */
  const choose = async (id: string, option: string) => {
    await page.locator(`#${id}`).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  const saved = async () => {
    await saveAndApply();
    await page.getByText('Brand system saved').waitFor({ timeout: 15_000 });
    await expect.poll(() => editor().count(), { timeout: 15_000 }).toBe(0);
  };
  const main = () => page.getByRole('main');

  it('channel guidance: a baseline for every channel; a channel overrides a field, shows what it inherits, resets to the baseline and shows the platform limits', async () => {
    await openSection('channels');
    await page.getByText('No channel guidance yet.').waitFor({ timeout: 15_000 });
    await edit();
    await page.locator('#kit-baseline-cta').fill('Invite a reply.');
    await page.locator('#kit-baseline-hashtags').fill('At most two.');
    await editor().getByRole('button', { name: 'Add channel', exact: true }).click();
    const save = editor().getByRole('button', { name: 'Save', exact: true });
    expect(await save.getAttribute('aria-disabled')).toBe('true'); // no channel chosen yet
    await choose('kit-channel-0-provider', 'LinkedIn Page');
    const row = page.getByTestId('channel-row-0');
    // The platform's limits, read-only beside the brand's preferences.
    const limits = row.getByTestId('platform-limits');
    await limits.waitFor({ timeout: 15_000 });
    expect(await limits.textContent()).toContain('Platform limits · LinkedIn');
    expect(await limits.textContent()).toContain('Up to 3,000 characters');
    // CTA is inherited from the baseline until the channel sets it.
    const cta = page.getByTestId('kit-channel-0-cta-field');
    expect(await cta.textContent()).toContain('Inherited from baseline');
    expect(await cta.textContent()).toContain('Baseline: Invite a reply.');
    await page.locator('#kit-channel-0-cta').fill('Ask for a comment.');
    expect(await cta.textContent()).toContain('Overridden');
    await cta.getByRole('button', { name: 'Reset to baseline for calls to action' }).click();
    expect(await cta.textContent()).toContain('Inherited from baseline');
    expect(await page.locator('#kit-channel-0-cta').inputValue()).toBe('');
    await page.locator('#kit-channel-0-toneAdaptation').fill('Short, first person plural, no hashtags.');
    expect(await page.getByTestId('kit-channel-0-toneAdaptation-field').textContent()).toContain(
      'Overridden',
    );
    await row.getByRole('button', { name: 'Add format' }).click();
    await row.getByLabel('Preferred formats 1').fill('carousel');
    await row.getByRole('button', { name: 'Add format' }).click(); // a blank row is not saved
    // Channel examples are rows with their note; removing one keeps the other's note with it.
    await row.getByRole('button', { name: 'Add channel example' }).click();
    await row.getByLabel('Channel example 1', { exact: true }).fill('First draft');
    await row.getByLabel('Channel example 1 note').fill('first note');
    await row.getByRole('button', { name: 'Add channel example' }).click();
    await row.getByLabel('Channel example 2', { exact: true }).fill('We roasted 40 kg this morning.');
    await row.getByLabel('Channel example 2 note').fill('A number from a fact');
    await row.getByRole('button', { name: 'Remove channel example 1' }).click();
    expect(await row.getByLabel('Channel example 1 note').inputValue()).toBe('A number from a fact');
    // A second row cannot take the same channel.
    await editor().getByRole('button', { name: 'Add channel', exact: true }).click();
    await page.locator('#kit-channel-1-provider').click();
    expect(
      await page.getByRole('option', { name: 'LinkedIn Page' }).getAttribute('data-disabled'),
    ).not.toBeNull();
    await page.keyboard.press('Escape');
    await editor()
      .getByRole('button', { name: /^Remove guidance for row 2/ })
      .click();
    await expect.poll(() => save.getAttribute('aria-disabled')).toBeNull();
    await saved();
    expect(applied().document.channelBaseline).toEqual({ cta: 'Invite a reply.', hashtags: 'At most two.' });
    expect(applied().document.channelGuidance).toEqual([
      {
        providerKey: 'linkedin_page',
        captionStyle: 'Short, first person plural, no hashtags.',
        preferredFormats: ['carousel'],
        ctaConventions: '',
        examples: [{ text: 'We roasted 40 kg this morning.', note: 'A number from a fact' }],
        provenance: { origin: 'user' },
      },
    ]);
    const view = page.getByTestId('channel-view-linkedin_page');
    await view.waitFor({ timeout: 15_000 });
    expect(await view.textContent()).toContain('Short, first person plural, no hashtags.');
    expect(await view.textContent()).toContain('Overridden for this channel');
    expect(await view.textContent()).toContain('Inherited from baseline');
    expect(await view.textContent()).toContain('Entered by you');
    expect(await view.getByTestId('platform-limits').textContent()).toContain('Up to 3,000 characters');
  }, 60_000);

  it('voice & personality: traits, principles, spelling, style and claim rules are rows; the voice fields already there are kept', async () => {
    const before = applied().document.voice;
    await openSection('voice');
    await edit();
    await editor().getByRole('button', { name: 'Add trait' }).click();
    await page.locator('#kit-trait-0').fill('Warm');
    await page.locator('#kit-trait-0-note').fill('Like a neighbour, never a salesman');
    await editor().getByRole('button', { name: 'Add principle' }).click();
    await page.locator('#kit-principle-0').fill('Say only what we can prove');
    await page.locator('#kit-principle-0-why').fill('Trust is what we sell.');
    await page.locator('#kit-spelling-locale').fill('en-GB');
    await editor().getByRole('button', { name: 'Add style rule' }).click();
    await choose('kit-style-0-topic', 'Dates');
    await page.locator('#kit-style-0-rule').fill('3 October 2026, never 10/3');
    await editor().getByRole('button', { name: 'Add claim rule' }).click();
    // An empty rule blocks the save until it is written or removed.
    const save = editor().getByRole('button', { name: 'Save', exact: true });
    expect(await save.getAttribute('aria-disabled')).toBe('true');
    expect(await editor().getByText('Every claim rule needs its rule.').count()).toBe(1);
    await page.locator('#kit-claim-0').fill('No superlatives without an approved fact');
    await expect.poll(() => save.getAttribute('aria-disabled')).toBeNull();
    await saved();
    const voice = applied().document.voice;
    expect(voice.personality).toEqual([
      { trait: 'Warm', note: 'Like a neighbour, never a salesman', provenance: { origin: 'user' } },
    ]);
    expect(voice.principles).toEqual([
      {
        statement: 'Say only what we can prove',
        rationale: 'Trust is what we sell.',
        provenance: { origin: 'user' },
      },
    ]);
    expect(voice.spelling).toEqual({ locale: 'en-GB', notes: '' });
    expect(voice.styleRules).toEqual([
      { topic: 'dates', rule: '3 October 2026, never 10/3', provenance: { origin: 'user' } },
    ]);
    expect(voice.claimRules).toEqual([
      { rule: 'No superlatives without an approved fact', provenance: { origin: 'user' } },
    ]);
    expect(voice.preferredTerms).toEqual(before.preferredTerms);
    expect(voice.prohibitedPhrases).toEqual(before.prohibitedPhrases);
    await main()
      .getByText('Like a neighbour, never a salesman', { exact: false })
      .waitFor({ timeout: 15_000 });
    expect(await main().getByText('3 October 2026, never 10/3', { exact: false }).count()).toBe(1);
    expect(await main().getByText('Entered by you').count()).toBeGreaterThan(0);
  }, 60_000);

  it('messaging: pillars cite approved facts picked by statement, never ids; key messages name a pillar; audiences carry needs and objections', async () => {
    await openSection('messaging');
    await page.getByText('No messaging yet.').waitFor({ timeout: 15_000 });
    await edit();
    await page.getByLabel('Positioning').fill('The roaster Harare cafes rely on.');
    await page.getByLabel('Value proposition').fill('Fresh beans every week, delivered.');
    await editor().getByRole('button', { name: 'Add pillar' }).click();
    await page.locator('#kit-pillar-0-title').fill('Fresh');
    await page.locator('#kit-pillar-0-key').fill('Fresh Beans');
    expect(await page.locator('#kit-pillar-0-key').inputValue()).toBe('fresh-beans');
    await page.locator('#kit-pillar-0-statement').fill('Roasted weekly, never stored for months.');
    const proof = editor().getByRole('group', { name: 'Proof (approved facts)' });
    await proof.getByText('Roasted in Harare every week').waitFor({ timeout: 15_000 });
    // Approved facts are offered by their statement; no ids on the screen.
    expect(await proof.getByText('Beans from three Chimanimani farms').count()).toBe(1);
    expect(await editor().getByText('fact_e2e', { exact: false }).count()).toBe(0);
    await proof.getByLabel('Roasted in Harare every week').check();
    await editor().getByRole('button', { name: 'Add key message' }).click();
    await page.locator('#kit-message-0').fill('Roasted this week, in your cup next week.');
    await choose('kit-message-0-pillar', 'Fresh');
    await editor().getByRole('button', { name: 'Add audience' }).click();
    await page.locator('#kit-audience-0').fill('cafe-owners');
    await page.locator('#kit-audience-0-description').fill('Independent cafe owners in Harare');
    await editor().getByRole('button', { name: 'Add need' }).click();
    await editor().getByLabel('Needs 1').fill('Reliable weekly delivery');
    await editor().getByRole('button', { name: 'Add objection' }).click();
    await editor().getByLabel('Objections 1').fill('Imported beans are cheaper');
    await saved();
    const doc = applied().document;
    expect(doc.messaging).toEqual({
      positioning: 'The roaster Harare cafes rely on.',
      valueProposition: 'Fresh beans every week, delivered.',
      pillars: [
        {
          key: 'fresh-beans',
          title: 'Fresh',
          statement: 'Roasted weekly, never stored for months.',
          proofFactIds: ['fact_e2e_roasted'],
          provenance: { origin: 'user' },
        },
      ],
      keyMessages: [
        {
          text: 'Roasted this week, in your cup next week.',
          pillarKey: 'fresh-beans',
          provenance: { origin: 'user' },
        },
      ],
    });
    expect(doc.voice.audiences.at(-1)).toEqual({
      key: 'cafe-owners',
      description: 'Independent cafe owners in Harare',
      needs: ['Reliable weekly delivery'],
      objections: ['Imported beans are cheaper'],
      provenance: { origin: 'user' },
    });
    const proofList = main().getByRole('list', { name: 'Proof for Fresh' });
    await proofList.waitFor({ timeout: 15_000 });
    expect(await proofList.textContent()).toContain('Roasted in Harare every week');
    expect(await main().getByText('fact_e2e', { exact: false }).count()).toBe(0);
    expect(await main().getByText('Objections: Imported beans are cheaper').count()).toBe(1);
  }, 60_000);

  it('vocabulary: terms with usage and what to write instead; an inferred term edited by a person becomes theirs; a term listed twice blocks the save', async () => {
    await openSection('vocabulary');
    const table = main().getByRole('table', { name: 'Vocabulary' });
    await table.waitFor({ timeout: 15_000 });
    expect(await table.textContent()).toContain('Inferred from examples (2 cited)');
    await edit();
    await page.locator('#kit-term-0-definition').fill('Roasted in lots of 20 kg or less');
    await editor().getByRole('button', { name: 'Add term' }).click();
    await page.locator('#kit-term-1').fill('roast');
    await editor().getByRole('button', { name: 'Add term' }).click();
    await page.locator('#kit-term-2').fill('blend');
    await choose('kit-term-2-usage', 'Avoid');
    await editor().getByRole('button', { name: 'Add alternative' }).nth(2).click();
    await editor().getByLabel('Write instead 1').fill('roast');
    await editor().getByRole('button', { name: 'Add term' }).click();
    await page.locator('#kit-term-3').fill('Roast');
    const save = editor().getByRole('button', { name: 'Save', exact: true });
    expect(await save.getAttribute('aria-disabled')).toBe('true');
    expect(await editor().getByText('A term is listed twice.').count()).toBe(1);
    await editor().getByRole('button', { name: 'Remove term Roast', exact: true }).click();
    await expect.poll(() => save.getAttribute('aria-disabled')).toBeNull();
    await saved();
    expect(applied().document.vocabulary).toEqual([
      {
        term: 'small-batch',
        usage: 'preferred',
        alternatives: [],
        definition: 'Roasted in lots of 20 kg or less',
        provenance: { origin: 'user' },
      },
      { term: 'roast', usage: 'preferred', alternatives: [], provenance: { origin: 'user' } },
      { term: 'blend', usage: 'avoid', alternatives: ['roast'], provenance: { origin: 'user' } },
    ]);
    await table.waitFor({ timeout: 15_000 });
    expect(await table.textContent()).toContain('Avoid');
    expect(await table.textContent()).not.toContain('Inferred from examples');
  }, 45_000);

  it('writing patterns and examples: a part gets guidance, dos and examples; an off-brand example carries why and the rewrite', async () => {
    await openSection('writing');
    await edit();
    await editor().getByRole('button', { name: 'Add guidance for headlines' }).click();
    await page.locator('#kit-writing-headline-guidance').fill('Short and concrete, with a number.');
    await editor().getByRole('button', { name: 'Add do' }).first().click();
    await editor().getByLabel('Headlines: dos 1').fill('Lead with the number');
    await editor().getByRole('button', { name: "Add don't" }).first().click();
    await editor().getByLabel("Headlines: don'ts 1").fill('Puns');
    await saved();
    expect(applied().document.writingPatterns).toEqual({
      headline: {
        guidance: 'Short and concrete, with a number.',
        dos: ['Lead with the number'],
        donts: ['Puns'],
        examples: [],
        provenance: { origin: 'user' },
      },
    });
    await main().getByText('Lead with the number').waitFor({ timeout: 15_000 });

    const before = applied().document.voice.examples.length;
    await openSection('examples');
    await edit();
    await editor().getByRole('button', { name: 'Add example' }).click();
    const i = before;
    await choose(`kit-example-${i}-verdict`, 'Off brand');
    await page.locator(`#kit-example-${i}-text`).fill('Best coffee ever!!!');
    await page.locator(`#kit-example-${i}-why`).fill('An unprovable superlative.');
    await page.locator(`#kit-example-${i}-rewrite`).fill('Roasted this morning in Harare.');
    await choose(`kit-example-${i}-channel`, 'X');
    await saved();
    expect(applied().document.voice.examples.at(-1)).toEqual({
      text: 'Best coffee ever!!!',
      verdict: 'off_brand',
      note: '',
      rationale: 'An unprovable superlative.',
      rewrite: 'Roasted this morning in Harare.',
      channelKey: 'x',
      provenance: { origin: 'user' },
    });
    await main().getByText('“Roasted this morning in Harare.”').waitFor({ timeout: 15_000 });
  }, 60_000);

  it('templates: a copy template with ordered parts, reordered and saved; reopening and saving changes nothing', async () => {
    await openSection('templates');
    await page.getByText('No copy templates yet.').waitFor({ timeout: 15_000 });
    await edit();
    await editor().getByRole('button', { name: 'Add copy template' }).click();
    await page.locator('#kit-template-0-name').fill('Proof post');
    expect(await page.locator('#kit-template-0-key').inputValue()).toBe('proof-post');
    await editor().getByLabel('LinkedIn Page').check();
    await page.locator('#kit-template-0-purpose').fill('Show one approved fact.');
    await page.locator('#kit-template-0-part-0-slot').fill('hook');
    await page.locator('#kit-template-0-part-0-guidance').fill('A number from a fact.');
    await page.locator('#kit-template-0-part-0-max').fill('80');
    await editor().getByRole('button', { name: 'Add part' }).click();
    await page.locator('#kit-template-0-part-1-slot').fill('cta');
    await page.locator('#kit-template-0-part-1-guidance').fill('Invite a reply.');
    await editor().getByRole('button', { name: 'Move up part 2' }).click();
    expect(await page.locator('#kit-template-0-part-0-slot').inputValue()).toBe('cta');
    await editor().getByRole('button', { name: 'Move down part 1' }).click();
    await saved();
    expect(applied().document.copyTemplates).toEqual([
      {
        key: 'proof-post',
        name: 'Proof post',
        contentType: 'social_post',
        channelKeys: ['linkedin_page'],
        purpose: 'Show one approved fact.',
        structure: [
          { slot: 'hook', guidance: 'A number from a fact.', maxLength: 80 },
          { slot: 'cta', guidance: 'Invite a reply.' },
        ],
        provenance: { origin: 'user' },
      },
    ]);
    const parts = main().getByRole('list', { name: 'Parts of Proof post' });
    await parts.waitFor({ timeout: 15_000 });
    expect(await parts.textContent()).toContain('(at most 80 characters)');
    // Visual patterns stay a separate section.
    expect(applied().document.patterns.some((p) => p.key === 'proof-post')).toBe(false);
    // The guidance round-trips: reopening and saving without an edit changes nothing.
    const versions = backend.brandVersions.length;
    await edit();
    await saveAndApply();
    await page.getByText('No changes to save').waitFor({ timeout: 15_000 });
    expect(backend.brandVersions).toHaveLength(versions);
  }, 60_000);

  it('a role without brand.publish_version sees no Edit, no import and no Review or Discard', async () => {
    backend.proposeBrandUpdate(E2E.brandId, applied().document);
    backend.role = 'creator';
    const other = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await other.goto(`${origin}/sign-in`);
      await other.getByLabel('Session token').fill(E2E.token);
      await other.getByRole('button', { name: 'Continue' }).click();
      await other.waitForURL('**/portfolio*', { timeout: 15_000 });
      await other.goto(`${origin}${systemPath}?section=voice`);
      const proposed = other.getByTestId('proposed-update');
      await proposed.waitFor({ timeout: 15_000 });
      expect(await proposed.textContent()).toContain(
        'Nothing applies until a brand manager, admin or owner saves it.',
      );
      expect(await proposed.getByRole('button').count()).toBe(0);
      await other.getByText('artisanal').first().waitFor({ timeout: 15_000 });
      expect(await other.getByRole('button', { name: /^Edit / }).count()).toBe(0);
      await other.goto(`${origin}${systemPath}?section=guidelines`);
      await other.getByText('references/tone.md').waitFor({ timeout: 15_000 });
      expect(await other.getByRole('button', { name: /^Edit / }).count()).toBe(0);
      expect(await other.getByText('Import a brand skill').count()).toBe(0);
      expect(await other.getByRole('button', { name: 'Extract voice and vocabulary' }).count()).toBe(0);
    } finally {
      await other.close();
      backend.role = 'owner';
    }
  }, 45_000);

  it('a brand with nothing saved offers to set the brand system up; with nothing it would reach, the save applies directly', async () => {
    backend.addBrand('brd_e2e_fresh', 'Fresh brand');
    const fresh = backend.brands.find((b) => b.id === 'brd_e2e_fresh');
    if (!fresh) throw new Error('fresh brand missing');
    fresh.publishedVersionId = null;
    try {
      await page.goto(`${origin}/c/${encodeURIComponent(E2E.tenantId)}/b/brd_e2e_fresh/system?section=voice`);
      await page.getByText('Set up your brand system').waitFor({ timeout: 15_000 });
      expect(await page.getByText('No brand version yet').count()).toBe(0);
      await page.getByRole('button', { name: 'Set up the brand system' }).click();
      await editor().waitFor({ timeout: 15_000 });
      await page.getByLabel('Summary', { exact: true }).fill('Warm, exact and brief.');
      await editor().getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Brand system saved').waitFor({ timeout: 15_000 });
      expect(await page.getByRole('alertdialog').count()).toBe(0); // nothing reached: no confirmation
      expect(backend.brandSystemSaves.at(-1)).toMatchObject({
        brandId: 'brd_e2e_fresh',
        basedOnVersionId: null,
      });
      expect(fresh.publishedVersionId).not.toBeNull();
      await page.getByRole('main').getByText('Warm, exact and brief.').first().waitFor({ timeout: 15_000 });
      expect(await page.getByText('Set up your brand system').count()).toBe(0);
    } finally {
      backend.brands.splice(
        backend.brands.findIndex((b) => b.id === 'brd_e2e_fresh'),
        1,
      );
    }
  }, 45_000);
});
