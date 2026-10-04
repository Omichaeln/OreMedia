import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { createTRPCClient, httpLink } from '@trpc/client';
import superjson from 'superjson';
import type { Operation } from '@oremedia/contracts/creative';
import { fixtureDocument, ids } from '@oremedia/editor/fixtures';
import type { AppRouter } from '@oremedia/api';
import { deployedWebOrigin, signInWithPasswordForm } from './deployed';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * Studio smoke (spec 22 Phase 3 gate: save/reopen; stale edits return 409 and rebase; undo is a new revision).
 * Runs the BUILT app (apps/web/dist) in headless Chromium against either:
 *  - the in-memory mock transport (default; `OREMEDIA_E2E=1`), or
 *  - the real API (`OREMEDIA_E2E_API_URL`, `OREMEDIA_E2E_TOKEN`, `OREMEDIA_E2E_TENANT`, `OREMEDIA_E2E_BRAND`);
 *    the outage and render-failure cases need the mock's hooks and are skipped there; or
 *  - a deployed origin (`OREMEDIA_E2E_WEB_ORIGIN`, the staging acceptance job): the deployed web serves the app and
 *    proxies the api, the person signs in with `OREMEDIA_E2E_EMAIL` and `OREMEDIA_E2E_PASSWORD` through the form,
 *    and the out-of-band edits use `OREMEDIA_E2E_TOKEN` against that origin.
 * Never run on the unit project's plain `pnpm test`: it is opt-in because it needs the build and a browser.
 */
const webOrigin = deployedWebOrigin();
const realApi = process.env['OREMEDIA_E2E_API_URL'] ?? webOrigin ?? undefined;
const enabled = process.env['OREMEDIA_E2E'] === '1' || Boolean(realApi);
const dist = fileURLToPath(new URL('../dist', import.meta.url));
// The full Chromium build of the pinned Playwright release (never the headless shell, which renders text differently);
// an explicit path wins, otherwise Playwright's own installation of that build is used (CI installs it).
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const session = {
  token: realApi ? (process.env['OREMEDIA_E2E_TOKEN'] ?? '') : E2E.token,
  tenantId: realApi ? (process.env['OREMEDIA_E2E_TENANT'] ?? '') : E2E.tenantId,
  brandId: realApi ? (process.env['OREMEDIA_E2E_BRAND'] ?? '') : E2E.brandId,
  /** Real API only: approved asset versions the seeded layers may reference (the service authorises every one). */
  fontAssetVersionId: process.env['OREMEDIA_E2E_FONT'] ?? 'av_font',
  photoAssetVersionId: process.env['OREMEDIA_E2E_PHOTO'] ?? null,
};

