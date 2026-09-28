import {
  PasswordAuthResponse,
  type PasswordAuthErrorCode,
  type PasswordSetup,
  type PasswordSignIn,
} from '@oremedia/contracts/access';
import { readCookie } from './cookies';

/**
 * How the app authenticates (spec 7.1, D-03, apps/api/src/context.ts and apps/api/src/auth):
 *  - a cookie session set by Google or password sign-in (`__Host-oremedia_session`, HttpOnly; unprefixed over http in
 *    development) plus the CSRF double-submit cookie (`__Host-oremedia_csrf`), both first-party because the web origin proxies /trpc and /auth to the API; or
 *  - development only: a bearer session token (`ses_…`) pasted on the sign-in screen, kept per tab
 *    (sessionStorage), never written to a cookie or localStorage. The e2e suites use it with their mock transport.
 */
const TOKEN_KEY = 'oremedia.session_token';
export const SESSION_COOKIE = 'oremedia_session';
export const CSRF_COOKIE = 'oremedia_csrf';
/** Production sets `__Host-oremedia_csrf` (Secure, host-only); http development and tests the plain name. */
export const HOST_CSRF_COOKIE = `__Host-${CSRF_COOKIE}`;

/** The CSRF double-submit value the API expects in `X-Oremedia-CSRF` (the `__Host-` cookie wins when present). */
export function readCsrfCookie(): string | null {
  return readCookie(HOST_CSRF_COOKIE) ?? readCookie(CSRF_COOKIE);
}
export const HEADER_CSRF = 'x-oremedia-csrf';

/** Sign-in and sign-out are same-origin routes (the web container proxies /auth/* to the API). */
export const googleSignInHref = (next: string): string =>
  `/auth/google/start?returnTo=${encodeURIComponent(next)}`;
export const SIGN_OUT_PATH = '/auth/sign-out';
export const PASSWORD_SIGN_IN_PATH = '/auth/password/sign-in';
export const PASSWORD_SETUP_PATH = '/auth/password/setup';

const failure = (error: PasswordAuthErrorCode): PasswordAuthResponse => ({ ok: false, error });

/**
 * Password sign-in and password setup (apps/api/src/auth/router.ts): a same-origin JSON POST that answers
 * `{ ok: true }` with the session cookies set, or a typed error code. A 429 from the per-address limit is
 * `too_many_attempts` too; anything unreadable is `sign_in_failed`. On success a pasted development token is dropped
 * so the new cookie session is the one the app uses.
 */
export async function postPasswordAuth(
  path: typeof PASSWORD_SIGN_IN_PATH | typeof PASSWORD_SETUP_PATH,
  body: PasswordSignIn | PasswordSetup,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<PasswordAuthResponse> {
  let res: Response;
  try {
    res = await fetchImpl(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return failure('sign_in_failed');
  }
  if (res.status === 429) return failure('too_many_attempts');
  const parsed = PasswordAuthResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return failure('sign_in_failed');
  if (parsed.data.ok) clearBearerToken();
  return parsed.data;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The pasted-token path exists for development and the browser suites only: a Vite dev server, or the built app
 * served from a loopback address. A deployed app (a real host name) never offers it. The API judges any token.
 */
export function tokenSignInAvailable(): boolean {
  if (import.meta.env.DEV) return true;
  return typeof window !== 'undefined' && LOOPBACK.has(window.location.hostname);
}

export function getBearerToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setBearerToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    // Private mode or blocked storage: the token then lives only for this page load.
  }
}

export function clearBearerToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // nothing to clear
  }
}

/** True when there is anything that could authenticate a request; the API remains the judge. */
export function hasCredential(): boolean {
  return Boolean(getBearerToken() || readCsrfCookie());
}

/**
 * Ends the session: the API revokes a cookie session (CSRF double-submit header) and clears both cookies; a pasted
 * token is dropped from this tab. The sign-in screen follows whatever the network says.
 */
export async function signOut(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<void> {
  const csrf = readCsrfCookie();
  const bearer = getBearerToken();
  clearBearerToken();
  if (csrf || bearer) {
    try {
      await fetchImpl(SIGN_OUT_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...(csrf ? { [HEADER_CSRF]: csrf } : {}),
          ...(bearer && !csrf ? { authorization: `Bearer ${bearer}` } : {}),
        },
      });
    } catch {
      // Offline: the cookie is HttpOnly and cannot be cleared here; the session still ends at its idle timeout.
    }
  }
  window.location.assign('/sign-in');
}
