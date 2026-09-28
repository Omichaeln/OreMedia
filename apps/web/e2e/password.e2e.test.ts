import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { auditPage, dialogFocusTrap, formatViolations } from './a11y';
import { createMockAuthHandler, createMockHandler, E2E, E2E_EMAIL, MockBackend } from './mock-api';
import { startStaticServer } from './static-server';

/**
 * Password sign-in, the second login method next to Google: the sign-in form, the one-time setup link an owner issues
 * in Settings → Members and the page it opens, and Settings → Account (set, change, remove). The built app in
 * Chromium against the mock transport, whose /auth password routes answer as apps/api does (same paths, JSON, Origin
 * check, session cookie). Opt-in like the other smokes (`OREMEDIA_E2E=1`).
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const settings = (tab: string) =>
  `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/settings?tab=${tab}`;
const PASSWORD = 'harbour lantern quietly';

describe.skipIf(!enabled)('password sign-in (built app in Chromium, mock transport)', () => {
  const backend = new MockBackend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  const contexts: BrowserContext[] = [];

  const fresh = async (width = 1280): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
    return page;
  };
  /** The owner, signed in with the development session token (as every other suite). */
  const owner = async (width = 1280): Promise<Page> => {
    const page = await fresh(width);
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(E2E.token);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/portfolio*', { timeout: 15_000 });
    return page;
  };
  const noViolations = async (page: Page, name: string, narrow = false) => {
    const violations = await auditPage(page, { narrow });
    expect(violations, formatViolations(name, violations)).toEqual([]);
  };

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const served = await startStaticServer({
      dist,
      trpcHandler: createMockHandler(backend),
      authHandler: createMockAuthHandler(backend),
    });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
  }, 60_000);

  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser?.close();
    await close();
  });

  it('signs in with email and password: a wrong password reads the generic error, the right one opens the portfolio', async () => {
    backend.passwords.set(E2E_EMAIL, { password: PASSWORD, sessionToken: E2E.token });
    try {
      const page = await fresh(390);
      await page.goto(`${origin}/sign-in?next=%2Fportfolio`);
      const form = page.getByTestId('password-sign-in');
      // Google stays the first method; the development token form is still offered on a loopback address.
      await page.getByRole('link', { name: 'Continue with Google' }).waitFor({ timeout: 15_000 });
      expect(await page.getByLabel('Session token').count()).toBe(1);
      expect(await form.getByLabel('Email').getAttribute('autocomplete')).toBe('email');
      expect(await form.getByLabel('Password', { exact: true }).getAttribute('autocomplete')).toBe(
        'current-password',
      );

      await form.getByLabel('Email').fill(E2E_EMAIL);
      await form.getByLabel('Password', { exact: true }).fill('not the password at all');
      await form.getByRole('button', { name: 'Sign in' }).click();
      await form.getByRole('alert').waitFor({ timeout: 15_000 });
      expect(await form.getByRole('alert').textContent()).toContain('do not match an account');
      expect(await form.getByLabel('Password', { exact: true }).inputValue()).toBe('');
      await noViolations(page, 'sign in (password refused, 390px)', true);

      await form.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await form.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL('**/portfolio*', { timeout: 15_000 });
      await page.getByRole('list', { name: 'Companies' }).waitFor({ timeout: 15_000 });
      // The cookie session is the credential now: the page sent JSON from its own origin, no pasted token.
      const sent = backend.authRequests.filter((r) => r.path === '/auth/password/sign-in').at(-1);
      expect(sent).toMatchObject({ origin, body: { email: E2E_EMAIL, password: PASSWORD } });
      expect(await page.evaluate(() => sessionStorage.getItem('oremedia.session_token'))).toBeNull();
    } finally {
      backend.passwords.delete(E2E_EMAIL);
    }
  }, 60_000);

  it('an owner issues a one-time link in Members; it opens /set-password, sets the password and signs the member in once', async () => {
    const page = await owner();
    await page.goto(`${origin}${settings('members')}`);
    await page
      .getByRole('button', { name: 'Password link for lina@example.test' })
      .waitFor({ timeout: 15_000 });
    // Not for yourself: your own row points to Settings → Account instead.
    expect(await page.getByRole('button', { name: 'Password link for E2E person' }).count()).toBe(0);
    expect(await page.getByTestId('own-password-settings').count()).toBe(1);
    await page.getByRole('button', { name: 'Password link for lina@example.test' }).click();
    const dialog = page.getByRole('dialog', { name: 'Password link for lina@example.test' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Issue link' }).click();
    const field = dialog.getByLabel('Link');
    await field.waitFor({ timeout: 15_000 });
    const url = await field.inputValue();
    expect(url).toMatch(new RegExp(`^${origin}/set-password#token=pst_e2e_[0-9a-f]+$`));
    expect(await dialog.textContent()).toMatch(/Expires /);
    expect(await dialog.getByRole('button', { name: 'Copy link' }).count()).toBe(1);
    const violations = [...(await auditPage(page, { narrow: false })), ...(await dialogFocusTrap(page))];
    expect(violations, formatViolations('password link dialog', violations)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);

    // The member opens the link in their own browser.
    const member = await fresh(390);
    await member.goto(url);
    const form = member.getByTestId('set-password');
    await form.waitFor({ timeout: 15_000 });
    // The token is read once and removed from the address bar.
    expect(new URL(member.url()).hash).toBe('');
    expect(await form.getByLabel('New password', { exact: true }).getAttribute('autocomplete')).toBe(
      'new-password',
    );
    await noViolations(member, 'set password (390px)', true);

    await form.getByLabel('New password', { exact: true }).fill('too short');
    await form.getByLabel('Confirm new password').fill('different');
    await form.getByRole('button', { name: 'Set password and sign in' }).click();
    expect(await form.getByText('Use at least 12 characters.').count()).toBe(1);
    expect(await form.getByText('The two passwords do not match.').count()).toBe(1);
    expect(backend.authRequests.filter((r) => r.path === '/auth/password/setup')).toHaveLength(0);

    await form.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await form.getByLabel('Confirm new password').fill(PASSWORD);
    await form.getByRole('button', { name: 'Set password and sign in' }).click();
    await member.waitForURL('**/portfolio*', { timeout: 15_000 });
    await member.getByRole('region', { name: E2E.companyName }).waitFor({ timeout: 15_000 });

    // Single use: the same link again is refused with an explanation.
    const again = await fresh(1280);
    await again.goto(url);
    await again.getByTestId('set-password').waitFor({ timeout: 15_000 });
    await again.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await again.getByLabel('Confirm new password').fill(PASSWORD);
    await again.getByRole('button', { name: 'Set password and sign in' }).click();
    await again.getByTestId('set-password-failure').waitFor({ timeout: 15_000 });
    expect(await again.getByTestId('set-password-failure').textContent()).toContain('no longer valid');
    await noViolations(again, 'set password (link used)');

    // And the member can now sign in with the password.
    const signIn = await fresh(1280);
    await signIn.goto(`${origin}/sign-in`);
    const signInForm = signIn.getByTestId('password-sign-in');
    await signInForm.getByLabel('Email').fill('lina@example.test');
    await signInForm.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await signInForm.getByRole('button', { name: 'Sign in' }).click();
    await signIn.waitForURL('**/portfolio*', { timeout: 15_000 });
  }, 90_000);

  it('/set-password without a link explains what is missing', async () => {
    const page = await fresh(390);
    await page.goto(`${origin}/set-password`);
    await page.getByTestId('set-password-missing').waitFor({ timeout: 15_000 });
    expect(await page.getByTestId('set-password').count()).toBe(0);
    await noViolations(page, 'set password (no link)', true);
  }, 30_000);

  it('Settings → Account: set a password, change it (the current one is required), remove it while Google is linked', async () => {
    backend.passwords.delete(E2E_EMAIL);
    backend.hasGoogle = true;
    const page = await owner(390);
    await page.goto(`${origin}${settings('account')}`);
    const section = page.getByTestId('account-password');
    await section.getByTestId('sign-in-methods').waitFor({ timeout: 15_000 });
    expect(await section.getByTestId('sign-in-methods').textContent()).toContain('You sign in with Google.');
    expect(await section.getByLabel('Current password').count()).toBe(0);
    await noViolations(page, 'settings account (no password, 390px)', true);

    await section.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await section.getByLabel('Confirm new password').fill(PASSWORD);
    await section.getByRole('button', { name: 'Set password' }).click();
    await section.getByTestId('password-saved').waitFor({ timeout: 15_000 });
    await expect
      .poll(() => section.getByTestId('sign-in-methods').textContent(), { timeout: 15_000 })
      .toContain('Google or with your email and password');
    expect(backend.passwords.get(E2E_EMAIL)?.password).toBe(PASSWORD);

    // Changing it needs the current password; a wrong one is named on its field.
    await section.getByLabel('Current password').fill('not my password at all');
    await section.getByLabel('New password', { exact: true }).fill('a completely new passphrase');
    await section.getByLabel('Confirm new password').fill('a completely new passphrase');
    await section.getByRole('button', { name: 'Change password' }).click();
    await section.getByText('That is not your current password.').waitFor({ timeout: 15_000 });
    await noViolations(page, 'settings account (wrong current password, 390px)', true);
    await section.getByLabel('Current password').fill(PASSWORD);
    await section.getByRole('button', { name: 'Change password' }).click();
    await expect
      .poll(() => backend.passwords.get(E2E_EMAIL)?.password, { timeout: 15_000 })
      .toBe('a completely new passphrase');

    await section.getByRole('button', { name: 'Remove password' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Remove your password?' });
    await confirm.waitFor();
    // Removing needs the current password too.
    await confirm.getByLabel('Current password').fill('not my password at all');
    await confirm.getByRole('button', { name: 'Remove password' }).click();
    await confirm.getByText('That is not your current password.').waitFor({ timeout: 15_000 });
    expect(backend.passwords.has(E2E_EMAIL)).toBe(true);
    await confirm.getByLabel('Current password').fill('a completely new passphrase');
    const violations = [...(await auditPage(page, { narrow: true })), ...(await dialogFocusTrap(page))];
    expect(violations, formatViolations('remove password dialog', violations)).toEqual([]);
    await confirm.getByRole('button', { name: 'Remove password' }).click();
    await expect.poll(() => backend.passwords.has(E2E_EMAIL), { timeout: 15_000 }).toBe(false);
    await expect
      .poll(() => section.getByTestId('sign-in-methods').textContent(), { timeout: 15_000 })
      .toContain('You sign in with Google.');
  }, 90_000);

  it('Settings → Account: a first password after a sign-in older than 15 minutes asks the person to sign in again', async () => {
    backend.passwords.delete(E2E_EMAIL);
    backend.recentSignIn = false;
    try {
      const page = await owner(390);
      await page.goto(`${origin}${settings('account')}`);
      const section = page.getByTestId('account-password');
      await section.getByTestId('sign-in-methods').waitFor({ timeout: 15_000 });
      await section.getByLabel('New password', { exact: true }).fill(PASSWORD);
      await section.getByLabel('Confirm new password').fill(PASSWORD);
      await section.getByRole('button', { name: 'Set password' }).click();
      const banner = section.getByTestId('recent-sign-in-required');
      await banner.waitFor({ timeout: 15_000 });
      expect(await banner.textContent()).toContain('Sign in again to set a password');
      expect(await banner.getByRole('button', { name: 'Sign out and sign in again' }).count()).toBe(1);
      expect(backend.passwords.has(E2E_EMAIL)).toBe(false);
      await noViolations(page, 'settings account (sign in again, 390px)', true);
    } finally {
      backend.recentSignIn = true;
    }
  }, 45_000);

  it('Settings → Account without Google: the password cannot be removed', async () => {
    backend.passwords.set(E2E_EMAIL, { password: PASSWORD, sessionToken: E2E.token });
    backend.hasGoogle = false;
    try {
      const page = await owner(1280);
      await page.goto(`${origin}${settings('account')}`);
      const section = page.getByTestId('account-password');
      await section.getByTestId('sign-in-methods').waitFor({ timeout: 15_000 });
      expect(await section.getByRole('button', { name: 'Remove password' }).count()).toBe(0);
      expect(await section.textContent()).toContain('it cannot be removed');
    } finally {
      backend.hasGoogle = true;
      backend.passwords.delete(E2E_EMAIL);
    }
  }, 45_000);
});
