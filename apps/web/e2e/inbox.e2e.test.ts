import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createMockHandler, E2E, MockBackend } from './mock-api';
import { PC } from './mock-community';
import { startStaticServer } from './static-server';

/**
 * Comment inbox in the BUILT app at phone width against the in-process mock transport: conversations newest first,
 * a conversation threaded by parent with the brand's replies and their state, a reply sent with an idempotency key
 * and followed to sent, the channel's length limit, and a reader without inbox.respond who sees neither handles nor
 * reply controls. Opt-in like the other smokes (`OREMEDIA_E2E=1`); `settle` stands in for the reply workflow.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

describe.skipIf(!enabled)('comment inbox (built app in Chromium, mock transport, phone width)', () => {
  const backend = new MockBackend();
  const community = backend.community;
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;

  const brandPath = (rest: string) =>
    `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/${rest}`;
  const open = async (rest: string) => {
    await page.goto('about:blank');
    await page.goto(`${origin}${brandPath(rest)}`);
  };
  const entry = (id: string) => page.getByTestId(`thread-${id}`);
  const noHorizontalOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

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
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('Inbox is in the brand navigation; conversations list newest activity first with counts', async () => {
    await open('home');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page
      .getByRole('navigation', { name: 'Brand sections' })
      .getByRole('link', { name: /^Inbox/ })
      .click();
    await page.waitForURL('**/inbox*', { timeout: 15_000 });
    const list = page.getByRole('list', { name: 'Conversations' });
    await list.waitFor({ timeout: 15_000 });
    const rows = list.getByRole('button');
    expect(await rows.count()).toBe(2);
    expect(await rows.nth(0).textContent()).toContain('Spring collection is live');
    expect(await rows.nth(0).textContent()).toContain('3 comments');
    expect(await rows.nth(0).textContent()).toContain('@lina');
    expect(await rows.nth(1).textContent()).toContain('1 comment');
    expect(await noHorizontalOverflow()).toBe(true);
  }, 45_000);

  it('a conversation is threaded by parent, with handles and a reply that was not posted and why', async () => {
    await open(`inbox?conversation=${PC.conversations.launch}`);
    await page.getByTestId('thread').waitFor({ timeout: 15_000 });
    const items = page.getByTestId('thread').locator(':scope > li');
    expect(await items.count()).toBe(4);
    expect(await items.nth(0).textContent()).toContain('Do you ship to Norway?');
    expect(await items.nth(1).textContent()).toContain('Same question for Ghana!');
    // The follow-up is indented under the comment it answers.
    const indent = (i: number) => items.nth(i).evaluate((el) => getComputedStyle(el).marginInlineStart);
    expect(parseFloat(await indent(1))).toBeGreaterThan(parseFloat(await indent(0)));
    expect(await entry(PC.messages.question).textContent()).toContain('@bea');
    const failed = entry(PC.failedReply);
    expect(await failed.getByTestId('reply-state').textContent()).toContain('Not posted');
    expect(await failed.getByTestId('reply-failure').textContent()).toContain(
      'The platform refused the comment.',
    );
    expect(await noHorizontalOverflow()).toBe(true);
  }, 45_000);

  it('a reply is sent once with an idempotency key, shows Sending, then Sent once the workflow posts it', async () => {
    await open(`inbox?conversation=${PC.conversations.launch}`);
    const question = entry(PC.messages.question);
    await question.getByRole('button', { name: 'Reply' }).click({ timeout: 15_000 });
    await question.getByLabel('Reply to @bea').fill('Yes, we ship to Norway within 5 days.');
    const before = backend.requests.filter((r) => r.path === 'community.reply').length;
    await question.getByRole('button', { name: 'Send reply' }).click();
    await expect
      .poll(() => community.replies.filter((r) => r.state === 'queued').length, { timeout: 15_000 })
      .toBe(1);
    const calls = backend.requests.filter((r) => r.path === 'community.reply').slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['idempotency-key']).toBeTruthy();
    const queued = community.replies.find((r) => r.state === 'queued')!;
    expect(queued.replyToMessageId).toBe(PC.messages.question);
    const pending = entry(queued.id);
    await expect
      .poll(() => pending.getByTestId('reply-state').textContent(), { timeout: 15_000 })
      .toContain('Sending');

    community.settle(queued.id, 'sent');
    // The conversation re-reads itself while a reply is in flight; the button asks at once.
    await page
      .getByRole('button', { name: 'Check reply status' })
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    const sent = page.getByRole('article', { name: 'Brand reply' }).filter({ hasText: 'Norway within' });
    await expect
      .poll(async () => (await sent.getByTestId('reply-state').allTextContents()).join('|'), {
        timeout: 15_000,
      })
      .toBe('✓Sent');
    expect(await page.getByTestId(`thread-${queued.id}`).count()).toBe(0); // the draft entry gave way to the message
  }, 45_000);

  it('a reply over the channel limit is refused in the form; nothing is sent', async () => {
    await open(`inbox?conversation=${PC.conversations.recipe}`);
    const comment = entry(PC.messages.recipe);
    await comment.getByRole('button', { name: 'Reply' }).click({ timeout: 15_000 });
    await comment.getByLabel('Reply to @dan').fill('x'.repeat(PC.maxLength + 1));
    const before = backend.requests.filter((r) => r.path === 'community.reply').length;
    await comment.getByRole('button', { name: 'Send reply' }).click();
    await expect
      .poll(() => comment.getByRole('alert').textContent(), { timeout: 15_000 })
      .toContain(`allows ${PC.maxLength} characters`);
    expect(backend.requests.filter((r) => r.path === 'community.reply').length).toBe(before);
  }, 45_000);

  it('without inbox.respond the comments are readable but anonymous, with no reply controls', async () => {
    backend.role = 'analyst';
    try {
      await open(`inbox?conversation=${PC.conversations.launch}`);
      await page.getByTestId('read-only-note').waitFor({ timeout: 15_000 });
      expect(await page.getByRole('button', { name: 'Reply' }).count()).toBe(0);
      expect(await page.getByTestId('thread').textContent()).not.toContain('@bea');
      expect(await page.getByRole('list', { name: 'Conversations' }).textContent()).not.toContain('@lina');
    } finally {
      backend.role = 'owner';
    }
  }, 45_000);
});
