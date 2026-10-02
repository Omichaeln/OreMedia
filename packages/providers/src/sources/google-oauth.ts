import { createHash } from 'node:crypto';
import type {
  ClientConfig,
  DecryptedCredentials,
  RefreshResult,
  RevokeResult,
} from '@oremedia/contracts/providers';
import { ProviderTransportError, type ProviderIO } from '../io';
import {
  ProviderAuthError,
  expiresAtFrom,
  formEncode,
  get,
  num,
  readResponse,
  revokeFromError,
  revokeFromResponse,
  str,
  summarise,
  type ProviderResponse,
} from '../shared';
import type { SourceGrant } from '../source-contract';

/*
 * Google's OAuth 2.0 web-server flow, shared by every Google-backed source adapter (GA4, Search Console). One place
 * knows the endpoints, the offline-access and consent parameters a refresh token depends on, the PKCE challenge and
 * the token response shape; each adapter contributes its scopes and its target listing.
 */
export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';

/** PKCE S256: base64url(SHA-256(verifier)). */
const codeChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/**
 * `access_type=offline` and `prompt=consent` together make Google issue a refresh token on every connect (without
 * consent a returning user gets none); `include_granted_scopes` keeps a scope granted to the same app earlier.
 */
export function googleAuthorizationUrl(input: {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  client: ClientConfig;
  scopes: readonly string[];
}): string {
  const u = new URL(GOOGLE_AUTHORIZE);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', input.client.clientId);
  u.searchParams.set('redirect_uri', input.redirectUri);
  u.searchParams.set('scope', input.scopes.join(' '));
  u.searchParams.set('state', input.state);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('code_challenge', codeChallenge(input.codeVerifier));
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

async function tokenRequest(io: ProviderIO, params: Record<string, string>): Promise<ProviderResponse> {
  const { res } = await io.request(
    GOOGLE_TOKEN,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formEncode(params),
    },
    { mutation: false }, // a token exchange creates nothing public; a repeat is refused, never duplicated
  );
  return readResponse(res);
}

const scopesOf = (res: ProviderResponse): string[] =>
  (str(get(res.json, 'scope')) ?? '').split(/\s+/).filter(Boolean);

/** Authorization code → access token, refresh token and the granted scopes (the refresh token is required). */
export async function googleExchangeCode(
  key: string,
  io: ProviderIO,
  input: { code: string; codeVerifier: string; redirectUri: string; client: ClientConfig },
): Promise<SourceGrant> {
  const res = await tokenRequest(io, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    code_verifier: input.codeVerifier,
  });
  const accessToken = str(get(res.json, 'access_token'));
  if (res.status !== 200 || !accessToken) throw new ProviderAuthError(key, 'exchange_failed', summarise(res));
  const refreshToken = str(get(res.json, 'refresh_token'));
  // Without a refresh token the grant dies with its first access token (about an hour): not a usable source.
  if (!refreshToken) throw new ProviderAuthError(key, 'exchange_failed', 'no refresh token issued');
  const expiresAt = expiresAtFrom(num(get(res.json, 'expires_in')));
  return {
    credentials: { accessToken, refreshToken, ...(expiresAt ? { expiresAt } : {}) },
    grantedScopes: scopesOf(res),
  };
}

/** The token-endpoint errors that mean the grant itself is gone (RFC 6749 §5.2): only these ask for a reconnect. */
const GRANT_GONE = new Set(['invalid_grant', 'unauthorized_client']);

/**
 * Refresh-token grant. Google answers a revoked or expired grant with 400 `invalid_grant` (reconnect); every other
 * failure (a misconfigured secret's `invalid_client`, a quota 429, a 5xx, a transport failure) is transient, so a
 * deployment mistake or a blip never flips every destination to unreachable. The refresh token itself is kept
 * (Google rotates it only on a new consent).
 */
export async function googleRefresh(
  credentials: DecryptedCredentials,
  client: ClientConfig,
  io: ProviderIO,
): Promise<RefreshResult> {
  if (!credentials.refreshToken) return { ok: false, reason: 'reconnect_required' };
  let res: ProviderResponse;
  try {
    res = await tokenRequest(io, {
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
  } catch (err) {
    if (err instanceof ProviderTransportError) return { ok: false, reason: 'transient' };
    throw err;
  }
  const accessToken = str(get(res.json, 'access_token'));
  if (res.status === 200 && accessToken) {
    const expiresAt = expiresAtFrom(num(get(res.json, 'expires_in')));
    return {
      ok: true,
      credentials: {
        ...credentials,
        accessToken,
        refreshToken: str(get(res.json, 'refresh_token')) ?? credentials.refreshToken,
        ...(expiresAt ? { expiresAt } : {}),
      },
      ...(expiresAt ? { tokenExpiresAt: expiresAt } : {}),
    };
  }
  const error = str(get(res.json, 'error'));
  return { ok: false, reason: error && GRANT_GONE.has(error) ? 'reconnect_required' : 'transient' };
}

/** A read of a Google API with the bearer token; the caller maps the status through its own classifier. */
export async function googleGet(io: ProviderIO, url: string, accessToken: string): Promise<ProviderResponse> {
  const { res } = await io.request(
    url,
    { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } },
    { mutation: false },
  );
  return readResponse(res);
}

/** A JSON read request of a Google API (reports are POSTed queries that create nothing); same mapping as googleGet. */
export async function googlePost(
  io: ProviderIO,
  url: string,
  accessToken: string,
  body: unknown,
): Promise<ProviderResponse> {
  const { res } = await io.request(
    url,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    { mutation: false },
  );
  return readResponse(res);
}

/**
 * RA-01: Google's revocation endpoint (`POST /revoke` with the token form-encoded): revoking the refresh token
 * revokes the grant and every access token issued under it. Google answers a token that is already invalid or
 * revoked with 400 `invalid_token` (not the RFC 7009 200), which is `revoked` here too: the access is gone.
 */
export async function googleRevoke(credentials: DecryptedCredentials, io: ProviderIO): Promise<RevokeResult> {
  try {
    const { res } = await io.request(
      GOOGLE_REVOKE,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formEncode({ token: credentials.refreshToken ?? credentials.accessToken }),
      },
      { mutation: true },
    );
    return revokeFromResponse(
      await readResponse(res),
      (r) => r.status === 200 || (r.status === 400 && str(get(r.json, 'error')) === 'invalid_token'),
    );
  } catch (err) {
    return revokeFromError(err);
  }
}
