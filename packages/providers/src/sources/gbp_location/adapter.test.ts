import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../../testing';
import { ProviderAuthError } from '../../shared';
import { gbpLocationAdapter as adapter } from './adapter';

const fx = (name: string) => loadScenario(new URL('./fixtures/auth.json', import.meta.url), name);
const client = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' };
const creds: DecryptedCredentials = { accessToken: 'ya29_at_1_fake', refreshToken: '1//rt_1_fake' };

describe('Business Profile location source adapter (ledger R2-2, spec 14.5 / 14.6)', () => {
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

  it('is uncertified, opt-in and read-only: business.manage alone, no retention asked of the kind', () => {
    expect(adapter.capability.certifiedAt).toBeNull();
    expect(adapter.capability.optInSetting).toBe('OREMEDIA_ENABLE_GBP');
    expect(adapter.capability.requiredScopes).toEqual(['https://www.googleapis.com/auth/business.manage']);
    expect(adapter.capability.presentation?.console.href).toBe('https://business.google.com/');
  });

  it('authorizationUrl: Google code flow with offline access, consent, the business.manage scope and a PKCE S256 challenge', async () => {
    const { url } = await adapter.authorizationUrl({
      state: 'st_1',
      codeVerifier: 'v_1',
      redirectUri: 'https://app.test/connect/callback',
      client,
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/business.manage');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update('v_1').digest('base64url'));
    expect(url).not.toContain('csecret');
  });

  it('exchangeCode: the token response becomes a grant with refresh token and the granted scopes', async () => {
    load('exchange');
    const grant = await adapter.exchangeCode(
      { code: 'code_1', codeVerifier: 'v_1', redirectUri: 'https://app.test/connect/callback', client },
      io,
    );
    expect(grant.credentials).toMatchObject({ accessToken: 'ya29_at_1_fake', refreshToken: '1//rt_1_fake' });
    expect(grant.grantedScopes).toEqual(['https://www.googleapis.com/auth/business.manage', 'openid']);
    expect(io.calls).toEqual([
      { method: 'POST', url: 'https://oauth2.googleapis.com/token', mutation: false },
    ]);
    expect(server.remaining()).toEqual([]);
  });

  it('refresh: a new access token keeps the refresh token; invalid_grant means reconnect', async () => {
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

  it('listTargets: every location of every account over the pages, as `locations/<id>` with the account and address named', async () => {
    load('targets');
    const targets = await adapter.listTargets(creds, client, io);
    expect(targets).toEqual([
      { externalId: 'locations/777', displayName: 'Acme · Acme Harare (12 Samora Machel Ave, Harare)' },
      { externalId: 'locations/778', displayName: 'Acme · Acme Bulawayo' },
      { externalId: 'locations/779', displayName: 'Acme · Acme Mutare (Mutare)' },
    ]);
    expect(io.calls.every((c) => !c.mutation && c.method === 'GET')).toBe(true);
    expect(io.calls).toHaveLength(5); // two account pages, two location pages, one empty account
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer ya29_at_1_fake');
    expect(server.remaining()).toEqual([]);
  });

  it('listTargets: no location is no_eligible_account; a refused listing is identity_failed, naming the API access when that is what is missing', async () => {
    load('targets_none');
    await expect(adapter.listTargets(creds, client, io)).rejects.toMatchObject({
      name: 'ProviderAuthError',
      code: 'no_eligible_account',
    });
    load('targets_forbidden');
    const err = await adapter.listTargets(creds, client, io).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect((err as ProviderAuthError).code).toBe('identity_failed');
    expect((err as Error).message).not.toContain('access required');
    expect((err as Error).message).not.toContain('ya29');
    load('targets_access_required');
    const access = await adapter.listTargets(creds, client, io).catch((e: unknown) => e);
    expect((access as ProviderAuthError).code).toBe('identity_failed');
    expect((access as Error).message).toContain('Business Profile API access required');
  });

  it('classifyError: 401 refresh, a plain 403 reconnect, a service-disabled 403 access_required, 429 rate limited whatever the phase', () => {
    expect(adapter.classifyError({ status: 401, phase: 'after_send' })).toEqual({ kind: 'refresh_token' });
    expect(adapter.classifyError({ status: 403, phase: 'after_send', body: '{"error":{}}' })).toEqual({
      kind: 'reconnect_required',
    });
    expect(
      adapter.classifyError({
        status: 403,
        phase: 'after_send',
        body: '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"SERVICE_DISABLED"}]}}',
      }),
    ).toEqual({ kind: 'rejected', code: 'access_required' });
    expect(
      adapter.classifyError({
        status: 403,
        phase: 'after_send',
        body: '{"error":{"status":"PERMISSION_DENIED","errors":[{"reason":"accessNotConfigured"}]}}',
      }),
    ).toEqual({ kind: 'rejected', code: 'access_required' });
    // Prose in the message, a reason outside the set, or a non-JSON body: a reconnect, never access required.
    expect(
      adapter.classifyError({
        status: 403,
        phase: 'after_send',
        body: '{"error":{"status":"PERMISSION_DENIED","message":"SERVICE_DISABLED: request access"}}',
      }),
    ).toEqual({ kind: 'reconnect_required' });
    expect(adapter.classifyError({ status: 403, phase: 'after_send', body: 'SERVICE_DISABLED' })).toEqual({
      kind: 'reconnect_required',
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
