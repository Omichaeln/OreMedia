import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { authenticate, hashForAudit, type Principal } from '@oremedia/module-access';
import { withLogContext } from '@oremedia/observability';

export interface RequestContext {
  correlationId: string;
  principal: Principal | null;
  requestedTenantId: string | undefined;
  headers: IncomingHttpHeaders;
  /** Cookie-based browser sessions must present a matching CSRF header on mutations (spec 18). */
  csrf: { cookie: string | undefined; header: string | undefined };
  /** Set only when authentication came from a cookie rather than a bearer header. */
  cookieSession: boolean;
  /** Spec 5.6: review decisions record the origin as salted hashes, never the raw IP or user agent. */
  ipHash: string | null;
  userAgentHash: string | null;
}

export const SESSION_COOKIE = 'oremedia_session';
export const CSRF_COOKIE = 'oremedia_csrf';
/** `__Host-` cookies are Secure, Path=/ and host-only: a sibling subdomain can neither set nor shadow them. */
export const HOST_PREFIX = '__Host-';

/** The cookie names the API sets: `__Host-` prefixed whenever cookies are Secure (production). */
export const cookieNames = (secure: boolean) =>
  secure
    ? { session: `${HOST_PREFIX}${SESSION_COOKIE}`, csrf: `${HOST_PREFIX}${CSRF_COOKIE}` }
    : { session: SESSION_COOKIE, csrf: CSRF_COOKIE };

/**
 * The session and CSRF cookie values of a request, as a pair. In production only the `__Host-` names count (an
 * unprefixed cookie could have been planted by a sibling subdomain); elsewhere (http development and tests) the
 * unprefixed names are read when no `__Host-` session is present.
 */
export function sessionCookies(cookies: Record<string, string>): { session?: string; csrf?: string } {
  const host = {
    session: cookies[`${HOST_PREFIX}${SESSION_COOKIE}`],
    csrf: cookies[`${HOST_PREFIX}${CSRF_COOKIE}`],
  };
  if (process.env['NODE_ENV'] === 'production' || host.session) return host;
  return { session: cookies[SESSION_COOKIE], csrf: cookies[CSRF_COOKIE] };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v; // a malformed escape is kept verbatim (and then fails whatever check reads it)
    }
  }
  return out;
}

export function firstHeader(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

/** A client-supplied correlation id is echoed into logs and audit rows, so only a safe charset is accepted. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Salt for origin hashes (AUDIT_HASH_SALT); absent, hashes are still one-way but not keyed. */
const originSalt = () => process.env['AUDIT_HASH_SALT'] ?? 'oremedia';

/** Correlation id and salted origin hashes of a request (the fields audit rows and sessions record). */
export function requestOrigin(
  headers: IncomingHttpHeaders,
  remoteAddress?: string,
): { correlationId: string; ipHash: string | null; userAgentHash: string | null } {
  const requestedCorrelationId = firstHeader(headers['x-correlation-id']);
  const correlationId =
    requestedCorrelationId && CORRELATION_ID.test(requestedCorrelationId)
      ? requestedCorrelationId
      : randomUUID();
  return {
    correlationId,
    ipHash: remoteAddress ? hashForAudit(remoteAddress, originSalt()) : null,
    userAgentHash: headers['user-agent'] ? hashForAudit(String(headers['user-agent']), originSalt()) : null,
  };
}

/** Builds the request context from raw headers; the same function serves HTTP and in-process test callers. */
export async function createContext(
  headers: IncomingHttpHeaders,
  remoteAddress?: string,
): Promise<RequestContext> {
  const { correlationId, ipHash, userAgentHash } = requestOrigin(headers, remoteAddress);
  const cookies = sessionCookies(parseCookies(firstHeader(headers['cookie'])));
  const auth = firstHeader(headers['authorization']);
  let bearer: string | undefined;
  let cookieSession = false;
  if (auth?.startsWith('Bearer ')) bearer = auth.slice(7).trim();
  else if (cookies.session) {
    bearer = cookies.session;
    cookieSession = true;
  }
  const principal = await withLogContext({ correlationId }, () => authenticate(bearer));
  return {
    correlationId,
    principal,
    requestedTenantId: firstHeader(headers['x-oremedia-tenant'])?.slice(0, 32),
    headers,
    csrf: { cookie: cookies.csrf, header: firstHeader(headers['x-oremedia-csrf']) },
    cookieSession,
    ipHash,
    userAgentHash,
  };
}
