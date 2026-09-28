import { afterEach, describe, expect, it } from 'vitest';
import { PASSWORD_SIGN_IN_PATH, postPasswordAuth, readCsrfCookie } from './session';

const setCookies = (cookie: string) => {
  (globalThis as { document?: { cookie: string } }).document = { cookie };
};

describe('readCsrfCookie (D-03 cookie names)', () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('reads the production __Host- cookie, preferring it over an unprefixed one', () => {
    setCookies('oremedia_csrf=planted-by-sibling; __Host-oremedia_csrf=real-value');
    expect(readCsrfCookie()).toBe('real-value');
  });

  it('falls back to the unprefixed cookie over http (development and tests)', () => {
    setCookies('other=1; oremedia_csrf=dev-value');
    expect(readCsrfCookie()).toBe('dev-value');
  });

  it('is null without either', () => {
    setCookies('other=1');
    expect(readCsrfCookie()).toBeNull();
  });
});

describe('postPasswordAuth (password sign-in and setup)', () => {
  const answering =
    (status: number, body: unknown): typeof fetch =>
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const signIn = (fetchImpl: typeof fetch) =>
    postPasswordAuth(PASSWORD_SIGN_IN_PATH, { email: 'a@acme.test', password: 'x' }, fetchImpl);

  it('posts JSON to the same-origin route with credentials', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    await signIn(async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    expect(seen).toMatchObject({
      url: '/auth/password/sign-in',
      init: { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' } },
    });
  });

  it('passes the typed answer through', async () => {
    await expect(signIn(answering(200, { ok: true }))).resolves.toEqual({ ok: true });
    await expect(signIn(answering(401, { ok: false, error: 'invalid_credentials' }))).resolves.toEqual({
      ok: false,
      error: 'invalid_credentials',
    });
    await expect(
      signIn(answering(400, { ok: false, error: 'password_rejected', issue: 'too_short' })),
    ).resolves.toEqual({ ok: false, error: 'password_rejected', issue: 'too_short' });
  });

  it('a 429 of any shape is too_many_attempts; an unreadable answer or no network is sign_in_failed', async () => {
    await expect(signIn(answering(429, { code: 'RATE_LIMITED' }))).resolves.toEqual({
      ok: false,
      error: 'too_many_attempts',
    });
    await expect(signIn(answering(502, 'Bad gateway'))).resolves.toEqual({
      ok: false,
      error: 'sign_in_failed',
    });
    await expect(
      signIn(async () => {
        throw new TypeError('offline');
      }),
    ).resolves.toEqual({ ok: false, error: 'sign_in_failed' });
  });
});
