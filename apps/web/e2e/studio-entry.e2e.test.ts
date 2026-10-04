import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { CreativeDocumentV1, Element } from '@oremedia/contracts/creative';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * STU-1a against the BUILT app and the in-process mock transport: the template-led creation screen (filters, previews,
 * every way to start), the title, and the editor (insert, multi-select, align, group, rotate, crop, mask, pages,
 * locks, save as template and approval), with keyboard paths and three widths. Opt-in (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };
const brandPath = `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}`;

const flat = (els: Element[]): Element[] =>
  els.flatMap((e) => [e, ...(e.type === 'group' ? flat(e.children) : [])]);

describe.skipIf(!enabled)('studio entry and editor completeness (STU-1a, built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const documentId = () => decodeURIComponent(page.url().split('/studio/')[1]?.split('?')[0] ?? '');
  const head = (): CreativeDocumentV1 => backend.head(documentId()).snapshot;
  const headPage = (i = 0) => head().pages[i]!;
  const byName = (name: string, i = 0) => flat(headPage(i).elements).find((e) => e.name === name);
  const saveKind = () => page.getByTestId('save-state').getAttribute('data-save-kind');
  const waitSaved = () => expect.poll(saveKind, { timeout: 15_000 }).toBe('saved');
  const layer = (name: RegExp) => page.getByTestId('layers').getByRole('option', { name });
  const gallery = () => page.getByTestId('template-gallery');
  const openStudioIndex = async () => {
    await page.goto(`${origin}${brandPath}/studio`);
    await gallery().getByTestId('gallery-card').first().waitFor({ timeout: 15_000 });
  };
  const cardNames = () => gallery().getByTestId('gallery-card').locator('h3').allTextContents();
  const noHorizontalScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const setNumber = async (selector: string, value: string) => {
    await page.locator(selector).fill(value);
    await page.locator(selector).press('Enter');
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
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

  it('the gallery previews built-in starters and brand templates and filters by type, channel, format and source', async () => {
    await openStudioIndex();
    expect(await page.getByTestId('scene-preview').count()).toBeGreaterThanOrEqual(12);
    // Previews are drawn by the scene renderer (a Konva canvas inside each preview).
    expect(await page.getByTestId('scene-preview').first().locator('canvas').count()).toBeGreaterThan(0);
    const all = await cardNames();
    expect(all).toEqual(expect.arrayContaining(['Bold headline', 'Promo template', 'Three-step guide']));
    const video = page
      .getByRole('group', { name: 'Content type' })
      .getByRole('button', { name: /Video or reel/ });
    // STU-2b: videos can be started; the tile opens the video start (video-studio.e2e.test.ts creates one).
    expect(await video.isDisabled()).toBe(false);
    expect(await video.textContent()).toContain('A reel, short or video ad on a timeline.');

    await page
      .getByRole('group', { name: 'Content type' })
      .getByRole('button', { name: /^Carousel/ })
      .click();
    await expect.poll(cardNames).toEqual(['Three-step guide', 'Five-slide tips']);
    await page
      .getByRole('group', { name: 'Content type' })
      .getByRole('button', { name: /^Everything/ })
      .click();

    await page.getByLabel('Channel').click();
    await page.getByRole('option', { name: 'YouTube' }).click();
    await expect.poll(cardNames).toEqual(['Video thumbnail']);
    await page.getByLabel('Channel').click();
    await page.getByRole('option', { name: 'All channels' }).click();

    await page.getByLabel('Format').click();
    await page.getByRole('option', { name: 'Instagram story 9:16' }).click();
    await expect.poll(cardNames).toEqual(['Story announcement', 'Story with photo']);
    await page.getByLabel('Format').click();
    await page.getByRole('option', { name: 'All formats' }).click();

    await page.locator('#gallery-source').click();
    await page.getByRole('option', { name: 'Brand templates', exact: true }).click();
    await expect.poll(cardNames).toEqual(['Promo template']);
    await page.locator('#gallery-source').click();
    await page.getByRole('option', { name: 'Built-in and brand templates' }).click();
  }, 60_000);

  it('one click on a starter opens the studio on a created document with a suggested title and its content type', async () => {
    await openStudioIndex();
    await gallery().getByRole('button', { name: 'Use Bold headline' }).click();
    await page.waitForURL('**/studio/*', { timeout: 15_000 });
    await expect
      .poll(() => page.getByTestId('document-title').textContent(), { timeout: 15_000 })
      .toMatch(/^Promotional graphic – Bold headline – \d{1,2} \w{3}$/);
    const create = backend.creates.at(-1);
    expect(create?.source).toEqual({ kind: 'starter', starterKey: 'post-bold-headline' });
    expect(head().contentType).toBe('social_post');
    expect(byName('Headline')).toMatchObject({ type: 'text', semanticRole: 'headline' });
  }, 30_000);

  it('the title is renamed inline in the header', async () => {
    await page.getByRole('button', { name: /^Rename / }).click();
    await page.getByLabel('Document title').fill('Spring offer');
    await page.getByLabel('Document title').press('Enter');
    await expect.poll(() => page.getByTestId('document-title').textContent()).toBe('Spring offer');
    expect(backend.doc(documentId()).title).toBe('Spring offer');
  });

  it('inserts text and a shape with brand fonts and tokens; edits text in place on the canvas', async () => {
    await page.getByTestId('insert-toolbar').getByRole('button', { name: 'Heading' }).click();
    await waitSaved();
    const heading = byName('Heading');
    expect(heading).toMatchObject({ type: 'text', style: { fontAssetVersionId: 'av_font_ast_font' } });
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Enter'); // the selected new heading opens in place
    const editor = page.getByTestId('in-place-text');
    await editor.waitFor();
    await editor.fill('Edited on the canvas');
    await editor.press('Control+Enter');
    await waitSaved();
    expect(byName('Heading')).toMatchObject({ text: 'Edited on the canvas' });
    await page.getByTestId('insert-toolbar').getByRole('button', { name: 'Rectangle' }).click();
    await waitSaved();
    expect(byName('Rectangle')).toMatchObject({ type: 'shape', shape: 'rect', fillToken: 'accent' });
  }, 30_000);

  it('multi-selects in the layers panel (Shift), aligns to the selection and groups (Ctrl+G), then ungroups', async () => {
    await layer(/^Headline,/).click();
    await layer(/^Body,/).click({ modifiers: ['Shift'] });
    await expect.poll(() => page.getByTestId('properties').textContent()).toContain('2 elements selected');
    await page.getByRole('button', { name: 'Align right to the selection' }).click();
    await waitSaved();
    const h = byName('Headline')!.transform;
    const b = byName('Body')!.transform;
    expect(h.x + h.width).toBeCloseTo(b.x + b.width, 1);
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Control+g');
    await waitSaved();
    const group = headPage().elements.find((e) => e.type === 'group');
    expect(group?.type === 'group' && group.children.map((c) => c.name)).toEqual(['Headline', 'Body']);
    await page.getByTestId('properties').getByRole('button', { name: 'Ungroup' }).click();
    await waitSaved();
    expect(headPage().elements.some((e) => e.type === 'group')).toBe(false);
  }, 30_000);

  it('rotates with the numeric field; logos and groups say why they do not rotate', async () => {
    await layer(/^Rectangle,/).click();
    await setNumber('#prop-rotation', '15');
    await waitSaved();
    expect(byName('Rectangle')!.transform.rotation).toBe(15);
  });

  it('inserts a photo, crops it and masks it; a generated image is labelled as one', async () => {
    await page.getByRole('tab', { name: 'Assets' }).click();
    await page.getByRole('button', { name: 'Insert Sample photo' }).click();
    await waitSaved();
    await page.locator('#crop-w').waitFor({ timeout: 15_000 });
    await setNumber('#crop-w', '50');
    await waitSaved();
    const photo = flat(headPage().elements).find(
      (e) => e.type === 'image' && e.assetVersionId === 'av_photo',
    );
    expect(photo?.type === 'image' && photo.crop?.width).toBeGreaterThan(0);
    await page.getByLabel('Mask').click();
    await page.getByRole('option', { name: 'Circle or oval' }).click();
    await waitSaved();
    const masked = flat(headPage().elements).find(
      (e) => e.type === 'image' && e.assetVersionId === 'av_photo',
    );
    expect(masked).toMatchObject({ mask: { kind: 'circle' } });
    expect(await page.getByTestId('generated-label').count()).toBe(0);
    // With the photo selected, choosing another asset replaces its file: a generated one is labelled honestly.
    await page.getByRole('button', { name: 'Use Generated scene' }).click();
    await waitSaved();
    await expect
      .poll(() => page.getByTestId('generated-label').textContent())
      .toContain('Generated image — regenerate or replace to change its content');
  }, 45_000);

  it('locks an element (explained) and a page; an agent operation on them is refused by the guard', async () => {
    await page.getByRole('tab', { name: 'Layers' }).click();
    await layer(/^Headline,/).click();
    await page.getByTestId('properties').getByRole('button', { name: 'Lock', exact: true }).click();
    await waitSaved();
    await expect
      .poll(() => page.getByTestId('lock-explanation').textContent())
      .toContain('AI agents cannot change it');
    const headline = byName('Headline')!;
    expect(headline.locked).toBe(true);
    const base = backend.head(documentId());
    expect(() =>
      backend.evaluate(base, {
        operations: [{ op: 'setText', pageId: headPage().id, elementId: headline.id, text: 'agent' }],
        summary: 'agent',
        origin: 'agent',
      }),
    ).toThrow(/locked element/);
    await page
      .getByRole('toolbar', { name: 'Page actions' })
      .getByRole('button', { name: 'Lock page' })
      .click();
    await waitSaved();
    expect(headPage().locked).toBe(true);
    await expect.poll(() => page.getByTestId('canvas').getAttribute('aria-label')).toContain('locked page');
    await page
      .getByRole('toolbar', { name: 'Page actions' })
      .getByRole('button', { name: 'Unlock page' })
      .click();
    await waitSaved();
    expect(headPage()).not.toHaveProperty('locked');
  }, 30_000);

  it('pages: add, duplicate, reorder and remove from the page strip', async () => {
    const actions = page.getByRole('toolbar', { name: 'Page actions' });
    await actions.getByRole('button', { name: 'Add page' }).click();
    await waitSaved();
    expect(head().pages.map((p) => p.name)).toEqual(['Post', 'Page 2']);
    await actions.getByRole('button', { name: 'Duplicate page' }).click();
    await waitSaved();
    expect(head().pages.map((p) => p.name)).toEqual(['Post', 'Page 2', 'Page 2 (copy)']);
    await actions.getByRole('button', { name: 'Move earlier' }).click();
    await waitSaved();
    expect(head().pages.map((p) => p.name)).toEqual(['Post', 'Page 2 (copy)', 'Page 2']);
    await actions.getByRole('button', { name: 'Remove page' }).click();
    await waitSaved();
    expect(head().pages.map((p) => p.name)).toEqual(['Post', 'Page 2']);
  }, 30_000);

  it('saves the document as a template with inferred slots; a brand manager approves it and the gallery offers it', async () => {
    await page.getByRole('tab', { name: 'Templates' }).click();
    // The headline is still locked from the lock test: a template would replace it, so Apply says why it is off.
    await page
      .getByTestId('format-strip')
      .getByRole('tab', { name: /^1\. Post/ })
      .click();
    await expect
      .poll(() => page.getByTestId('template-lock-note').textContent())
      .toContain('holds locked elements');
    await page.getByRole('button', { name: 'Save as template…' }).click();
    const slots = page.getByTestId('template-slots');
    await slots.waitFor();
    expect(await slots.textContent()).toContain('Headline');
    await page.getByLabel('Template name').fill('Spring promo');
    await page.getByRole('button', { name: 'Save template' }).click();
    await page.getByText('Template saved as a draft').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Done' }).click();
    const saved = backend.templates.find((t) => t.name === 'Spring promo');
    expect(saved?.versions[0]?.slots.map((s) => s.key)).toEqual(
      expect.arrayContaining(['headline', 'body', 'cta']),
    );
    const row = page.getByTestId('template-row').filter({ hasText: 'Spring promo' });
    await row.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Approve version 1' }).click();
    await expect.poll(() => saved?.versions[0]?.state).toBe('approved');
    await openStudioIndex();
    await expect.poll(cardNames).toContain('Spring promo');
  }, 45_000);

  it('starts from an approved brand template with an edited title, from a blank canvas, a custom size and a copy', async () => {
    await gallery()
      .getByTestId('gallery-card')
      .filter({ hasText: 'Promo template' })
      .getByRole('button', { name: 'Details' })
      .click();
    await page.getByLabel('New document title').fill('From the brand template');
    await page.getByRole('button', { name: 'Create and open' }).click();
    await page.waitForURL('**/studio/*', { timeout: 15_000 });
    expect(backend.creates.at(-1)?.source).toEqual({
      kind: 'template',
      templateId: 'tpl_e2e',
      templateVersionId: 'tv_e2e',
    });
    expect(head().templateVersionId).toBe('tv_e2e');

    await openStudioIndex();
    await page.getByRole('button', { name: 'Blank canvas…' }).click();
    await page.locator('#blank-type').click();
    await page.getByRole('option', { name: 'Story' }).click();
    await expect.poll(() => page.locator('#blank-format').textContent()).toContain('Instagram story 9:16');
    await page.getByRole('button', { name: 'Create and open' }).click();
    await page.waitForURL('**/studio/*', { timeout: 15_000 });
    expect(headPage()).toMatchObject({ formatKey: 'ig_story_9x16', width: 1080, height: 1920 });
    expect(head().contentType).toBe('story');

    await openStudioIndex();
    await page.getByRole('button', { name: 'Custom size…' }).click();
    await page.getByLabel('Width (px)').fill('5000');
    await expect
      .poll(() => page.getByRole('status').filter({ hasText: 'px' }).first().textContent())
      .toContain('at most 4096');
    expect(await page.getByRole('button', { name: 'Create and open' }).isDisabled()).toBe(true);
    await page.getByLabel('Width (px)').fill('1500');
    await page.getByLabel('Height (px)').fill('500');
    await page.getByLabel('New document title').fill('Event banner');
    await page.getByRole('button', { name: 'Create and open' }).click();
    await page.waitForURL('**/studio/*', { timeout: 15_000 });
    expect(headPage()).toMatchObject({ formatKey: 'custom_1500x500', width: 1500, height: 500 });

    await openStudioIndex();
    await page.getByRole('button', { name: 'Duplicate a document…' }).click();
    await page.getByLabel('Document to copy').click();
    await page.getByRole('option', { name: 'Spring offer' }).click();
    await expect.poll(() => page.getByLabel('New document title').inputValue()).toBe('Spring offer (copy)');
    await page.getByRole('button', { name: 'Create and open' }).click();
    await page.waitForURL('**/studio/*', { timeout: 15_000 });
    await expect.poll(() => page.getByTestId('document-title').textContent()).toBe('Spring offer (copy)');
    expect(head().pages.map((p) => p.name)).toEqual(['Post', 'Page 2']);
  }, 60_000);

  it('archives a document from its menu in the index (G12): hidden by default, listed with the filter, restored', async () => {
    const doc = backend.createDocument('Old flyer');
    await openStudioIndex();
    const documents = page.getByTestId('documents');
    const row = documents.getByRole('listitem').filter({ hasText: 'Old flyer' });
    await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(1);
    await row.getByRole('button', { name: 'Actions for Old flyer' }).click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    await expect.poll(() => backend.doc(doc.id).archivedAt, { timeout: 15_000 }).not.toBeNull();
    await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(0);
    // The filter lists the archived documents only, each marked and restorable.
    await page.getByTestId('show-archived-documents').check();
    const archived = page.getByRole('list', { name: 'Archived documents' }).getByRole('listitem');
    await expect.poll(() => archived.filter({ hasText: 'Old flyer' }).count(), { timeout: 15_000 }).toBe(1);
    expect(await archived.filter({ hasText: 'Old flyer' }).textContent()).toContain('Archived');
    expect(await archived.filter({ hasText: 'Spring offer' }).count()).toBe(0);
    await archived
      .filter({ hasText: 'Old flyer' })
      .getByRole('button', { name: 'Actions for Old flyer' })
      .click();
    await page.getByRole('menuitem', { name: 'Restore from archive' }).click();
    await expect.poll(() => backend.doc(doc.id).archivedAt, { timeout: 15_000 }).toBeNull();
    await page.getByTestId('show-archived-documents').uncheck();
    await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(1);
    expect(backend.doc(doc.id).version).toBe(3);
  }, 45_000);

  it('keyboard: content type tiles and starts work without a pointer; marquee and arrow keys work on the canvas', async () => {
    await openStudioIndex();
    const carousel = page
      .getByRole('group', { name: 'Content type' })
      .getByRole('button', { name: /^Carousel/ });
    await carousel.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => carousel.getAttribute('aria-pressed')).toBe('true');
    await gallery().getByRole('button', { name: 'Use Three-step guide' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/studio/*', { timeout: 15_000 });
    expect(head().pages).toHaveLength(3);
    // Marquee over the upper half of the canvas selects the elements it touches.
    const box = (await page.locator('[data-testid="canvas"] canvas').first().boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height * 0.6, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => page.getByTestId('properties').textContent()).toMatch(/\d elements selected/);
    const before = byName('Headline')!.transform.x;
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('Shift+ArrowRight');
    await waitSaved();
    expect(byName('Headline')!.transform.x).toBe(before + 10);
  }, 45_000);

  for (const [width, height] of [
    [1280, 900],
    [768, 1024],
    [390, 844],
  ] as const)
    it(`responsive at ${width}px: the creation screen and the editor fit without horizontal scrolling`, async () => {
      await page.setViewportSize({ width, height });
      await openStudioIndex();
      expect(await noHorizontalScroll()).toBe(true);
      await gallery().getByRole('button', { name: 'Use Bold headline' }).click();
      await page.waitForURL('**/studio/*', { timeout: 15_000 });
      await page.getByTestId('insert-toolbar').waitFor();
      expect(await noHorizontalScroll()).toBe(true);
    }, 30_000);
});