describe.skipIf(!enabled)('studio smoke (built app in Chromium)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;
  /** Out-of-band edits: the mock engine directly, or a second tRPC client against the real API. */
  let outOfBand: (documentId: string, operations: Operation[]) => Promise<void>;
  let headNumber: (documentId: string) => Promise<number>;
  let headText: (documentId: string, elementId: string) => Promise<string | null>;

  beforeAll(async () => {
    if (webOrigin) {
      origin = webOrigin;
    } else {
      if (!existsSync(`${dist}/index.html`))
        throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
      const served = await startStaticServer(
        realApi ? { dist, apiOrigin: realApi } : { dist, trpcHandler: createMockHandler(backend) },
      );
      origin = served.origin;
      close = served.close;
    }
    if (realApi) {
      const client = createTRPCClient<AppRouter>({
        links: [
          httpLink({
            url: `${realApi}/trpc`,
            transformer: superjson,
            fetch: async (input, init) => {
              const res = await fetch(input, init);
              if (!res.ok && process.env['OREMEDIA_E2E_DEBUG'])
                console.error(
                  '[e2e] out-of-band request failed',
                  res.status,
                  String(init?.body).slice(0, 1500),
                );
              return res;
            },
            headers: () => ({
              authorization: `Bearer ${session.token}`,
              'x-oremedia-tenant': session.tenantId,
              'idempotency-key': randomUUID(),
            }),
          }),
        ],
      });
      outOfBand = async (documentId, operations) => {
        const doc = await client.creative.documents.get.query({ documentId });
        await client.creative.operations.applyBatch.mutate({
          documentId,
          baseRevisionId: doc.revision.id,
          operations,
          summary: 'Out-of-band edit',
          origin: 'user',
        });
      };
      headNumber = async (documentId) =>
        (await client.creative.documents.get.query({ documentId })).revision.number;
      headText = async (documentId, elementId) => {
        const doc = await client.creative.documents.get.query({ documentId });
        const el = doc.revision.snapshot.pages[0]?.elements.find((e) => e.id === elementId);
        return el && el.type === 'text' ? el.text : null;
      };
    } else {
      outOfBand = async (documentId, operations) => {
        backend.applyOutOfBand(documentId, operations);
      };
      headNumber = async (documentId) => backend.head(documentId).number;
      headText = async (documentId, elementId) => {
        const el = backend.head(documentId).snapshot.pages[0]?.elements.find((e) => e.id === elementId);
        return el && el.type === 'text' ? el.text : null;
      };
    }
    console.error(
      '[e2e] mode',
      webOrigin ? `deployed origin ${webOrigin}` : realApi ? `real API ${realApi}` : 'mock transport',
      {
        tenantId: session.tenantId,
        brandId: session.brandId,
        fontAssetVersionId: session.fontAssetVersionId,
        photoAssetVersionId: session.photoAssetVersionId,
      },
    );
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  const studioPath = (documentId: string) =>
    `/c/${encodeURIComponent(session.tenantId)}/b/${encodeURIComponent(session.brandId)}/studio/${encodeURIComponent(documentId)}?devtools=1`;
  const saveKind = () => page.getByTestId('save-state').getAttribute('data-save-kind');
  const waitSaved = async () => {
    await expect.poll(saveKind, { timeout: 15_000 }).toBe('saved');
  };
  const documentIdFromUrl = () => decodeURIComponent(page.url().split('/studio/')[1]?.split('?')[0] ?? '');
  const headlineTextarea = () => page.locator('#prop-text');

  it('signs in with a session token (a deployed origin: email and password), lists the portfolio and opens the brand home', async () => {
    if (webOrigin) {
      await signInWithPasswordForm(page, origin, {
        email: process.env['OREMEDIA_E2E_EMAIL'] ?? '',
        password: process.env['OREMEDIA_E2E_PASSWORD'] ?? '',
      });
    } else {
      await page.goto(`${origin}/sign-in`);
      await page.getByLabel('Session token').fill(session.token);
      await page.getByRole('button', { name: 'Continue' }).click();
    }
    await expect.poll(() => page.url()).toContain('/portfolio');
    await expect.poll(() => page.getByRole('list', { name: 'Companies' }).count()).toBe(1);
    if (realApi) {
      // The seeded tenant has two brands and only brand 1 has published standards: go to it directly.
      await page.goto(
        `${origin}/c/${encodeURIComponent(session.tenantId)}/b/${encodeURIComponent(session.brandId)}/home`,
      );
    } else {
      await page.getByRole('link', { name: 'Open' }).first().click();
      await expect.poll(() => page.getByRole('list', { name: 'Brands' }).count()).toBe(1);
      await page.getByRole('link', { name: 'Open' }).first().click();
    }
    await expect.poll(() => page.url()).toContain('/home');
    await expect.poll(() => page.getByRole('heading', { level: 1 }).textContent()).toBeTruthy();
    // The tenant header came from the URL, never from a body field.
    if (!realApi)
      expect(backend.requests.some((r) => r.headers['x-oremedia-tenant'] === E2E.tenantId)).toBe(true);
  }, 30_000);

  it('creates a document, edits text, autosaves, reloads and finds the same text (save/reopen)', async () => {
    // STU-1a: documents start on the Studio's creation screen. The mock's approved brand template is the fixture
    // document; the real API starts from a blank canvas and the fixture layers are added below.
    await page.goto(
      `${origin}/c/${encodeURIComponent(session.tenantId)}/b/${encodeURIComponent(session.brandId)}/studio`,
    );
    if (realApi) await page.getByRole('button', { name: 'Blank canvas…' }).click();
    else
      await page
        .getByTestId('gallery-card')
        .filter({ hasText: 'Promo template' })
        .getByRole('button', { name: 'Details' })
        .click();
    await page.getByLabel('New document title').fill('Smoke test document');
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain('/studio/');
    const documentId = documentIdFromUrl();
    if (realApi) {
      // The real API creates a minimal empty page; add the fixture's layers through the same operation contract,
      // pointing at seeded approved asset versions (font, photo; no logo asset exists in the seed) and at raw
      // colour values because the seeded brand has no colour tokens yet.
      const seedPage = fixtureDocument().pages[0]!;
      const elements = seedPage.elements
        .filter(
          (e) =>
            e.type === 'background' ||
            e.type === 'text' ||
            (e.type === 'image' && session.photoAssetVersionId),
        )
        .map((e) =>
          e.type === 'text'
            ? {
                ...e,
                factRefs: [],
                style: {
                  ...e.style,
                  fontAssetVersionId: session.fontAssetVersionId,
                  colourToken: undefined,
                  colourValue: '#172120',
                },
              }
            : e.type === 'background'
              ? { ...e, fillToken: undefined }
              : e.type === 'image'
                ? { ...e, assetVersionId: session.photoAssetVersionId ?? e.assetVersionId }
                : e,
        );
      await outOfBand(
        documentId,
        elements.map((element) => ({ op: 'insertElement', pageId: 'page_1', element })),
      );
      await page.goto(`${origin}${studioPath(documentId)}`);
    } else await page.goto(`${origin}${studioPath(documentId)}`);
    await expect.poll(() => page.getByTestId('document-title').textContent()).toBe('Smoke test document');
    const before = await headNumber(documentId); // 1 on the mock; 2 on the real API after the seeding batch
    await page
      .getByTestId('layers')
      .getByRole('option', { name: /^Headline/ })
      .click();
    await headlineTextarea().fill('Edited in the smoke test');
    await expect.poll(saveKind).toBe('pending');
    await waitSaved();
    expect(await headNumber(documentId)).toBe(before + 1);
    await page.reload();
    await expect
      .poll(() => page.getByTestId('document-title').textContent(), { timeout: 15_000 })
      .toBe('Smoke test document');
    await page
      .getByTestId('layers')
      .getByRole('option', { name: /^Headline/ })
      .click();
    await expect.poll(() => headlineTextarea().inputValue()).toBe('Edited in the smoke test');
    expect(await page.getByTestId('save-state').textContent()).toContain(`revision ${before + 1}`);
    if (!realApi) {
      const applies = backend.requests.filter((r) => r.path === 'creative.operations.applyBatch');
      expect(applies.every((r) => typeof r.headers['idempotency-key'] === 'string')).toBe(true);
      expect(applies.every((r) => typeof r.headers['x-correlation-id'] === 'string')).toBe(true);
    }
  }, 45_000);

  it('a stale base (409 STALE_REVISION) is rebased when the other edit touched a different element', async () => {
    const documentId = documentIdFromUrl();
    const before = await headNumber(documentId);
    await outOfBand(documentId, [
      { op: 'moveElement', pageId: 'page_1', elementId: ids.image, x: 90, y: 270 },
    ]);
    await page
      .getByTestId('layers')
      .getByRole('option', { name: /^Headline/ })
      .click();
    await headlineTextarea().fill('Rebased headline');
    await waitSaved();
    expect(await headNumber(documentId)).toBe(before + 2);
    expect(await headText(documentId, ids.headline)).toBe('Rebased headline');
    await expect.poll(() => page.getByText(/Rebased onto revision/).count()).toBe(1);
    expect(await page.getByTestId('save-state').textContent()).toContain(`revision ${before + 2}`);
  }, 45_000);

  it('a conflict on the SAME element can keep MY version: theirs stays in the history and mine lands as the next revision (UX-15)', async () => {
    const documentId = documentIdFromUrl();
    const before = await headNumber(documentId);
    await outOfBand(documentId, [
      { op: 'setText', pageId: 'page_1', elementId: ids.headline, text: 'Their earlier headline' },
    ]);
    await page
      .getByTestId('layers')
      .getByRole('option', { name: /^Headline/ })
      .click();
    await headlineTextarea().fill('My kept headline');
    await expect.poll(saveKind, { timeout: 15_000 }).toBe('conflict');
    const dialog = page.getByRole('alertdialog');
    const list = await dialog.getByTestId('conflict-list').textContent();
    expect(list).toContain('Theirs');
    expect(list).toContain('Their earlier headline');
    expect(list).toContain('Mine');
    expect(list).toContain('My kept headline');
    expect(await dialog.textContent()).toContain(`Their version is revision ${before + 1}`);
    await page.getByTestId('conflict-keep-mine').click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(0);
    await expect.poll(() => page.getByText(/Kept your version for 1 element/).count()).toBe(1);
    await waitSaved();
    expect(await headNumber(documentId)).toBe(before + 2); // theirs (+1) then mine on top (+2)
    expect(await headText(documentId, ids.headline)).toBe('My kept headline');
    await expect.poll(() => headlineTextarea().inputValue()).toBe('My kept headline');
  }, 45_000);

  it('a stale base on the SAME element shows the conflict dialog naming the element; keeping theirs re-applies the rest', async () => {
    const documentId = documentIdFromUrl();
    const before = await headNumber(documentId);
    await outOfBand(documentId, [
      { op: 'setText', pageId: 'page_1', elementId: ids.headline, text: 'Their headline' },
    ]);
    await page
      .getByTestId('layers')
      .getByRole('option', { name: /^Headline/ })
      .click();
    await headlineTextarea().fill('My conflicting headline');
    await expect.poll(saveKind, { timeout: 15_000 }).toBe('conflict');
    const dialog = page.getByRole('alertdialog');
    expect(await dialog.textContent()).toContain('Headline');
    await page.getByTestId('conflict-keep-server').click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(0);
    await waitSaved();
    expect(await headNumber(documentId)).toBe(before + 1); // theirs only: nothing of ours survived, no extra revision
    await expect.poll(() => headlineTextarea().inputValue()).toBe('Their headline');
  }, 45_000);

  it('undo produces a new revision whose text equals the earlier one; redo produces another', async () => {
    const documentId = documentIdFromUrl();
    await headlineTextarea().fill('Before undo');
    await waitSaved();
    const n = await headNumber(documentId);
    await page.getByTestId('undo').click();
    await expect.poll(saveKind, { timeout: 15_000 }).toBe('saved');
    await expect.poll(() => headNumber(documentId)).toBe(n + 1);
    expect(await headText(documentId, ids.headline)).toBe('Their headline');
    await expect.poll(() => headlineTextarea().inputValue()).toBe('Their headline');
    await page.getByTestId('redo').click();
    await expect.poll(() => headNumber(documentId), { timeout: 15_000 }).toBe(n + 2);
    expect(await headText(documentId, ids.headline)).toBe('Before undo');
  }, 45_000);

  it('an agent proposal renders as an overlay diff and Accept commits it as an agent revision', async () => {
    const documentId = documentIdFromUrl();
    const n = await headNumber(documentId);
    // The proposal is based on the revision the page holds: wait until it has caught up with the server's head (the
    // previous test ends on a redo), or the propose call carries a stale base and is refused.
    await waitSaved();
    await expect
      .poll(() => page.getByTestId('save-state').textContent(), { timeout: 15_000 })
      .toContain(`revision ${n}`);
    await page.getByRole('tab', { name: /^Agent/ }).click();
    await page.getByTestId('simulate-proposal').click();
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('proposal-overlay').count()).toBe(1);
    expect(await page.getByTestId('proposal').textContent()).toContain('changed');
    await page.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => headNumber(documentId), { timeout: 15_000 }).toBe(n + 1);
    expect(await headText(documentId, ids.headline)).toBe('Before undo — proposed');
    await expect.poll(() => page.getByTestId('proposal').count()).toBe(0);
    await page.getByRole('tab', { name: 'History' }).click();
    const latest = page.getByTestId('history').getByRole('listitem').first();
    await expect.poll(() => latest.textContent(), { timeout: 15_000 }).toContain(`Revision ${n + 1}`);
    expect(await latest.textContent()).toContain('Current');
    await page.getByRole('tab', { name: /^Agent/ }).click();
  }, 45_000);

  it('agent conversation (UX-07): a request starts a run, its proposal survives a reload, Accept lands it as the agent’s revision; a stale proposal cannot overwrite', async () => {
    if (realApi) return; // the run is produced by the mock worker; against the real API it needs a model
    const documentId = documentIdFromUrl();
    const n = await headNumber(documentId);
    await waitSaved();
    await page.getByRole('tab', { name: /^Agent/ }).click();
    await page.getByLabel('Ask the agent').fill('Tighten the headline');
    await page.getByTestId('agent-send').click();
    await expect.poll(() => page.getByTestId('agent-run').count(), { timeout: 15_000 }).toBe(1);
    await expect
      .poll(() => page.getByTestId('agent-run').textContent(), { timeout: 15_000 })
      .toContain('Working');
    await expect
      .poll(() => page.getByTestId('agent-run').textContent(), { timeout: 30_000 })
      .toContain('Proposal ready');
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('proposal').textContent()).toContain(
      'Layout proposal: Tighten the headline',
    );
    expect(await page.getByTestId('proposal-overlay').count()).toBe(1);
    // Leave and return: the proposal is the run's, not the browser's.
    await page.reload();
    await expect.poll(() => page.getByTestId('document-title').count(), { timeout: 15_000 }).toBe(1);
    await page.getByRole('tab', { name: /^Agent/ }).click();
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('agent-run').textContent()).toContain('Proposal ready');
    await page.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => headNumber(documentId), { timeout: 15_000 }).toBe(n + 1);
    expect(await headText(documentId, ids.headline)).toBe('Before undo — proposed — proposed by the agent');
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 15_000 }).toBe(0);
    await expect
      .poll(() => page.getByTestId('agent-run').textContent(), { timeout: 15_000 })
      .toContain('Finished');
    await expect
      .poll(() => page.getByTestId('save-state').textContent(), { timeout: 15_000 })
      .toContain(`revision ${n + 1}`);
    await page.getByTestId('agent-run').getByRole('button', { name: 'Dismiss' }).click();
    // A second request; the person edits meanwhile, so the proposal is stale and Accept is refused.
    await page.getByLabel('Ask the agent').fill('Once more');
    await page.getByTestId('agent-send').click();
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 30_000 }).toBe(1);
    await page
      .getByTestId('layers')
      .getByRole('option', { name: /^Headline/ })
      .click();
    await headlineTextarea().fill('Edited while the agent worked');
    await waitSaved();
    expect(await headNumber(documentId)).toBe(n + 2);
    await page.getByRole('tab', { name: /^Agent/ }).click();
    const accept = page.getByRole('button', { name: 'Accept' });
    expect(await accept.getAttribute('aria-disabled')).toBe('true');
    expect(await accept.getAttribute('title')).toContain('proposed again');
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 15_000 }).toBe(0);
    expect(await headNumber(documentId)).toBe(n + 2); // nothing of the stale proposal landed
    expect(await headText(documentId, ids.headline)).toBe('Edited while the agent worked');
    await page.getByTestId('agent-run').getByRole('button', { name: 'Dismiss' }).click();
  }, 120_000);

  it('arrow keys nudge the selected element by 1px (10px with Shift) through the keyboard path', async () => {
    const documentId = documentIdFromUrl();
    await page.getByTestId('layers').getByRole('option', { name: /^Body/ }).click();
    const x = Number(await page.locator('#prop-x').inputValue());
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(() => page.locator('#prop-x').inputValue()).toBe(String(x + 1));
    await waitSaved();
    const el = realApi
      ? null
      : backend.head(documentId).snapshot.pages[0]!.elements.find((e) => e.id === ids.body);
    if (el) expect(el.transform).toMatchObject({ x: x + 1 });
  }, 30_000);

  it('hides a layer with H, the canvas stops drawing it, undo shows it again; the eye and Ctrl+Shift+H toggle too', async () => {
    const documentId = documentIdFromUrl();
    const canvas = page.getByTestId('canvas');
    const heroRow = () => page.getByTestId('layers').getByRole('option', { name: /^Hero/ });
    const heroVisible = async () =>
      realApi
        ? null
        : backend.head(documentId).snapshot.pages[0]!.elements.find((e) => e.id === ids.image)?.visible;
    const settle = async () => {
      await canvas.focus();
      await page.keyboard.press('Escape'); // no selection frame in the picture
      await page.waitForTimeout(300);
      return canvas.screenshot();
    };
    await waitSaved();
    const shown = await settle();
    const n = await headNumber(documentId);
    // Keyboard path: H on the focused layer row.
    await heroRow().click();
    await heroRow().press('h');
    await expect.poll(() => heroRow().getAttribute('aria-label')).toMatch(/hidden/);
    await waitSaved();
    await expect.poll(() => headNumber(documentId)).toBe(n + 1);
    if (!realApi) expect(await heroVisible()).toBe(false);
    const hidden = await settle();
    expect(hidden.equals(shown)).toBe(false); // the rendered canvas no longer draws the hero image
    // Undo is a new revision that shows it again, and the canvas is drawn as before.
    await page.getByTestId('undo').click();
    await waitSaved();
    await expect.poll(() => headNumber(documentId)).toBe(n + 2);
    if (!realApi) expect(await heroVisible()).toBe(true);
    await expect.poll(() => heroRow().getAttribute('aria-label')).not.toMatch(/hidden/);
    expect((await settle()).equals(shown)).toBe(true);
    // Ctrl+Shift+H on the canvas hides the selection; the row's eye shows it again.
    await heroRow().click();
    await canvas.focus();
    await page.keyboard.press('Control+Shift+H');
    await expect.poll(() => heroRow().getAttribute('aria-label')).toMatch(/hidden/);
    await page.getByTestId(`layer-visibility-${ids.image}`).click();
    await expect.poll(() => heroRow().getAttribute('aria-label')).not.toMatch(/hidden/);
    await waitSaved();
    if (!realApi) expect(await heroVisible()).toBe(true);
  }, 60_000);

  it('unsaved local work blocks navigation until the person decides', async () => {
    await page
      .getByTestId('layers')
      .getByRole('option', { name: /^Headline/ })
      .click();
    await headlineTextarea().fill('Unsaved edit');
    await page.getByRole('link', { name: 'Studio' }).click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(1);
    await page.getByRole('button', { name: 'Stay and save' }).click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(0);
    expect(page.url()).toContain('/studio/');
    await waitSaved();
  }, 30_000);

  it.skipIf(Boolean(realApi))(
    'a failed autosave is shown with a retry that replays the same intent',
    async () => {
      const documentId = documentIdFromUrl();
      const n = await headNumber(documentId);
      backend.failNextApply = true;
      await headlineTextarea().fill('Edit during an outage');
      await expect.poll(saveKind, { timeout: 15_000 }).toBe('failed');
      const failedKey = backend.requests.filter((r) => r.path === 'creative.operations.applyBatch').at(-1)
        ?.headers['idempotency-key'];
      await page.getByRole('button', { name: 'Retry save' }).click();
      await waitSaved();
      const retriedKey = backend.requests.filter((r) => r.path === 'creative.operations.applyBatch').at(-1)
        ?.headers['idempotency-key'];
      expect(retriedKey).toBe(failedKey);
      expect(await headNumber(documentId)).toBe(n + 1);
    },
    30_000,
  );

  it.skipIf(Boolean(realApi))(
    'a render failure is reported with the worker error and a retry',
    async () => {
      backend.failNextRender = true;
      await page.getByRole('tab', { name: 'History' }).click();
      await page.getByRole('button', { name: 'Render this page' }).click();
      await expect.poll(() => page.getByText('Render failed').count(), { timeout: 15_000 }).toBe(1);
      expect(await page.getByTestId('render').textContent()).toContain('av_font');
    },
    30_000,
  );

  it('comments anchor to elements and go outdated when the element changes', async () => {
    await page.getByTestId('layers').getByRole('option', { name: /^Body/ }).click();
    await page.getByRole('tab', { name: /^Comments/ }).click();
    await page.locator('#comment-body').fill('Check this copy');
    await page.getByRole('button', { name: 'Add comment' }).click();
    await expect.poll(() => page.getByTestId('comments').textContent()).toContain('Check this copy');
    await page.locator('#prop-text').fill('Body changed after the comment');
    await waitSaved();
    await expect
      .poll(() => page.getByTestId('comments').textContent(), { timeout: 15_000 })
      .toContain('Outdated');
  }, 30_000);

  it('sends a document for review through a package: the studio creates the first package pinning the saved head (UX-01)', async () => {
    await waitSaved();
    await page.getByRole('button', { name: 'Send for review' }).click();
    const panel = page.getByTestId('studio-review');
    await expect.poll(() => panel.getByTestId('studio-create-package').count(), { timeout: 15_000 }).toBe(1);
    expect(await panel.getByLabel('Package title').inputValue()).not.toBe('');
    await panel.getByLabel('Master copy').fill('Copy that goes with this creative.');
    await panel.getByRole('button', { name: 'Create package' }).click();
    await expect.poll(() => panel.getByTestId('studio-review-package').count(), { timeout: 15_000 }).toBe(1);
    const item = panel.getByTestId('studio-review-package');
    expect(await item.textContent()).toContain('Draft');
    expect(await item.textContent()).toContain('0 variants');
    expect(await item.getByRole('link', { name: 'Open package' }).getAttribute('href')).toContain(
      'campaigns?package=pkg_',
    );
    // A review needs channel variants (spec 13.3 no_channel_variants); the button says what to do first.
    const request = item.getByRole('button', { name: 'Request review' });
    expect(await request.getAttribute('aria-disabled')).toBe('true');
    expect(await request.getAttribute('title')).toBe('Generate at least one channel variant first');
    expect(await panel.getByTestId('studio-review-stale').count()).toBe(0);
  }, 45_000);

  it('side panels give way to the canvas by width and by choice, and the choice survives a reload (UX-18)', async () => {
    const canvasWidth = () =>
      page.getByTestId('canvas-column').evaluate((el) => el.getBoundingClientRect().width);
    expect(await page.getByTestId('left-panels').count()).toBe(1);
    expect(await page.getByTestId('right-panels').count()).toBe(1);
    // A fresh device at tablet width starts with the properties hidden so the canvas keeps its minimum.
    await page.evaluate(() => localStorage.removeItem('oremedia.studio.panels'));
    await page.setViewportSize({ width: 768, height: 900 });
    await page.reload();
    await expect.poll(() => page.getByTestId('document-title').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('right-panels').count()).toBe(0);
    expect(await page.getByTestId('left-panels').count()).toBe(1);
    expect(await canvasWidth()).toBeGreaterThanOrEqual(320);
    // Showing the properties is the person's choice, kept across a reload.
    await page.getByTestId('toggle-right-panels').click();
    expect(await page.getByTestId('right-panels').count()).toBe(1);
    expect(await page.getByTestId('toggle-right-panels').getAttribute('aria-pressed')).toBe('true');
    await page.reload();
    await expect.poll(() => page.getByTestId('document-title').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('right-panels').count()).toBe(1);
    expect(await canvasWidth()).toBeGreaterThanOrEqual(320);
    // Hiding the layers as well leaves the canvas alone.
    await page.getByTestId('toggle-left-panels').click();
    expect(await page.getByTestId('left-panels').count()).toBe(0);
    await page.getByTestId('toggle-left-panels').click();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.reload();
    await expect.poll(() => page.getByTestId('document-title').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('left-panels').count()).toBe(1);
    expect(await page.getByTestId('right-panels').count()).toBe(1);
  }, 45_000);

  it('creates a format variant from the strip and switches pages', async () => {
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => page.getByTestId('format-strip').getByRole('tab').count()).toBe(2);
    await waitSaved();
    await page.getByTestId('format-strip').getByRole('tab').nth(1).click();
    await expect
      .poll(() => page.getByTestId('format-strip').getByRole('tab', { selected: true }).textContent())
      .toContain('1080×1920');
  }, 30_000);
});
