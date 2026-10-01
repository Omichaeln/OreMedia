import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../../testing';
import { ProviderAuthError } from '../../shared';
import { ga4PropertyAdapter as adapter } from './adapter';

const fx = (name: string) => loadScenario(new URL('./fixtures/auth.json', import.meta.url), name);
const client = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' };
const creds: DecryptedCredentials = { accessToken: 'ya29_at_1_fake', refreshToken: '1//rt_1_fake' };

describe('GA4 property source adapter (ledger R2-1, spec 14.5 / 14.6)', () => {
  const server = new FixtureServer();
  let io: FixtureIO;
  beforeAll(async () => {
    await server.start();
    io = await fixtureIO(server, { providerKey: adapter.key });
  });
  afterAll(() => server.stop());
  const load = (name: string): void => {
    server.load(fx(name));
    io.calls.length = 0;
  };

  it('authorizationUrl: Google code flow with offline access, consent, the readonly scope and a PKCE S256 challenge', async () => {
    const { url } = await adapter.authorizationUrl({
      state: 'st_1',
      codeVerifier: 'v_1',
      redirectUri: 'https://app.test/connect/callback',
      client,
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(client.clientId);
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.test/connect/callback');
    expect(u.searchParams.get('state')).toBe('st_1');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/analytics.readonly');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update('v_1').digest('base64url'));
    expect(url).not.toContain('csecret');
  });

  it('exchangeCode: the token response becomes a grant with refresh token, expiry and granted scopes', async () => {
    load('exchange');
    const grant = await adapter.exchangeCode(
      { code: 'code_1', codeVerifier: 'v_1', redirectUri: 'https://app.test/connect/callback', client },
      io,
    );
    expect(grant.credentials.accessToken).toBe('ya29_at_1_fake');
    expect(grant.credentials.refreshToken).toBe('1//rt_1_fake');
    expect(Date.parse(grant.credentials.expiresAt ?? '')).toBeGreaterThan(Date.now() + 3000_000);
    expect(grant.grantedScopes).toEqual(['https://www.googleapis.com/auth/analytics.readonly', 'openid']);
    expect(io.calls).toEqual([
      { method: 'POST', url: 'https://oauth2.googleapis.com/token', mutation: false },
    ]);
    expect(server.requests[0]?.body).toContain('client_secret=csecret');
    expect(server.remaining()).toEqual([]);
  });

  it('exchangeCode: a response without a refresh token is refused (offline access was not granted)', async () => {
    load('exchange_without_refresh_token');
    await expect(
      adapter.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://app.test/cb', client }, io),
    ).rejects.toMatchObject({ name: 'ProviderAuthError', code: 'exchange_failed' });
  });

  it('refresh: a new access token keeps the refresh token; invalid_grant means reconnect; invalid_client, 429 and 5xx are transient', async () => {
    load('refresh_ok');
    const ok = await adapter.refresh(creds, client, io);
    expect(ok).toMatchObject({
      ok: true,
      credentials: { accessToken: 'ya29_at_3_fake', refreshToken: '1//rt_1_fake' },
    });
    if (ok.ok) expect(Date.parse(ok.tokenExpiresAt ?? '')).toBeGreaterThan(Date.now());
    load('refresh_revoked');
    expect(await adapter.refresh(creds, client, io)).toEqual({ ok: false, reason: 'reconnect_required' });
    load('refresh_invalid_client'); // a 401 for the deployment's own secret: the grant is not gone
    expect(await adapter.refresh(creds, client, io)).toEqual({ ok: false, reason: 'transient' });
    load('refresh_throttled');
    expect(await adapter.refresh(creds, client, io)).toEqual({ ok: false, reason: 'transient' });
    load('refresh_outage');
    expect(await adapter.refresh(creds, client, io)).toEqual({ ok: false, reason: 'transient' });
    expect(await adapter.refresh({ accessToken: 'only' }, client, io)).toEqual({
      ok: false,
      reason: 'reconnect_required',
    });
  });

  it('refresh: a transport failure before send is transient, never a reconnect', async () => {
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(await adapter.refresh(creds, client, refused)).toEqual({ ok: false, reason: 'transient' });
  });

  it('listTargets: every property of every account over the pages, as `properties/<id>` with the account named', async () => {
    load('targets');
    const targets = await adapter.listTargets(creds, client, io);
    expect(targets).toEqual([
      { externalId: 'properties/424242', displayName: 'Acme · Acme web' },
      { externalId: 'properties/424243', displayName: 'Acme · Acme app' },
      { externalId: 'properties/555', displayName: 'Tar · Tar site' },
    ]);
    expect(io.calls.every((c) => !c.mutation && c.method === 'GET')).toBe(true);
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer ya29_at_1_fake');
    expect(server.remaining()).toEqual([]);
  });

  it('listTargets: no property is no_eligible_account; a refused listing is identity_failed', async () => {
    load('targets_none');
    await expect(adapter.listTargets(creds, client, io)).rejects.toMatchObject({
      name: 'ProviderAuthError',
      code: 'no_eligible_account',
    });
    load('targets_forbidden');
    const err = await adapter.listTargets(creds, client, io).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect((err as ProviderAuthError).code).toBe('identity_failed');
    expect((err as Error).message).not.toContain('ya29');
  });

  it('classifyError: 401 refresh, 403 reconnect, 429 rate limited whatever the phase (a read has no effect)', () => {
    expect(adapter.classifyError({ status: 401, phase: 'after_send' })).toEqual({ kind: 'refresh_token' });
    expect(adapter.classifyError({ status: 403, phase: 'after_send' })).toEqual({
      kind: 'reconnect_required',
    });
    expect(adapter.classifyError({ status: 429, phase: 'before_send' })).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
    });
    expect(adapter.classifyError({ status: 429, phase: 'after_send' })).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
    });
    expect(adapter.classifyError({ status: 404, phase: 'after_send' })).toEqual({
      kind: 'rejected',
      code: 'http_404',
    });
  });
});
