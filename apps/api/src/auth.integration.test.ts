import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  authEvents,
  externalIdentities,
  memberships,
  sessions,
  supportSessions,
  users,
} from '@oremedia/db/schema/access';
import { auditEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runAsPlatform } from '@oremedia/db';
import { accessService, hashToken, SESSION_IDLE_MS, UserDirectory } from '@oremedia/module-access';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import {
  CookieJar,
  FakeOidcProvider,
  callPath,
  type FakeIdentity,
  runGoogleSignIn,
  seedTwoTenants,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src';
import type { AuthConfig } from './auth/config';
import { createServer } from './server';
import { configureRateLimiter } from './trpc';

/**
 * D-03 Google sign-in through the real Express app against MySQL, with a local OIDC provider (no network): the
 * authorization code flow with PKCE, state and nonce; ID token validation; identity resolution (linked subject,
 * existing user by verified email, invitation, refusal); session cookies; sign-out; and the audit of every outcome.
 */
describe('Google sign-in (D-03): OIDC flow, identity linking, sessions', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let provider: FakeOidcProvider;
  const servers: Server[] = [];
  let api = '';

  /** Starts the API with auth pointed at the fake provider; the redirect URI is the API's own callback. */
  const startApi = async (overrides: Partial<AuthConfig> = {}): Promise<string> => {
    const http = createHttpServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const app = createServer({
      auth: {
        issuerUrl: new URL(provider.issuer),
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        redirectUri: new URL(`${origin}/auth/google/callback`),
        allowedDomains: null,
        secureCookies: false,
        allowInsecureIssuer: true,
        ...overrides,
      },
    });
    http.on('request', app);
    servers.push(http);
    return origin;
  };

  const count = async (
    table: typeof users | typeof memberships | typeof externalIdentities | typeof sessions,
  ) => (await tdb.db.select().from(table)).length;
  const lastAuthEvent = async () => {
    const rows = await tdb.db.select().from(authEvents);
    return rows.sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1);
  };
  const identitiesOf = (userId: string) =>
    tdb.db.select().from(externalIdentities).where(eq(externalIdentities.userId, userId));
  const trpcGet = async (origin: string, path: string, jar: CookieJar | string, tenantId?: string) => {
    const res = await fetch(`${origin}/trpc/${path}`, {
      headers: {
        cookie: typeof jar === 'string' ? jar : jar.header(),
        ...(tenantId ? { 'x-oremedia-tenant': tenantId } : {}),
      },
    });
    return { status: res.status, body: (await res.json()) as { result?: { data?: { json?: unknown } } } };
  };
  const signOut = (origin: string, cookie: string, csrf?: string) =>
    fetch(`${origin}/auth/sign-out`, {
      method: 'POST',
      headers: { cookie, ...(csrf ? { 'x-oremedia-csrf': csrf } : {}) },
    });
  /**
   * The person the fake Google signs in next. By default a Workspace account: `hd` is the email's domain, so Google
   * is authoritative for the address (M1). Pass `hd: undefined` for a consumer account.
   */
  const signInAs = (id: FakeIdentity) =>
    provider.reset({ hd: id.email?.slice(id.email.lastIndexOf('@') + 1), ...id });
  const person = (label: string) => ({
    sub: `google-${label}-${randomUUID()}`,
    email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
    email_verified: true,
    name: `Person ${label}`,
  });
  /** A refused sign-in lands on the sign-in page with the coarse code and leaves one denied auth event. */
  const expectRefused = async (
    run: { status: number; location: string },
    code: string,
    reason: string,
  ): Promise<void> => {
    expect(run.status).toBe(303);
    expect(run.location).toBe(`/sign-in?error=${code}`);
    expect(await lastAuthEvent()).toMatchObject({
      action: 'auth.sign_in',
      decision: 'denied',
      reason,
      sessionId: null,
    });
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA } = await seedTwoTenants(tdb.db));
    provider = await FakeOidcProvider.start();
    api = await startApi();
  });
  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await provider?.close();
    await tdb?.drop();
  });
  beforeEach(() => {
    signInAs(person('default'));
    configureRateLimiter(); // a fresh in-memory window per test: /auth is limited per client address
  });

  it('happy path: bootstrap owner → start → provider → callback → session cookie → tRPC as that user → sign-out → the cookie is refused', async () => {
    const email = `owner-${randomUUID().slice(0, 8)}@acme.test`;
    const boot = await accessService.bootstrapOwner(
      { email, name: 'Acme Owner', tenant: { name: 'Acme', slug: `acme-${randomUUID().slice(0, 8)}` } },
      `test-${randomUUID()}`,
    );
    // Google may report the address with different case; comparison is case-insensitive.
    signInAs({ sub: `google-owner-${randomUUID()}`, email: email.toUpperCase(), email_verified: true });
    const jar = new CookieJar();
    jar.cookies.set('oremedia_session', 'ses_planted_by_attacker');
    jar.cookies.set('oremedia_csrf', 'planted-csrf');
    const run = await runGoogleSignIn(api, jar, { returnTo: `/c/${boot.tenantId}/home?tab=1` });

    // The authorization request: code flow, PKCE S256, state, nonce, the three scopes, account chooser.
    const q = run.authorizationUrl.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toBeTruthy();
    expect(q.get('nonce')).toBeTruthy();
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('prompt')).toBe('select_account');
    expect(q.get('redirect_uri')).toBe(`${api}/auth/google/callback`);
    // The token request carried the PKCE verifier.
    expect(provider.tokenRequests.at(-1)?.get('code_verifier')).toBeTruthy();

    expect(run.status).toBe(303);
    expect(run.location).toBe(`/c/${boot.tenantId}/home?tab=1`);
    const sessionCookie = run.callbackSetCookies.find((c) => c.startsWith('oremedia_session='));
    const csrfCookie = run.callbackSetCookies.find((c) => c.startsWith('oremedia_csrf='));
    expect(sessionCookie).toMatch(/HttpOnly/);
    expect(sessionCookie).toMatch(/SameSite=Lax/);
    expect(sessionCookie).toMatch(/Path=\//);
    expect(sessionCookie).not.toMatch(/Secure/); // secureCookies: false here; the production case is below
    expect(csrfCookie).not.toMatch(/HttpOnly/); // the app reads it for the double-submit header
    expect(csrfCookie).toMatch(/SameSite=Lax/);
    // The single-use flow cookie is cleared by the callback.
    expect(run.callbackSetCookies.some((c) => /^oremedia_oidc=;/.test(c))).toBe(true);
    // Rotation: nothing planted before sign-in is reused.
    const token = jar.cookies.get('oremedia_session') as string;
    const csrf = jar.cookies.get('oremedia_csrf') as string;
    expect(token).toMatch(/^ses_/);
    expect(token).not.toBe('ses_planted_by_attacker');
    expect(csrf).not.toBe('planted-csrf');
    // The session row stores the hash, never the token.
    const row = (
      await tdb.db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, hashToken(token)))
    )[0];
    expect(row).toMatchObject({ userId: boot.userId, revokedAt: null });
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);

    // The identity is linked to the bootstrapped owner; MFA is not claimed.
    expect(await identitiesOf(boot.userId)).toHaveLength(1);
    const owner = (await tdb.db.select().from(users).where(eq(users.id, boot.userId)))[0];
    expect(owner).toMatchObject({ status: 'active', mfaEnrolled: false });

    // A tRPC call as that user succeeds with the cookie alone.
    const companies = await trpcGet(api, 'access.listCompanies', jar);
    expect(companies.status).toBe(200);
    expect(companies.body.result?.data?.json).toEqual([
      expect.objectContaining({ tenantId: boot.tenantId, role: 'owner' }),
    ]);
    expect((await trpcGet(api, 'brand.list', jar, boot.tenantId)).status).toBe(200);
    // The app header's signed-in person is the session's own user.
    expect((await trpcGet(api, 'access.session', jar)).body.result?.data?.json).toEqual({
      userId: boot.userId,
      name: 'Acme Owner',
      email,
    });

    // Sign-out is CSRF-protected: without the header (or with a wrong one) nothing is revoked.
    expect((await signOut(api, jar.header())).status).toBe(403);
    expect((await signOut(api, jar.header(), 'wrong-value')).status).toBe(403);
    expect((await trpcGet(api, 'access.listCompanies', jar)).status).toBe(200);
    const cookieBefore = jar.header();
    const out = await signOut(api, cookieBefore, csrf);
    expect(out.status).toBe(204);
    const cleared = out.headers.getSetCookie();
    expect(cleared.some((c) => /^oremedia_session=;/.test(c))).toBe(true);
    expect(cleared.some((c) => /^oremedia_csrf=;/.test(c))).toBe(true);
    // The same cookie is refused afterwards.
    expect((await trpcGet(api, 'access.listCompanies', cookieBefore)).status).toBe(401);

    const events = await tdb.db.select().from(authEvents).where(eq(authEvents.userId, boot.userId));
    expect(events.map((e) => `${e.action}:${e.decision}`).sort()).toEqual([
      'auth.identity_link:allowed',
      'auth.sign_in:allowed',
      'auth.sign_out:allowed',
    ]);
    // No PII in the auth trail: ids, reasons and salted hashes only.
    expect(JSON.stringify(events)).not.toContain(email);
    expect(events.find((e) => e.action === 'auth.sign_in')?.userAgentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('bootstrapOwner refuses an existing company slug and a disabled user', async () => {
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    const email = `dup-${randomUUID().slice(0, 8)}@example.test`;
    await accessService.bootstrapOwner({ email, name: 'Dup', tenant: { name: 'Dup', slug } }, 'test-dup');
    await expect(
      accessService.bootstrapOwner({ email, name: 'Dup', tenant: { name: 'Dup 2', slug } }, 'test-dup'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await tdb.db.update(users).set({ status: 'disabled' }).where(eq(users.email, email));
    await expect(
      accessService.bootstrapOwner(
        { email, name: 'Dup', tenant: { name: 'Dup 3', slug: `${slug}-3` } },
        'test-dup',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('an existing user is linked once by verified email, then found by subject; re-signing in rotates the session', async () => {
    const creator = (
      await tdb.db.select().from(users).where(eq(users.id, tenantA.creatorUserId))
    )[0] as typeof users.$inferSelect;
    const sub = `google-creator-${randomUUID()}`;
    signInAs({ sub, email: creator.email, email_verified: true });
    const jar = new CookieJar();
    const first = await runGoogleSignIn(api, jar);
    expect(first.location).toBe('/portfolio');
    expect(await identitiesOf(creator.id)).toEqual([
      expect.objectContaining({ provider: 'google', subject: sub, emailAtLink: creator.email }),
    ]);
    const firstToken = jar.cookies.get('oremedia_session') as string;

    // Found by subject: the email in the token no longer matches any user, and nothing new is linked.
    signInAs({ sub, email: `renamed-${randomUUID().slice(0, 6)}@example.test`, email_verified: true });
    const second = await runGoogleSignIn(api, jar);
    expect(second.location).toBe('/portfolio');
    expect(await identitiesOf(creator.id)).toHaveLength(1);
    const secondToken = jar.cookies.get('oremedia_session') as string;
    expect(secondToken).not.toBe(firstToken);
    // The session the browser held before is ended by the new sign-in.
    expect((await trpcGet(api, 'access.listCompanies', `oremedia_session=${firstToken}`)).status).toBe(401);
    expect((await trpcGet(api, 'access.listCompanies', `oremedia_session=${secondToken}`)).status).toBe(200);
  });

  it('a user linked to one Google subject is not re-linked to another subject by email (reassigned address)', async () => {
    const owner = (
      await tdb.db.select().from(users).where(eq(users.id, tenantA.ownerUserId))
    )[0] as typeof users.$inferSelect;
    signInAs({ sub: `google-first-${randomUUID()}`, email: owner.email, email_verified: true });
    expect((await runGoogleSignIn(api, new CookieJar())).location).toBe('/portfolio');
    signInAs({ sub: `google-second-${randomUUID()}`, email: owner.email, email_verified: true });
    const sessionsBefore = await count(sessions);
    await expectRefused(await runGoogleSignIn(api, new CookieJar()), 'sign_in_failed', 'identity_conflict');
    expect(await identitiesOf(owner.id)).toHaveLength(1);
    expect(await count(sessions)).toBe(sessionsBefore);
  });

  it('an unknown email without an invitation is refused as not invited, and nothing is written', async () => {
    const before = await Promise.all([users, memberships, externalIdentities, sessions].map(count));
    const auditBefore = (await tdb.db.select().from(auditEvents)).length;
    const jar = new CookieJar();
    const run = await runGoogleSignIn(api, jar);
    await expectRefused(run, 'not_invited', 'not_invited');
    expect(await Promise.all([users, memberships, externalIdentities, sessions].map(count))).toEqual(before);
    expect((await tdb.db.select().from(auditEvents)).length).toBe(auditBefore);
    expect(jar.cookies.has('oremedia_session')).toBe(false);
  });

  it('an invitation is accepted: the placeholder user is activated, the identity linked and the membership activated (audited in the tenant)', async () => {
    const email = `invitee-${randomUUID().slice(0, 8)}@example.test`;
    const invite = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'access.members.invite',
      { email, role: 'creator', allBrands: true },
    );
    expect(invite.error).toBeUndefined();
    const { membershipId } = invite.data as { membershipId: string };
    const placeholder = (await tdb.db.select().from(users).where(eq(users.email, email)))[0];
    expect(placeholder).toMatchObject({ status: 'disabled' });

    signInAs({
      sub: `google-invitee-${randomUUID()}`,
      email,
      email_verified: true,
      name: 'New Person',
    });
    const jar = new CookieJar();
    const run = await runGoogleSignIn(api, jar, { returnTo: '/portfolio' });
    expect(run.location).toBe('/portfolio');
    const user = (await tdb.db.select().from(users).where(eq(users.email, email)))[0];
    expect(user).toMatchObject({
      id: placeholder?.id,
      status: 'active',
      name: 'New Person',
      mfaEnrolled: false,
    });
    expect(await identitiesOf(user?.id as string)).toHaveLength(1);
    const m = (await tdb.db.select().from(memberships).where(eq(memberships.id, membershipId)))[0];
    expect(m).toMatchObject({ status: 'active', version: 1 });
    const accepted = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA.tenantId), eq(auditEvents.resourceId, membershipId)));
    expect(accepted.map((a) => a.action)).toContain('membership.accept');
    // The new member now reaches the inviting company through the policy layer.
    expect((await trpcGet(api, 'brand.list', jar, tenantA.tenantId)).status).toBe(200);
  });

  it('a disabled user is refused, whether found by email or by linked subject', async () => {
    const disabledId = `usr_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
    const email = `disabled-${randomUUID().slice(0, 8)}@example.test`;
    await tdb.db.insert(users).values({ id: disabledId, email, name: 'Disabled', status: 'disabled' });
    await tdb.db.insert(memberships).values({
      id: `mem_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`,
      tenantId: tenantA.tenantId,
      userId: disabledId,
      role: 'creator',
      status: 'active',
    });
    signInAs({ sub: `google-disabled-${randomUUID()}`, email, email_verified: true });
    await expectRefused(await runGoogleSignIn(api, new CookieJar()), 'account_disabled', 'account_disabled');
    expect(await identitiesOf(disabledId)).toHaveLength(0);

    // Linked, then disabled: refused by subject.
    const linked = person('linked');
    const boot = await accessService.bootstrapOwner(
      {
        email: linked.email,
        name: 'x',
        tenant: { name: 'Linked', slug: `linked-${randomUUID().slice(0, 8)}` },
      },
      `test-${randomUUID()}`,
    );
    signInAs(linked);
    expect((await runGoogleSignIn(api, new CookieJar())).location).toBe('/portfolio');
    await tdb.db.update(users).set({ status: 'disabled' }).where(eq(users.id, boot.userId));
    await expectRefused(await runGoogleSignIn(api, new CookieJar()), 'account_disabled', 'account_disabled');
  });

  it('anonymising a user (spec 17.5) removes their Google link, so the person cannot sign in to that user again', async () => {
    const p = person('anonymised');
    const userId = `usr_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
    await tdb.db.insert(users).values({ id: userId, email: p.email, name: 'To be anonymised' });
    signInAs(p);
    expect((await runGoogleSignIn(api, new CookieJar())).location).toBe('/portfolio');
    expect(await identitiesOf(userId)).toHaveLength(1);
    expect(
      await runAsPlatform('test-anonymise', 'test', () =>
        new UserDirectory().anonymiseIfUnaffiliated(userId),
      ),
    ).toBe(true);
    expect(await identitiesOf(userId)).toHaveLength(0);
    await expectRefused(await runGoogleSignIn(api, new CookieJar()), 'not_invited', 'not_invited');
  });

  it('email_verified=false (or no email) is refused', async () => {
    const owner = (await tdb.db.select().from(users).where(eq(users.id, tenantA.ownerUserId)))[0];
    signInAs({ sub: `google-unverified-${randomUUID()}`, email: owner?.email, email_verified: false });
    await expectRefused(
      await runGoogleSignIn(api, new CookieJar()),
      'email_not_verified',
      'email_not_verified',
    );
    signInAs({ sub: `google-noemail-${randomUUID()}` });
    await expectRefused(
      await runGoogleSignIn(api, new CookieJar()),
      'email_not_verified',
      'email_not_verified',
    );
  });

  it('tampered, missing or foreign state is refused before any token exchange', async () => {
    const tokenCalls = provider.tokenRequests.length;
    await expectRefused(
      await runGoogleSignIn(api, new CookieJar(), {
        mutateCallback: (u) => u.searchParams.set('state', 'forged'),
      }),
      'sign_in_failed',
      'flow_invalid',
    );
    await expectRefused(
      await runGoogleSignIn(api, new CookieJar(), { mutateCallback: (u) => u.searchParams.delete('state') }),
      'sign_in_failed',
      'flow_invalid',
    );
    await expectRefused(
      await runGoogleSignIn(api, new CookieJar(), { dropFlowCookie: true }),
      'sign_in_failed',
      'flow_invalid',
    );
    // A flow cookie that was altered (one byte flipped) does not open.
    const jar = new CookieJar();
    await expectRefused(
      await runGoogleSignIn(api, jar, {
        mutateCallback: () => {
          const sealed = jar.cookies.get('oremedia_oidc') as string;
          const flipped = sealed.slice(0, 20) + (sealed[20] === 'A' ? 'B' : 'A') + sealed.slice(21);
          jar.cookies.set('oremedia_oidc', flipped);
        },
      }),
      'sign_in_failed',
      'flow_invalid',
    );
    // Another browser's flow cookie with this browser's callback: state does not match.
    const other = new CookieJar();
    await fetch(`${api}/auth/google/start`, { redirect: 'manual' }).then((r) => other.store(r));
    const victim = new CookieJar();
    await expectRefused(
      await runGoogleSignIn(api, victim, {
        mutateCallback: () =>
          victim.cookies.set('oremedia_oidc', other.cookies.get('oremedia_oidc') as string),
      }),
      'sign_in_failed',
      'flow_invalid',
    );
    expect(provider.tokenRequests.length).toBe(tokenCalls);
  });

  it('a provider error (the person cancelled) is refused', async () => {
    provider.denyWith = 'access_denied';
    await expectRefused(await runGoogleSignIn(api, new CookieJar()), 'sign_in_failed', 'provider_error');
  });

  it.each([
    ['nonce mismatch', { nonce: 'another-flows-nonce' }],
    ['nonce missing', { dropNonce: true }],
    ['wrong audience', { aud: 'another-client' }],
    ['wrong issuer', { iss: 'https://accounts.evil.example' }],
    ['expired', { expIn: -600 }],
    ['signature by a key outside the JWKS', { foreignKey: true }],
  ])('an ID token with %s is refused', async (_label, tamper) => {
    const owner = (await tdb.db.select().from(users).where(eq(users.id, tenantA.ownerUserId)))[0];
    signInAs({ sub: `google-tamper-${randomUUID()}`, email: owner?.email, email_verified: true });
    provider.tamper = tamper;
    const sessionsBefore = await count(sessions);
    await expectRefused(await runGoogleSignIn(api, new CookieJar()), 'sign_in_failed', 'token_invalid');
    expect(await count(sessions)).toBe(sessionsBefore);
  });

  it('AUTH_ALLOWED_DOMAINS: only the listed Workspace domains (hd claim) sign in; production cookies are Secure', async () => {
    const restricted = await startApi({ allowedDomains: ['acme.test'], secureCookies: true });
    const email = `staff-${randomUUID().slice(0, 8)}@acme.test`;
    await accessService.bootstrapOwner(
      { email, name: 'Staff', tenant: { name: 'Acme staff', slug: `staff-${randomUUID().slice(0, 8)}` } },
      `test-${randomUUID()}`,
    );
    signInAs({ sub: `google-staff-${randomUUID()}`, email, email_verified: true, hd: 'other.test' });
    await expectRefused(
      await runGoogleSignIn(restricted, new CookieJar()),
      'domain_not_allowed',
      'domain_not_allowed',
    );
    signInAs({ sub: `google-staff-${randomUUID()}`, email, email_verified: true, hd: undefined }); // consumer: no hd
    await expectRefused(
      await runGoogleSignIn(restricted, new CookieJar()),
      'domain_not_allowed',
      'domain_not_allowed',
    );
    signInAs({ sub: `google-staff-${randomUUID()}`, email, email_verified: true, hd: 'ACME.test' });
    const jar = new CookieJar();
    const ok = await runGoogleSignIn(restricted, jar);
    expect(ok.location).toBe('/portfolio');
    // One allowed domain is also passed to Google as the account-chooser hint.
    expect(ok.authorizationUrl.searchParams.get('hd')).toBe('acme.test');
    // n1: Secure cookies carry the __Host- prefix (Secure, Path=/, no Domain), so no sibling subdomain can set them.
    for (const name of ['__Host-oremedia_session', '__Host-oremedia_csrf']) {
      const cookie = ok.callbackSetCookies.find((c) => c.startsWith(`${name}=`));
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/; Path=\/(;|$)/);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    expect(ok.callbackSetCookies.some((c) => c.startsWith('oremedia_session='))).toBe(false);
    // The API reads the prefixed session (the tRPC call as that user succeeds).
    expect((await trpcGet(restricted, 'access.listCompanies', jar)).status).toBe(200);
    // In production an unprefixed cookie (which a sibling subdomain could plant) is not read at all.
    const token = jar.cookies.get('__Host-oremedia_session') as string;
    const env = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect((await trpcGet(restricted, 'access.listCompanies', `oremedia_session=${token}`)).status).toBe(
        401,
      );
      expect(
        (await trpcGet(restricted, 'access.listCompanies', `__Host-oremedia_session=${token}`)).status,
      ).toBe(200);
    } finally {
      process.env['NODE_ENV'] = env;
    }
  });

  it.each([
    ['https://evil.example/steal'],
    ['//evil.example/steal'],
    ['/\\evil.example/steal'],
    ['\\\\evil.example'],
    ['/%0d%0aSet-Cookie:x=y'.replace('%0d%0a', '\r\n')],
    ['javascript:alert(1)'],
    ['/auth/google/start'],
  ])('returnTo %j cannot redirect off-site (defaults to /portfolio)', async (returnTo) => {
    const owner = (await tdb.db.select().from(users).where(eq(users.id, tenantA.ownerUserId)))[0];
    const linked = await tdb.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, tenantA.ownerUserId));
    signInAs({
      sub: linked[0]?.subject ?? `google-rt-${randomUUID()}`,
      email: owner?.email,
      email_verified: true,
    });
    const run = await runGoogleSignIn(api, new CookieJar(), { returnTo });
    expect(run.status).toBe(303);
    expect(run.location).toBe('/portfolio');
  });

  it('a session idle for longer than the idle window is refused', async () => {
    const jar = new CookieJar();
    const owner = (await tdb.db.select().from(users).where(eq(users.id, tenantA.ownerUserId)))[0];
    const linked = await tdb.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, tenantA.ownerUserId));
    signInAs({ sub: linked[0]?.subject as string, email: owner?.email, email_verified: true });
    await runGoogleSignIn(api, jar);
    const token = jar.cookies.get('oremedia_session') as string;
    expect((await trpcGet(api, 'access.listCompanies', jar)).status).toBe(200);
    await tdb.db
      .update(sessions)
      .set({ lastSeenAt: new Date(Date.now() - SESSION_IDLE_MS - 60_000) })
      .where(eq(sessions.tokenHash, hashToken(token)));
    expect((await trpcGet(api, 'access.listCompanies', jar)).status).toBe(401);
  });

  it('without configuration the routes answer "unavailable" and sign-out still clears cookies', async () => {
    const http = createHttpServer(createServer({ auth: null }));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    servers.push(http);
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const start = await fetch(`${origin}/auth/google/start`, { redirect: 'manual' });
    expect(start.headers.get('location')).toBe('/sign-in?error=unavailable');
    const out = await fetch(`${origin}/auth/sign-out`, { method: 'POST' });
    expect(out.status).toBe(204);
  });

  // ---- Review findings (M1, M2, m3, m5, n2, n3) ----------------------------------------------------------------

  const newUserId = () => `usr_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
  const eventsSince = async (since: number) => (await tdb.db.select().from(authEvents)).length - since;

  it('M1: a consumer Google account on a company address (no hd) cannot link to the existing user of that email', async () => {
    const userId = newUserId();
    const email = `staff-${randomUUID().slice(0, 8)}@corp.test`;
    await tdb.db.insert(users).values({ id: userId, email, name: 'Staff' });
    await tdb.db.insert(memberships).values({
      id: `mem_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`,
      tenantId: tenantA.tenantId,
      userId,
      role: 'creator',
      status: 'active',
    });
    provider.reset({ sub: `google-consumer-${randomUUID()}`, email, email_verified: true }); // no hd
    await expectRefused(
      await runGoogleSignIn(api, new CookieJar()),
      'email_not_authoritative',
      'email_not_authoritative',
    );
    // An hd for another domain is not authority for this address either.
    provider.reset({ sub: `google-other-${randomUUID()}`, email, email_verified: true, hd: 'other.test' });
    await expectRefused(
      await runGoogleSignIn(api, new CookieJar()),
      'email_not_authoritative',
      'email_not_authoritative',
    );
    expect(await identitiesOf(userId)).toHaveLength(0);
    // The Workspace account for that domain links.
    signInAs({ sub: `google-workspace-${randomUUID()}`, email, email_verified: true });
    expect((await runGoogleSignIn(api, new CookieJar())).location).toBe('/portfolio');
    expect(await identitiesOf(userId)).toHaveLength(1);
  });

  it('M1: an invitation is not accepted by a consumer account on the invited company address', async () => {
    const email = `invited-${randomUUID().slice(0, 8)}@corp.test`;
    const invite = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'access.members.invite',
      { email, role: 'creator', allBrands: false },
    );
    const { membershipId } = invite.data as { membershipId: string };
    provider.reset({ sub: `google-consumer-${randomUUID()}`, email, email_verified: true });
    await expectRefused(
      await runGoogleSignIn(api, new CookieJar()),
      'email_not_authoritative',
      'email_not_authoritative',
    );
    const placeholder = (await tdb.db.select().from(users).where(eq(users.email, email)))[0];
    expect(placeholder?.status).toBe('disabled');
    expect((await tdb.db.select().from(memberships).where(eq(memberships.id, membershipId)))[0]?.status).toBe(
      'invited',
    );
    expect(await identitiesOf(placeholder?.id as string)).toHaveLength(0);
  });

  it('M1: the bootstrap owner links only from an authoritative account; Gmail addresses are Google-issued', async () => {
    const corp = `founder-${randomUUID().slice(0, 8)}@corp.test`;
    const corpBoot = await accessService.bootstrapOwner(
      { email: corp, name: 'Founder', tenant: { name: 'Corp', slug: `corp-${randomUUID().slice(0, 8)}` } },
      'test-m1',
    );
    provider.reset({ sub: `google-consumer-${randomUUID()}`, email: corp, email_verified: true });
    await expectRefused(
      await runGoogleSignIn(api, new CookieJar()),
      'email_not_authoritative',
      'email_not_authoritative',
    );
    expect(await identitiesOf(corpBoot.userId)).toHaveLength(0);

    for (const domain of ['gmail.com', 'googlemail.com']) {
      const gmail = `founder.${randomUUID().slice(0, 8)}@${domain}`;
      const gmailBoot = await accessService.bootstrapOwner(
        {
          email: gmail,
          name: 'Founder',
          tenant: { name: 'Gmail co', slug: `gm-${randomUUID().slice(0, 8)}` },
        },
        'test-m1',
      );
      provider.reset({ sub: `google-gmail-${randomUUID()}`, email: gmail, email_verified: true }); // no hd
      expect((await runGoogleSignIn(api, new CookieJar())).location).toBe('/portfolio');
      expect(await identitiesOf(gmailBoot.userId)).toHaveLength(1);
    }
  });

  it('collation: an address that differs only by accent is not the same person (utf8mb4_0900_ai_ci)', async () => {
    const userId = newUserId();
    const local = `josé-${randomUUID().slice(0, 6)}`;
    await tdb.db.insert(users).values({ id: userId, email: `${local}@corp.test`, name: 'José' });
    signInAs({
      sub: `google-accent-${randomUUID()}`,
      email: `${local.replace('é', 'e')}@corp.test`,
      email_verified: true,
    });
    await expectRefused(await runGoogleSignIn(api, new CookieJar()), 'not_invited', 'not_invited');
    expect(await identitiesOf(userId)).toHaveLength(0);
  });

  it('M2: two first sign-ins with different subjects for one user race; exactly one links, the other is identity_conflict', async () => {
    // The loser is refused by the locking read after the lock, before any insert: one link attempt per round.
    const links = vi.spyOn(UserDirectory.prototype, 'linkIdentity');
    for (let round = 0; round < 5; round++) {
      const userId = newUserId();
      const email = `race-${randomUUID().slice(0, 8)}@corp.test`;
      await tdb.db.insert(users).values({ id: userId, email, name: 'Race' });
      const attempt = (sub: string) =>
        accessService.signInWithExternalIdentity(
          { provider: 'google', subject: sub, email, emailVerified: true, hostedDomain: 'corp.test' },
          { allowedDomains: null },
          { correlationId: `race-${round}`, ipHash: null, userAgentHash: null },
        );
      // Two connections (the pool holds four), started together.
      const results = await Promise.all([
        attempt(`google-a-${randomUUID()}`),
        attempt(`google-b-${randomUUID()}`),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'identity_conflict' }]);
      expect(await identitiesOf(userId)).toHaveLength(1);
      expect((await tdb.db.select().from(sessions).where(eq(sessions.userId, userId))).length).toBe(1);
    }
    expect(links).toHaveBeenCalledTimes(5);
    links.mockRestore();
  });

  it('M2: a duplicate key on link (a race the pre-check missed) is identity_conflict and rolls the attempt back', async () => {
    const email = `dup-link-${randomUUID().slice(0, 8)}@corp.test`;
    const invite = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'access.members.invite',
      { email, role: 'creator', allBrands: false },
    );
    const { membershipId } = invite.data as { membershipId: string };
    const placeholder = (await tdb.db.select().from(users).where(eq(users.email, email)))[0] as {
      id: string;
    };
    // Another subject is already linked (e.g. committed by a concurrent sign-in), but the pre-check misses it.
    await tdb.db.insert(externalIdentities).values({
      id: `xid_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`,
      provider: 'google',
      subject: `google-first-${randomUUID()}`,
      userId: placeholder.id,
      emailAtLink: email,
    });
    const spy = vi.spyOn(UserDirectory.prototype, 'identityOfUser').mockResolvedValueOnce(null);
    try {
      const result = await accessService.signInWithExternalIdentity(
        {
          provider: 'google',
          subject: `google-second-${randomUUID()}`,
          email,
          emailVerified: true,
          hostedDomain: 'corp.test',
        },
        { allowedDomains: null },
        { correlationId: 'dup-link', ipHash: null, userAgentHash: null },
      );
      expect(result).toEqual({ ok: false, reason: 'identity_conflict' });
    } finally {
      spy.mockRestore();
    }
    // Nothing of the attempt survived: the placeholder is still disabled and the invitation still pending.
    expect((await tdb.db.select().from(users).where(eq(users.id, placeholder.id)))[0]?.status).toBe(
      'disabled',
    );
    expect((await tdb.db.select().from(memberships).where(eq(memberships.id, membershipId)))[0]?.status).toBe(
      'invited',
    );
    expect(await identitiesOf(placeholder.id)).toHaveLength(1);
  });

  it('M2: the schema itself refuses a second identity at one provider for one user', async () => {
    const userId = newUserId();
    await tdb.db.insert(users).values({ id: userId, email: `${userId.toLowerCase()}@corp.test`, name: 'x' });
    const row = (subject: string) => ({
      id: `xid_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`,
      provider: 'google',
      subject,
      userId,
      emailAtLink: 'x@corp.test',
    });
    await tdb.db.insert(externalIdentities).values(row(`s1-${randomUUID()}`));
    await expect(tdb.db.insert(externalIdentities).values(row(`s2-${randomUUID()}`))).rejects.toMatchObject({
      cause: { code: 'ER_DUP_ENTRY' },
    });
  });

  it('m3: /auth is rate-limited per client address; over the limit it answers 429 and writes no auth event', async () => {
    const before = (await tdb.db.select().from(authEvents)).length;
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++)
      statuses.push(
        (await fetch(`${api}/auth/google/callback?state=x&code=y`, { redirect: 'manual' })).status,
      );
    expect(statuses.filter((st) => st === 303)).toHaveLength(30);
    expect(statuses.slice(30).every((st) => st === 429)).toBe(true);
    // Each of the 30 admitted callbacks is one flow_invalid refusal; the 10 limited ones wrote nothing.
    expect(await eventsSince(before)).toBe(30);
    const limited = await fetch(`${api}/auth/google/callback`, { redirect: 'manual' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    for (let i = 0; i < 31; i++) await fetch(`${api}/auth/google/start`, { redirect: 'manual' });
    expect((await fetch(`${api}/auth/google/start`, { redirect: 'manual' })).status).toBe(429);
  });

  it('m3: an unexpected failure is recorded as internal_error (callback and start)', async () => {
    const spy = vi
      .spyOn(UserDirectory.prototype, 'createSession')
      .mockRejectedValueOnce(new Error('database went away'));
    try {
      const owner = (await tdb.db.select().from(users).where(eq(users.id, tenantA.ownerUserId)))[0];
      const linked = await identitiesOf(tenantA.ownerUserId);
      signInAs({ sub: linked[0]?.subject as string, email: owner?.email, email_verified: true });
      await expectRefused(await runGoogleSignIn(api, new CookieJar()), 'sign_in_failed', 'internal_error');
    } finally {
      spy.mockRestore();
    }
    // Discovery fails (nothing listens on the issuer): start records the failure too.
    const broken = await startApi({ issuerUrl: new URL('http://127.0.0.1:9') });
    const start = await fetch(`${broken}/auth/google/start`, { redirect: 'manual' });
    expect(start.headers.get('location')).toBe('/sign-in?error=sign_in_failed');
    expect(await lastAuthEvent()).toMatchObject({ decision: 'denied', reason: 'internal_error' });
  });

  it('m5: bootstrapOwner is one transaction: a failed company creation leaves no user behind', async () => {
    const email = `orphan-${randomUUID().slice(0, 8)}@corp.test`;
    const spy = vi
      .spyOn(UserDirectory.prototype, 'createTenant')
      .mockRejectedValueOnce(new Error('tenant insert failed'));
    try {
      await expect(
        accessService.bootstrapOwner(
          { email, name: 'Orphan', tenant: { name: 'Orphan', slug: `orphan-${randomUUID().slice(0, 8)}` } },
          'test-m5',
        ),
      ).rejects.toThrow('tenant insert failed');
    } finally {
      spy.mockRestore();
    }
    expect(await tdb.db.select().from(users).where(eq(users.email, email))).toEqual([]);
  });

  it('n3: if ending the previous session fails, no new session is left behind', async () => {
    const owner = (await tdb.db.select().from(users).where(eq(users.id, tenantA.ownerUserId)))[0];
    const linked = await identitiesOf(tenantA.ownerUserId);
    signInAs({ sub: linked[0]?.subject as string, email: owner?.email, email_verified: true });
    const jar = new CookieJar();
    await runGoogleSignIn(api, jar);
    const prior = jar.cookies.get('oremedia_session') as string;
    const sessionsBefore = await count(sessions);
    const spy = vi
      .spyOn(UserDirectory.prototype, 'revokeSession')
      .mockRejectedValueOnce(new Error('revoke failed'));
    try {
      await expectRefused(await runGoogleSignIn(api, jar), 'sign_in_failed', 'internal_error');
    } finally {
      spy.mockRestore();
    }
    expect(await count(sessions)).toBe(sessionsBefore);
    expect((await trpcGet(api, 'access.listCompanies', `oremedia_session=${prior}`)).status).toBe(200);
  });

  it('n2: signing out inside a support session closes it (audited in the tenant); the sup_ bearer stops working', async () => {
    const operatorId = newUserId();
    const tokenPart = randomUUID();
    await tdb.db
      .insert(users)
      .values({ id: operatorId, email: `${operatorId.toLowerCase()}@ops.example.test`, name: 'op' });
    await tdb.db.insert(sessions).values({
      id: `ses_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`,
      userId: operatorId,
      tokenHash: hashToken(`ses_${tokenPart}`),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const { supportSessionId } = await accessService.openSupportSession(
      operatorId,
      {
        tenantId: tenantA.tenantId,
        reason: 'customer asked for help',
        ticketRef: 'SUP-9',
        consentRecorded: true,
        durationMinutes: 30,
      },
      'test-n2',
    );
    const bearer = `sup_${tokenPart}.${supportSessionId}`;
    const read = () =>
      fetch(`${api}/trpc/brand.list`, {
        headers: { authorization: `Bearer ${bearer}`, 'x-oremedia-tenant': tenantA.tenantId },
      });
    expect((await read()).status).toBe(200);
    const out = await fetch(`${api}/auth/sign-out`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(out.status).toBe(204);
    const row = (
      await tdb.db.select().from(supportSessions).where(eq(supportSessions.id, supportSessionId))
    )[0];
    expect(row?.closedAt).toBeInstanceOf(Date);
    expect((await read()).status).toBe(401);
    const closed = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA.tenantId), eq(auditEvents.resourceId, supportSessionId)));
    expect(closed.map((a) => a.action)).toContain('support.close');
  });
});
