import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { auditPage, dialogFocusTrap, formatViolations } from './a11y';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { P5 } from './mock-phase5';
import { startStaticServer } from './static-server';

/**
 * Editing and deleting a published post from the publication detail (publication.edit_remote / delete_remote) in the
 * BUILT app against the mock transport: the actions follow the channel's capability and the person's role, the edit
 * dialog counts characters against the channel's limit, and each request shows its lifecycle (requested → done, or
 * failed with the channel's reason). The mock's `settleRemoteChanges` stands in for the workflow. Opt-in like the
 * other smokes (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const LIVE_TEXT = 'Launch week: every plan at 50 EUR.';

describe.skipIf(!enabled)('edit and delete a published post (built app in Chromium, mock transport)', () => {
  const backend = new MockBackend();
  const p5 = backend.phase5;
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const brandPath = (rest: string) =>
    `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;
  const openPublication = async (id: string) => {
    const day = p5.publication(id).scheduledFor.slice(0, 10);
    await page.goto('about:blank');
    await page.goto(`${origin}${brandPath(`calendar?day=${day}&publication=${id}`)}`);
    await page.getByTestId('channel-outcomes').waitFor({ timeout: 15_000 });
  };
  const detail = () => page.getByTestId('publication-detail');
  const calls = (path: string) => backend.requests.filter((r) => r.path === path).length;

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({ dist, trpcHandler: createMockHandler(backend) });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
    page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
    // The LinkedIn post's live text (what the variant published, or the last edit that went through).
    p5.publication(P5.publications.publishedEarlier).currentText = LIVE_TEXT;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('the actions follow the channel: LinkedIn edits and deletes, X only deletes', async () => {
    await openPublication(P5.publications.publishedEarlier);
    await expect.poll(() => detail().getByRole('button', { name: 'Edit text' }).count()).toBe(1);
    expect(await detail().getByRole('button', { name: 'Request remote deletion' }).count()).toBe(1);
    await openPublication(P5.publications.published);
    await expect
      .poll(() => detail().getByRole('button', { name: 'Request remote deletion' }).count())
      .toBe(1);
    expect(await detail().getByRole('button', { name: 'Edit text' }).count()).toBe(0);
  }, 45_000);

  it('a role without publication.edit_remote / delete_remote sees neither action', async () => {
    backend.role = 'creator';
    try {
      await openPublication(P5.publications.publishedEarlier);
      await expect.poll(() => detail().getByTestId('publication-state').textContent()).toContain('Published');
      expect(await detail().getByRole('button', { name: 'Edit text' }).count()).toBe(0);
      expect(await detail().getByRole('button', { name: 'Request remote deletion' }).count()).toBe(0);
    } finally {
      backend.role = 'owner';
    }
  }, 45_000);

  it('edit: the dialog holds the live text and counts against the limit; saving shows the request until it is live', async () => {
    await openPublication(P5.publications.publishedEarlier);
    await detail().getByRole('button', { name: 'Edit text' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit the live post’s text' });
    await dialog.waitFor();
    const text = dialog.getByLabel('Text', { exact: true });
    expect(await text.inputValue()).toBe(LIVE_TEXT);
    expect(await dialog.textContent()).toContain(`${LIVE_TEXT.length} / 3000 characters`);
    const violations = [...(await auditPage(page, { narrow: true })), ...(await dialogFocusTrap(page))];
    expect(violations, formatViolations('edit text dialog', violations)).toEqual([]);

    await text.fill('x'.repeat(3001));
    await expect.poll(() => dialog.textContent()).toContain('1 characters over the channel’s limit');
    expect(
      await dialog.getByRole('button', { name: 'Save to the channel' }).getAttribute('aria-disabled'),
    ).toBe('true');

    const before = calls('publishing.publications.editRemote');
    await text.fill('Launch week: every plan at 40 EUR.');
    await dialog.getByRole('button', { name: 'Save to the channel' }).click();
    await expect.poll(() => calls('publishing.publications.editRemote')).toBe(before + 1);
    await expect
      .poll(() => detail().getByTestId('remote-change-status').textContent(), { timeout: 15_000 })
      .toContain('Text edit requested');
    // Nothing else can be asked of the live post while the channel carries it out.
    expect(await detail().getByRole('button', { name: 'Edit text' }).count()).toBe(0);
    expect(await detail().getByRole('button', { name: 'Request remote deletion' }).count()).toBe(0);

    p5.settleRemoteChanges(P5.publications.publishedEarlier, 'done');
    await openPublication(P5.publications.publishedEarlier);
    await expect.poll(() => detail().getByRole('button', { name: 'Edit text' }).count()).toBe(1);
    expect(await detail().getByTestId('remote-change-status').count()).toBe(0);
    await detail().getByRole('button', { name: 'Edit text' }).click();
    expect(await page.getByRole('dialog').getByLabel('Text', { exact: true }).inputValue()).toBe(
      'Launch week: every plan at 40 EUR.',
    );
    await page.keyboard.press('Escape');
  }, 60_000);

  it('a request whose workflow was lost stops blocking once stale: warned, not polled, and can be asked again', async () => {
    const id = P5.publications.publishedEarlier;
    await openPublication(id);
    await detail().getByRole('button', { name: 'Edit text' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit the live post’s text' });
    await dialog.getByLabel('Text', { exact: true }).fill('Launch week: every plan at 45 EUR.');
    await dialog.getByRole('button', { name: 'Save to the channel' }).click();
    await expect
      .poll(() => detail().getByTestId('remote-change-status').textContent(), { timeout: 15_000 })
      .toContain('Text edit requested');
    p5.makeRemoteChangeStale(id);
    await openPublication(id);
    await expect
      .poll(() => detail().getByTestId('remote-change-status').textContent())
      .toContain('has no confirmation from the channel');
    expect(await detail().getByRole('button', { name: 'Edit text' }).count()).toBe(1);
    // No polling for a stale request: the detail is not re-read on its own.
    const reads = calls('publishing.publications.get');
    await page.waitForTimeout(11_000);
    expect(calls('publishing.publications.get')).toBe(reads);
  }, 60_000);

  it('delete: a refusal is shown with the channel’s reason and the post stays; a retry ends in Deleted from channel', async () => {
    const id = P5.publications.publishedEarlier;
    const requestDeletion = async (reason: string) => {
      await detail().getByRole('button', { name: 'Request remote deletion' }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Delete the live post?' });
      await dialog.waitFor();
      await dialog.getByLabel('Reason').fill(reason);
      await dialog.getByRole('button', { name: 'Request deletion' }).click();
      await expect
        .poll(() => detail().getByTestId('remote-change-status').textContent(), { timeout: 15_000 })
        .toContain('Deletion requested');
    };
    await openPublication(id);
    await requestDeletion('Wrong price');
    p5.settleRemoteChanges(id, { code: 'linkedin_403', message: 'Not enough permissions to delete' });
    await openPublication(id);
    await expect
      .poll(() => detail().getByTestId('remote-change-status').textContent())
      .toContain('did not accept the deletion');
    expect(await detail().getByTestId('remote-change-status').textContent()).toContain('linkedin_403');
    expect(await detail().getByTestId('publication-state').textContent()).toContain('Published');

    await requestDeletion('Wrong price, second try after reconnecting');
    p5.settleRemoteChanges(id, 'done');
    await openPublication(id);
    await expect
      .poll(() => detail().getByTestId('publication-state').textContent())
      .toContain('Deleted from channel');
    expect(await detail().getByTestId('remote-change-status').textContent()).toContain(
      'Deleted from the channel',
    );
    expect(await detail().getByRole('button', { name: 'Edit text' }).count()).toBe(0);
    expect(await detail().getByRole('button', { name: 'Request remote deletion' }).count()).toBe(0);
    const violations = await auditPage(page, { narrow: true });
    expect(violations, formatViolations('deleted publication', violations)).toEqual([]);
  }, 60_000);

  it('website edit refused (PR-03): the website’s current article and the edit sit side by side with the differences marked; the edit can be re-applied on purpose or the article opened on the site; limited mode offers no re-apply', async () => {
    const id = P5.publications.article;
    const requestEdit = async (html: string) => {
      await openPublication(id);
      await detail().getByRole('button', { name: 'Edit text' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit the article’s body' });
      await dialog.waitFor();
      await dialog.getByLabel('Body (HTML)').fill(html);
      const before = calls('publishing.publications.editRemote');
      await dialog.getByRole('button', { name: 'Save to the channel' }).click();
      await expect.poll(() => calls('publishing.publications.editRemote')).toBe(before + 1);
    };
    const approved = '<p>Ore is heavy.</p><p>Tar keeps the rain out.</p>';
    await requestEdit(approved);
    p5.refuseArticleEdit(
      id,
      'remote_changed',
      '<p>Ore is heavy.</p><p>Edited on the website by the editor.</p>',
    );
    await openPublication(id);
    const conflict = detail().getByTestId('article-conflict');
    await conflict.waitFor({ timeout: 15_000 });
    expect(await conflict.getAttribute('data-conflict-reason')).toBe('remote_changed');
    expect(await conflict.textContent()).toContain('the article changed on the website');
    const current = conflict.getByTestId('conflict-current');
    const attempted = conflict.getByTestId('conflict-attempted');
    expect(await current.locator('li[data-changed="true"]').textContent()).toContain(
      'Edited on the website by the editor.',
    );
    expect(await attempted.locator('li[data-changed="true"]').textContent()).toContain(
      'Tar keeps the rain out.',
    );
    expect(await current.locator('li[data-changed="false"]').textContent()).toContain('Ore is heavy.');
    expect(await conflict.getByTestId('conflict-open-editor').getAttribute('href')).toBe(
      'https://acme.example/wp-admin/post.php?post=42&action=edit',
    );
    // The generic failure banner is replaced by the resolution panel.
    expect(await detail().getByTestId('remote-change-status').count()).toBe(0);
    const violations = await auditPage(page, { narrow: true });
    expect(violations, formatViolations('article conflict', violations)).toEqual([]);

    const before = calls('publishing.publications.editRemote');
    await conflict.getByTestId('conflict-reapply').click();
    const confirm = page.getByRole('alertdialog');
    expect(await confirm.textContent()).toContain(
      'applied only if the website still holds exactly that version',
    );
    await confirm.getByTestId('confirm-conflict-reapply').click();
    await expect.poll(() => calls('publishing.publications.editRemote')).toBe(before + 1);
    expect(p5.publication(id).remoteChanges[0]).toMatchObject({
      kind: 'edit',
      state: 'requested',
      text: approved,
    });
    await expect
      .poll(() => detail().getByTestId('remote-change-status').textContent(), { timeout: 15_000 })
      .toContain('Text edit requested');

    p5.refuseArticleEdit(
      id,
      'limited_mode',
      '<p>Ore is heavy.</p><p>Edited on the website by the editor.</p>',
    );
    await openPublication(id);
    await conflict.waitFor({ timeout: 15_000 });
    expect(await conflict.getAttribute('data-conflict-reason')).toBe('limited_mode');
    expect(await conflict.textContent()).toContain('limited mode');
    expect(await conflict.getByTestId('conflict-reapply').count()).toBe(0);
  }, 90_000);
});
