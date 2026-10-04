import { randomUUID } from 'node:crypto';
import type { FetchLike } from '../../../../tooling/scripts/acceptance/http';
import { describeResponse } from '../../../../tooling/scripts/acceptance/report';

/**
 * The deployed api as the acceptance job reaches it: the same request shapes the smoke check and the k6 script
 * use (superjson envelope `{ json: input }`, bearer session, `X-Oremedia-Tenant`, an idempotency key per
 * mutation). Tokens live in the session object in memory and never appear in a returned detail.
 */
/** The client every request here uses: the global fetch, unless the startup probe switched it (probe.ts). */
let httpFetch: FetchLike = (...args) => globalThis.fetch(...args);
export const configureFetch = (f: FetchLike): void => {
  httpFetch = f;
};

export interface ApiSession {
  /** The origin requests go to (the web origin, or the api's private URL). */
  baseUrl: string;
  token: string;
  tenantId: string;
}

export interface ApiAnswer<T> {
  status: number;
  data: T | null;
  /** `HTTP <status> [<code>][: <message>]` for a failed call, empty otherwise. */
  error: string;
}

interface TrpcFailure {
  error?: {
    json?: {
      message?: string;
      data?: {
        envelope?: { code?: string; message?: string; details?: Array<{ path?: string; issue?: string }> };
      };
    };
  };
}

/** At most this many envelope details (spec 7.2: `{ path, issue }`, e.g. `assetId: asset_approved`) in a detail line. */
const MAX_DETAILS = 5;

/** `HTTP <status> [<code>][: <message>][ [<path>: <issue>; …]]`: what a failed call answered, with its issues. */
export const trpcError = (body: unknown, status: number): string => {
  const env = (body as TrpcFailure | null)?.error?.json;
  const code = env?.data?.envelope?.code;
  const details = (env?.data?.envelope?.details ?? []).map((d) =>
    d.path ? `${d.path}: ${d.issue ?? '?'}` : (d.issue ?? '?'),
  );
  const listed = details.length
    ? ` [${details.slice(0, MAX_DETAILS).join('; ')}${details.length > MAX_DETAILS ? `; +${details.length - MAX_DETAILS} more` : ''}]`
    : '';
  return `HTTP ${status}${code ? ` ${code}` : ''}${env?.message ? `: ${env.message}` : ''}${listed}`;
};

async function answer<T>(res: Response): Promise<ApiAnswer<T>> {
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (res.status !== 200)
    return {
      status: res.status,
      data: null,
      error: `${trpcError(body, res.status)} (${describeResponse(res, text.length)})`,
    };
  const data = (body as { result?: { data?: { json?: T } } } | null)?.result?.data?.json ?? null;
  return {
    status: res.status,
    data,
    error: data === null ? `no data (${describeResponse(res, text.length)})` : '',
  };
}

export const headersFor = (s: ApiSession): Record<string, string> => ({
  authorization: `Bearer ${s.token}`,
  'x-oremedia-tenant': s.tenantId,
  'x-correlation-id': `acceptance-${randomUUID()}`,
});

export async function mutate<T>(s: ApiSession, path: string, input: unknown): Promise<ApiAnswer<T>> {
  const res = await httpFetch(`${s.baseUrl}/trpc/${path}`, {
    method: 'POST',
    headers: { ...headersFor(s), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ json: input }),
  });
  return answer<T>(res);
}

export async function query<T>(s: ApiSession, path: string, input?: unknown): Promise<ApiAnswer<T>> {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const res = await httpFetch(`${s.baseUrl}/trpc/${path}${qs}`, { headers: headersFor(s) });
  return answer<T>(res);
}

/**
 * PUT bytes to an upload intent's signed URL, as the browser does (the store answers it, not the api). The status,
 * or the network error's name and message, is what comes back; never the URL, whose query carries the signature.
 */
export async function putObject(
  uploadUrl: string,
  bytes: Uint8Array,
  mime: string,
): Promise<{ status: number; error: string }> {
  try {
    const res = await httpFetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': mime },
      // A copy on a plain ArrayBuffer: a BodyInit under both the Node and the DOM typings.
      body: new Uint8Array(bytes),
    });
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, error: res.status >= 300 ? `HTTP ${res.status}` : '' };
  } catch (err) {
    return { status: 0, error: err instanceof Error ? `${err.name}: ${err.message}` : 'request failed' };
  }
}

export type SignInAnswer = { ok: true; token: string } | { ok: false; status: number; error: string };

/**
 * POST /auth/password/sign-in through the web origin with the Origin header the api's login-CSRF check expects, as
 * a browser's form submission arrives; the session cookie's value is the bearer every later call presents (the
 * smoke check reads it the same way). The password leaves this function only in the request body.
 */
export async function signInWithPassword(
  webOrigin: string,
  email: string,
  password: string,
): Promise<SignInAnswer> {
  const res = await httpFetch(`${webOrigin}/auth/password/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: webOrigin },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => /^(?:__Host-)?oremedia_session=([^;]+)/.exec(c)?.[1])
    .find(Boolean);
  if (res.status === 200 && cookie) return { ok: true, token: decodeURIComponent(cookie) };
  const text = await res.text().catch(() => '');
  let error = '';
  try {
    error = String((JSON.parse(text) as { error?: unknown } | null)?.error ?? '');
  } catch {
    error = '';
  }
  // No cookie value is ever reported: only whether the session cookie header arrived at all.
  return {
    ok: false,
    status: res.status,
    error: `${error || 'no session cookie'} (${describeResponse(res, text.length)})`,
  };
}

/** POST /auth/sign-out for a session the job holds, so no fixture session outlives the run. */
export async function signOut(webOrigin: string, token: string): Promise<void> {
  await httpFetch(`${webOrigin}/auth/sign-out`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => undefined);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
