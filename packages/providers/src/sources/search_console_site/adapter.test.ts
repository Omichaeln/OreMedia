import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../../testing';
import { searchConsoleSiteAdapter as adapter } from './adapter';

const fx = (name: string) => loadScenario(new URL('./fixtures/auth.json', import.meta.url), name);
const client = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' };
const creds: DecryptedCredentials = { accessToken: 'ya29_at_1_fake', refreshToken: '1//rt_1_fake' };

describe('Search Console site source adapter (ledger R2-1, spec 14.5 / 14.6)', () => {
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

  it('authorizationUrl: offline access with consent and the webmasters.readonly scope', async () => {
    const { url } = await adapter.authorizationUrl({
      state: 'st_1',
      codeVerifier: 'v_1',
      redirectUri: 'https://app.test/connect/callback',
      client,
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/webmasters.readonly');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('state')).toBe('st_1');
    expect(u.searchParams.has('code_challenge')).toBe(true);
  });

  it('exchangeCode and refresh go through Google’s token endpoint with the PKCE verifier', async () => {
    load('exchange');
    const grant = await adapter.exchangeCode(
      { code: 'code_1', codeVerifier: 'v_1', redirectUri: 'https://app.test/connect/callback', client },
      io,
    );
    expect(grant.credentials.refreshToken).toBe('1//rt_1_fake');
    expect(grant.grantedScopes).toEqual(['https://www.googleapis.com/auth/webmasters.readonly']);
    load('refresh_ok');
    expect(await adapter.refresh(creds, client, io)).toMatchObject({
      ok: true,
      credentials: { accessToken: 'ya29_at_3_fake', refreshToken: '1//rt_1_fake' },
    });
    load('refresh_revoked');
    expect(await adapter.refresh(creds, client, io)).toEqual({ ok: false, reason: 'reconnect_required' });
  });

  it('revokeAccess (RA-01): the refresh token at Google’s revoke endpoint; invalid_token means already revoked; an outage is failed', async () => {
    load('revoke_ok');
    expect(await adapter.revokeAccess(creds, client, io)).toEqual({ outcome: 'revoked' });
    expect(io.calls.map((c) => c.mutation)).toEqual([true]);
    load('revoke_already_gone');
    expect(await adapter.revokeAccess(creds, client, io)).toEqual({ outcome: 'revoked' });
    load('revoke_refused');
    expect(await adapter.revokeAccess(creds, client, io)).toMatchObject({
      outcome: 'failed',
      reason: expect.stringMatching(/^http_503/),
    });
  });

  it('listTargets: the verified sites by their Search Console URL; an unverified entry is left out', async () => {
    load('targets');
    expect(await adapter.listTargets(creds, client, io)).toEqual([
      { externalId: 'https://acme.example/', displayName: 'https://acme.example/' },
      { externalId: 'sc-domain:tar.example', displayName: 'sc-domain:tar.example' },
    ]);
    expect(io.calls).toEqual([
      { method: 'GET', url: 'https://www.googleapis.com/webmasters/v3/sites', mutation: false },
    ]);
  });

  it('listTargets: 401 and 429 answers fail the listing without leaking the token; classifyError names them', async () => {
    load('targets_unauthorised');
    const unauthorised: unknown = await adapter.listTargets(creds, client, io).catch((e: unknown) => e);
    expect(unauthorised).toMatchObject({ name: 'ProviderAuthError', code: 'identity_failed' });
    expect((unauthorised as Error).message).not.toContain('ya29');
    load('targets_throttled');
    await expect(adapter.listTargets(creds, client, io)).rejects.toMatchObject({ code: 'identity_failed' });
    expect(adapter.classifyError({ status: 401, phase: 'after_send' })).toEqual({ kind: 'refresh_token' });
    expect(adapter.classifyError({ status: 403, phase: 'after_send' })).toEqual({
      kind: 'reconnect_required',
    });
    expect(adapter.classifyError({ status: 429, phase: 'before_send' })).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
    });
  });
});
