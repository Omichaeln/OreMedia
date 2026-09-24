import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The browser-bound half of one authorization-code flow (state, nonce, PKCE verifier, where to return), carried in
 * a short-lived HttpOnly cookie sealed with AES-256-GCM. Nothing is stored server-side; the cookie cannot be read
 * or altered by the browser, lives ten minutes, is scoped to /auth/google and is cleared by the callback.
 */
export const FLOW_COOKIE = 'oremedia_oidc';
export const FLOW_COOKIE_PATH = '/auth/google';
export const FLOW_TTL_MS = 10 * 60 * 1000;

export interface FlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  /** Epoch milliseconds after which the flow is refused. */
  expiresAt: number;
}

const AAD = Buffer.from(`${FLOW_COOKIE}/v1`);

/** The sealing key is derived from the client secret (HKDF-SHA256), so no further secret has to be provisioned. */
export function flowKey(clientSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', clientSecret, 'oremedia', 'oremedia/oidc-flow-cookie/v1', 32));
}

export function sealFlow(flow: FlowState, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify({ v: 1, ...flow }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Null for anything that is not an unexpired flow sealed with this key (tampered, truncated, foreign, stale). */
export function openFlow(sealed: string | undefined, key: Buffer, now = Date.now()): FlowState | null {
  if (!sealed || sealed.length > 4096) return null;
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(json) as Partial<FlowState> & { v?: number };
    if (
      parsed.v !== 1 ||
      typeof parsed.state !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.codeVerifier !== 'string' ||
      typeof parsed.returnTo !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= now
    )
      return null;
    return {
      state: parsed.state,
      nonce: parsed.nonce,
      codeVerifier: parsed.codeVerifier,
      returnTo: safeReturnTo(parsed.returnTo),
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export const DEFAULT_RETURN_TO = '/portfolio';
const RETURN_BASE = 'https://return-to.invalid';

/** A candidate that is plainly a same-origin path: leading `/`, not `//` or `/\`, no backslash or control char. */
function looksLikeLocalPath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Open-redirect guard: only a same-origin relative path survives (`/c/x/b/y/home?tab=1`). Absolute URLs,
 * protocol-relative `//host`, backslashes (browsers read `/\host` as `//host`), control characters and the auth
 * routes themselves fall back to the default. The checks run on the input AND on the normalised result that is
 * returned (dot segments and `%2e` can turn `/.//evil.example` into `//evil.example`), so the function is
 * idempotent: safeReturnTo(safeReturnTo(x)) === safeReturnTo(x).
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !looksLikeLocalPath(value)) return DEFAULT_RETURN_TO;
  let url: URL;
  try {
    url = new URL(value, RETURN_BASE);
  } catch {
    return DEFAULT_RETURN_TO;
  }
  const out = `${url.pathname}${url.search}${url.hash}`;
  if (url.origin !== RETURN_BASE || !looksLikeLocalPath(out) || url.pathname.startsWith('/auth/'))
    return DEFAULT_RETURN_TO;
  // The browser resolves the returned value again: it must land on the same origin and the same path.
  const again = new URL(out, RETURN_BASE);
  if (again.origin !== RETURN_BASE || `${again.pathname}${again.search}${again.hash}` !== out)
    return DEFAULT_RETURN_TO;
  return out;
}
