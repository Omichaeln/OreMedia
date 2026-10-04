import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  authEvents,
  externalIdentities,
  memberships,
  passwordSetupTokens,
  sessions,
  users,
} from '@oremedia/db/schema/access';
import { auditEvents, idempotencyKeys } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  accessService,
  hashPassword,
  hashToken,
  newOpaqueToken,
  parsePasswordHash,
  verifyPassword,
} from '@oremedia/module-access';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { CookieJar, callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src';
import { createServer } from './server';
import { configureRateLimiter } from './trpc';

const PREFIX = {
  user: 'usr',
  membership: 'mem',
  session: 'ses',
  externalIdentity: 'xid',
  passwordSetupToken: 'pst',
} as const;
/** Prefixed 26-character ids like newId (apps may not import the domain package). */
const newId = (kind: keyof typeof PREFIX) =>
  `${PREFIX[kind]}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/**
 * Password sign-in, the second login method next to Google, through the real Express app against MySQL: the JSON
 * sign-in route (generic refusals, per-account lockout, Origin check, domain allowlist, rotation, invitations,
 * rehash), one-time setup links (issue, single use, expiry, replacement, placeholder claim, the cross-company rule)
 * and the signed-in person's own password (set, change, remove), with the audit of each.
 */
describe('password sign-in: sign-in route, setup links, account password', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const servers: Server[] = [];
  let api = '';

  const startApi = async (opts: { webOrigin?: string } = {}): Promise<string> => {
    const http = createHttpServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    http.on('request', createServer({ auth: null, webOrigin: opts.webOrigin }));
    servers.push(http);
    return origin;
  };

  const post = async (
    base: string,
    path: '/auth/password/sign-in' | '/auth/password/setup',
    body: unknown,
    opts: { origin?: string | null; jar?: CookieJar } = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.origin === null ? {} : { origin: opts.origin ?? base }),
        ...(opts.jar ? { cookie: opts.jar.header() } : {}),
      },
      body: JSON.stringify(body),
    });
    const setCookies = opts.jar ? opts.jar.store(res) : res.headers.getSetCookie();
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, setCookies, res };
  };
  const signIn = (email: string, password: string, opts: { origin?: string | null; jar?: CookieJar } = {}) =>
    post(api, '/auth/password/sign-in', { email, password }, opts);

  /** A user (optionally with a password and a membership) created for one test. */
  const person = async (
    opts: {
      password?: string;
      passwordHash?: string;
      status?: 'active' | 'disabled';
      tenant?: SeededTenant;
      role?: 'owner' | 'admin' | 'creator';
      domain?: string;
    } = {},
  ) => {
    const id = newId('user');
    const email = `p-${randomUUID().slice(0, 8)}@${opts.domain ?? 'example.test'}`;
    await tdb.db.insert(users).values({
      id,
      email,
      name: 'Password person',
      status: opts.status ?? 'active',
      passwordHash: opts.passwordHash ?? (opts.password ? await hashPassword(opts.password) : null),
    });
    let membershipId: string | null = null;
    if (opts.tenant) {
      membershipId = newId('membership');
      await tdb.db.insert(memberships).values({
        id: membershipId,
        tenantId: opts.tenant.tenantId,
        userId: id,
        role: opts.role ?? 'creator',
        status: 'active',
        allBrands: true,
      });
    }
    return { id, email, membershipId };
  };
  /** An extra live session for a user (a bearer token for the tRPC calls, or another browser). */
  const sessionFor = async (userId: string): Promise<{ token: string; id: string }> => {
    const token = `ses_${randomUUID()}`;
    const id = newId('session');
    await tdb.db.insert(sessions).values({
      id,
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return { token, id };
  };
  const liveSessions = async (userId: string) =>
    (await tdb.db.select().from(sessions).where(eq(sessions.userId, userId))).filter((s) => !s.revokedAt);
  const authEventsOf = async (userId: string) =>
    (await tdb.db.select().from(authEvents).where(eq(authEvents.userId, userId))).sort((a, b) =>
      a.id < b.id ? -1 : 1,
    );
  const lastAuthEvent = async () =>
    (await tdb.db.select().from(authEvents)).sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1);
  const issueLink = (tenant: SeededTenant, membershipId: string, bearer = tenant.ownerToken) =>
    callPath({ bearer, tenantId: tenant.tenantId }, 'access.members.issuePasswordSetup', { membershipId });
  const tokenOf = (url: string) => new URL(url, 'http://x').hash.replace(/^#token=/, '');
  const PASSWORD = 'harbour lantern quietly';

  // Every membership.manage decision is gated on the seat entitlement (10 by default): the tests below spread the
  // members they add over the two companies so neither reaches it.
  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    api = await startApi();
  });
  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    await tdb?.drop();
  });
  beforeEach(() => {
    configureRateLimiter(); // a fresh window per test: the password routes are limited per address and per account
  });

  describe('POST /auth/password/sign-in', () => {
    it('signs in: the same cookies as Google, a working session, auth.sign_in with provider password, invitations accepted', async () => {
      const p = await person({ password: PASSWORD, tenant: tenantA });
      // A pending invitation to another company, sent to this address, is accepted by the sign-in.
      const invitationId = newId('membership');
      await tdb.db.insert(memberships).values({
        id: invitationId,
        tenantId: tenantB.tenantId,
        userId: p.id,
        role: 'reviewer',
        status: 'invited',
        allBrands: false,
        invitedEmail: p.email,
      });
      const jar = new CookieJar();
      const res = await signIn(p.email.toUpperCase(), PASSWORD, { jar });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const sessionCookie = res.setCookies.find((c) => c.startsWith('oremedia_session='));
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/SameSite=Lax/i);
      expect(res.setCookies.find((c) => c.startsWith('oremedia_csrf='))).not.toMatch(/HttpOnly/i);
      expect(res.res.headers.get('cache-control')).toBe('no-store');

      const companies = await fetch(`${api}/trpc/access.listCompanies`, {
        headers: { cookie: jar.header() },
      });
      const listed = (await companies.json()) as { result: { data: { json: Array<{ tenantId: string }> } } };
      expect(listed.result.data.json.map((c) => c.tenantId).sort()).toEqual(
        [tenantA.tenantId, tenantB.tenantId].sort(),
      );
      const [invitation] = await tdb.db.select().from(memberships).where(eq(memberships.id, invitationId));
      expect(invitation?.status).toBe('active');
      const events = await authEventsOf(p.id);
      expect(events.at(-1)).toMatchObject({
        action: 'auth.sign_in',
        provider: 'password',
        decision: 'allowed',
      });
      expect(events.at(-1)?.sessionId).toBeTruthy();
      const accepted = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantB.tenantId), eq(auditEvents.resourceId, invitationId)));
      expect(accepted.map((a) => a.action)).toContain('membership.accept');
    });

    it('rotates the session this browser held (a planted or earlier session ends with the sign-in)', async () => {
      const p = await person({ password: PASSWORD });
      const earlier = await sessionFor(p.id);
      const jar = new CookieJar();
      jar.cookies.set('oremedia_session', earlier.token);
      expect((await signIn(p.email, PASSWORD, { jar })).status).toBe(200);
      const [row] = await tdb.db.select().from(sessions).where(eq(sessions.id, earlier.id));
      expect(row?.revokedAt).not.toBeNull();
      expect(jar.cookies.get('oremedia_session')).not.toBe(earlier.token);
    });

    it('wrong password, unknown email and a user without a password answer exactly alike', async () => {
      const p = await person({ password: PASSWORD });
      const noPassword = await person();
      const wrong = await signIn(p.email, 'not the password at all');
      const unknown = await signIn(`nobody-${randomUUID().slice(0, 8)}@example.test`, PASSWORD);
      const none = await signIn(noPassword.email, PASSWORD);
      for (const r of [wrong, unknown, none]) {
        expect(r.status).toBe(401);
        expect(r.body).toEqual({ ok: false, error: 'invalid_credentials' });
        expect(r.setCookies).toEqual([]);
      }
      expect((await authEventsOf(p.id)).at(-1)).toMatchObject({
        action: 'auth.sign_in',
        provider: 'password',
        decision: 'denied',
        reason: 'invalid_credentials',
        sessionId: null,
      });
      expect(await liveSessions(p.id)).toEqual([]);
    });

    it('a disabled user and an address outside AUTH_ALLOWED_DOMAINS are refused with the same generic answer', async () => {
      const disabled = await person({ password: PASSWORD, status: 'disabled' });
      const res = await signIn(disabled.email, PASSWORD);
      expect(res).toMatchObject({ status: 401, body: { ok: false, error: 'invalid_credentials' } });
      expect((await authEventsOf(disabled.id)).at(-1)).toMatchObject({ reason: 'account_disabled' });

      process.env['AUTH_ALLOWED_DOMAINS'] = 'allowed.test';
      try {
        const restricted = await startApi();
        const outside = await person({ password: PASSWORD });
        const inside = await person({ password: PASSWORD, domain: 'allowed.test' });
        const refused = await post(restricted, '/auth/password/sign-in', {
          email: outside.email,
          password: PASSWORD,
        });
        expect(refused).toMatchObject({ status: 401, body: { ok: false, error: 'invalid_credentials' } });
        expect((await authEventsOf(outside.id)).at(-1)).toMatchObject({ reason: 'domain_not_allowed' });
        const allowed = await post(restricted, '/auth/password/sign-in', {
          email: inside.email,
          password: PASSWORD,
        });
        expect(allowed.status).toBe(200);
      } finally {
        delete process.env['AUTH_ALLOWED_DOMAINS'];
      }
    });

    it('locks password sign-in for an account after 10 failures in the window, even with the right password; unknown addresses lock alike', async () => {
      const p = await person({ password: PASSWORD });
      for (let i = 0; i < 10; i++) expect((await signIn(p.email, `wrong password ${i}`)).status).toBe(401);
      const eventsBefore = (await authEventsOf(p.id)).length;
      const locked = await signIn(p.email, PASSWORD);
      expect(locked.status).toBe(429);
      expect(locked.body).toEqual({ ok: false, error: 'too_many_attempts' });
      expect(Number(locked.res.headers.get('retry-after'))).toBeGreaterThan(800);
      expect(locked.setCookies).toEqual([]);
      // A locked account is not checked at all: no auth_events row, no session.
      expect((await authEventsOf(p.id)).length).toBe(eventsBefore);
      expect(await liveSessions(p.id)).toEqual([]);
      // The lock is per account: another person from the same address still signs in.
      const other = await person({ password: PASSWORD });
      expect((await signIn(other.email, PASSWORD)).status).toBe(200);

      configureRateLimiter();
      const ghost = `ghost-${randomUUID().slice(0, 8)}@example.test`;
      for (let i = 0; i < 10; i++) await signIn(ghost, `wrong password ${i}`);
      expect((await signIn(ghost, PASSWORD)).status).toBe(429);
    }, 60_000);

    it('concurrent guesses cannot slip past the lockout: every attempt is counted before it is checked', async () => {
      const p = await person({ password: PASSWORD });
      // 15 at once (under the per-address limit of 20 a minute): exactly 10 are checked, the rest are refused.
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) => signIn(p.email, `concurrent guess ${i}`)),
      );
      expect(results.filter((r) => r.status === 401)).toHaveLength(10);
      expect(results.filter((r) => r.status === 429)).toHaveLength(5);
      expect((await signIn(p.email, PASSWORD)).status).toBe(429);
    }, 60_000);

    it('a successful sign-in clears the account’s count', async () => {
      const p = await person({ password: PASSWORD });
      for (let i = 0; i < 9; i++) expect((await signIn(p.email, `wrong password ${i}`)).status).toBe(401);
      expect((await signIn(p.email, PASSWORD)).status).toBe(200);
      // Without the reset the next attempt would be the eleventh of the window, and refused.
      for (let i = 0; i < 9; i++) expect((await signIn(p.email, `wrong password ${i}`)).status).toBe(401);
    }, 60_000);

    it('login CSRF: without Origin, or from another origin, nothing is checked; with WEB_ORIGIN only that origin', async () => {
      const p = await person({ password: PASSWORD });
      const missing = await signIn(p.email, PASSWORD, { origin: null });
      const foreign = await signIn(p.email, PASSWORD, { origin: 'https://evil.example' });
      for (const r of [missing, foreign]) {
        expect(r.status).toBe(403);
        expect(r.body).toEqual({ ok: false, error: 'origin_rejected' });
        expect(r.setCookies).toEqual([]);
      }
      const web = 'https://app.example.test';
      const pinned = await startApi({ webOrigin: web });
      const own = await post(pinned, '/auth/password/sign-in', { email: p.email, password: PASSWORD });
      expect(own.status).toBe(403); // its own host is not WEB_ORIGIN
      const fromWeb = await post(
        pinned,
        '/auth/password/sign-in',
        { email: p.email, password: PASSWORD },
        { origin: web },
      );
      expect(fromWeb.status).toBe(200);
    });

    it('a body that is not JSON is refused with the generic answer (and never parsed into a log line)', async () => {
      const res = await fetch(`${api}/auth/password/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: api },
        body: '{"email": "a@example.test", "password": "correct horse',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_credentials' });
    });

    it('a hash made with weaker parameters is upgraded on a successful sign-in', async () => {
      const weak = await hashPassword(PASSWORD, { logN: 10, r: 8, p: 1 });
      const p = await person({ passwordHash: weak });
      expect((await signIn(p.email, PASSWORD)).status).toBe(200);
      const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
      expect(row?.passwordHash).not.toBe(weak);
      expect(parsePasswordHash(row?.passwordHash ?? '')?.params).toEqual({ logN: 17, r: 8, p: 1 });
      expect(await verifyPassword(PASSWORD, row?.passwordHash ?? null)).toBe(true);
    });
  });

  describe('password setup links', () => {
    it('an owner issues a link; only its hash is stored; it sets the password, signs the person in and works once', async () => {
      const p = await person({ tenant: tenantA });
      const other = await sessionFor(p.id);
      const issued = await issueLink(tenantA, p.membershipId as string);
      expect(issued.error).toBeUndefined();
      const link = issued.data as { url: string; expiresAt: string };
      expect(link.url).toMatch(/^\/set-password#token=pst_[A-Za-z0-9_-]{43}$/);
      const hours = (Date.parse(link.expiresAt) - Date.now()) / 3600_000;
      expect(hours).toBeGreaterThan(71.9);
      expect(hours).toBeLessThanOrEqual(72);
      const token = tokenOf(link.url);
      const rows = await tdb.db
        .select()
        .from(passwordSetupTokens)
        .where(eq(passwordSetupTokens.userId, p.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tokenHash: hashToken(token),
        tenantId: tenantA.tenantId,
        usedAt: null,
      });
      expect(JSON.stringify(rows)).not.toContain(token);
      const audit = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA.tenantId), eq(auditEvents.resourceId, p.membershipId!)));
      expect(audit.map((a) => a.action)).toContain('membership.password_setup_issue');
      expect(JSON.stringify(audit)).not.toContain(token);

      const jar = new CookieJar();
      const redeemed = await post(api, '/auth/password/setup', { token, password: PASSWORD }, { jar });
      expect(redeemed).toMatchObject({ status: 200, body: { ok: true } });
      expect(jar.cookies.get('oremedia_session')).toMatch(/^ses_/);
      // A reset ends every session that existed before it.
      const [before] = await tdb.db.select().from(sessions).where(eq(sessions.id, other.id));
      expect(before?.revokedAt).not.toBeNull();
      expect(await liveSessions(p.id)).toHaveLength(1);
      expect((await authEventsOf(p.id)).map((e) => e.action)).toEqual(
        expect.arrayContaining(['auth.password_setup', 'auth.sign_in']),
      );
      expect((await signIn(p.email, PASSWORD)).status).toBe(200);

      const again = await post(api, '/auth/password/setup', { token, password: 'another long password' });
      expect(again).toMatchObject({ status: 400, body: { ok: false, error: 'link_invalid' } });
      expect(await lastAuthEvent()).toMatchObject({ decision: 'denied', reason: 'link_invalid' });
    });

    it('an expired link, a replaced link and an unknown token are refused; a policy failure leaves the link usable', async () => {
      const p = await person({ tenant: tenantA });
      const first = tokenOf(((await issueLink(tenantA, p.membershipId!)).data as { url: string }).url);
      const second = tokenOf(((await issueLink(tenantA, p.membershipId!)).data as { url: string }).url);
      const replaced = await post(api, '/auth/password/setup', { token: first, password: PASSWORD });
      expect(replaced.body).toEqual({ ok: false, error: 'link_invalid' });
      const unknown = await post(api, '/auth/password/setup', { token: 'pst_nope', password: PASSWORD });
      expect(unknown.body).toEqual({ ok: false, error: 'link_invalid' });

      const short = await post(api, '/auth/password/setup', { token: second, password: 'too short' });
      expect(short).toMatchObject({
        status: 400,
        body: { ok: false, error: 'password_rejected', issue: 'too_short' },
      });
      const local = p.email.slice(0, p.email.indexOf('@'));
      const containsEmail = await post(api, '/auth/password/setup', {
        token: second,
        password: `my ${local} password`,
      });
      expect(containsEmail.body).toMatchObject({ error: 'password_rejected', issue: 'contains_email' });

      await tdb.db
        .update(passwordSetupTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(passwordSetupTokens.tokenHash, hashToken(second)));
      const expired = await post(api, '/auth/password/setup', { token: second, password: PASSWORD });
      expect(expired.body).toEqual({ ok: false, error: 'link_invalid' });
      const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
      expect(row?.passwordHash).toBeNull();
    });

    it('claims an invitation placeholder like a first Google sign-in and accepts the invitation', async () => {
      const email = `invited-${randomUUID().slice(0, 8)}@example.test`;
      const invited = await callPath(
        { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
        'access.members.invite',
        { email, role: 'reviewer', allBrands: false },
      );
      const { membershipId } = invited.data as { membershipId: string };
      const [placeholder] = await tdb.db.select().from(users).where(eq(users.email, email));
      expect(placeholder?.status).toBe('disabled');
      const token = tokenOf(((await issueLink(tenantA, membershipId)).data as { url: string }).url);
      const res = await post(api, '/auth/password/setup', { token, password: PASSWORD });
      expect(res.status).toBe(200);
      const [claimed] = await tdb.db.select().from(users).where(eq(users.email, email));
      expect(claimed?.status).toBe('active');
      const [membership] = await tdb.db.select().from(memberships).where(eq(memberships.id, membershipId));
      expect(membership?.status).toBe('active');
      expect((await signIn(email, PASSWORD)).status).toBe(200);
    });

    it('only owners and admins issue links, an owner’s only from an owner, never for someone in another company, never across tenants', async () => {
      const p = await person({ tenant: tenantA });
      // A creator cannot issue a link.
      expect((await issueLink(tenantA, p.membershipId!, tenantA.creatorToken)).error?.code).toBe('FORBIDDEN');
      // An admin cannot issue one for an owner.
      const admin = await person({ tenant: tenantA, role: 'admin' });
      const adminSession = await sessionFor(admin.id);
      const forOwner = await issueLink(tenantA, tenantA.ownerMembershipId, adminSession.token);
      expect(forOwner.error?.code).toBe('FORBIDDEN');
      expect((await issueLink(tenantA, p.membershipId!, adminSession.token)).error).toBeUndefined();
      // A person who also belongs to company B: an admin of A must not get a way into B.
      const both = await person({ tenant: tenantA });
      await tdb.db.insert(memberships).values({
        id: newId('membership'),
        tenantId: tenantB.tenantId,
        userId: both.id,
        role: 'creator',
        status: 'active',
        allBrands: false,
      });
      const refused = await issueLink(tenantA, both.membershipId!);
      expect(refused.error).toMatchObject({ code: 'FORBIDDEN' });
      expect(
        await tdb.db.select().from(passwordSetupTokens).where(eq(passwordSetupTokens.userId, both.id)),
      ).toEqual([]);
      // A membership of another tenant is not found (existence is never leaked).
      expect((await issueLink(tenantA, tenantB.creatorMembershipId)).error?.code).toBe('NOT_FOUND');
    });

    it('a link stops working when the person joins another company, or the issuer loses the right to manage members', async () => {
      const joiner = await person({ tenant: tenantB });
      const token = tokenOf(((await issueLink(tenantB, joiner.membershipId!)).data as { url: string }).url);
      await tdb.db.insert(memberships).values({
        id: newId('membership'),
        tenantId: tenantA.tenantId,
        userId: joiner.id,
        role: 'creator',
        status: 'active',
        allBrands: false,
      });
      expect((await post(api, '/auth/password/setup', { token, password: PASSWORD })).body).toEqual({
        ok: false,
        error: 'link_invalid',
      });

      const admin = await person({ tenant: tenantB, role: 'admin' });
      const adminSession = await sessionFor(admin.id);
      const member = await person({ tenant: tenantB });
      const issued = await issueLink(tenantB, member.membershipId!, adminSession.token);
      const adminToken = tokenOf((issued.data as { url: string }).url);
      await tdb.db
        .update(memberships)
        .set({ role: 'creator' })
        .where(eq(memberships.id, admin.membershipId!));
      expect(
        (await post(api, '/auth/password/setup', { token: adminToken, password: PASSWORD })).body,
      ).toEqual({
        ok: false,
        error: 'link_invalid',
      });
    });

    it('never for yourself, and a link for an admin (as for an owner) only from an owner', async () => {
      const self = await issueLink(tenantB, tenantB.ownerMembershipId);
      expect(self.error).toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('Settings') });
      const admin = await person({ tenant: tenantB, role: 'admin' });
      const otherAdmin = await person({ tenant: tenantB, role: 'admin' });
      const adminSession = await sessionFor(admin.id);
      expect((await issueLink(tenantB, admin.membershipId!, adminSession.token)).error?.code).toBe(
        'FORBIDDEN',
      );
      expect((await issueLink(tenantB, otherAdmin.membershipId!, adminSession.token)).error?.code).toBe(
        'FORBIDDEN',
      );
      expect((await issueLink(tenantB, otherAdmin.membershipId!)).error).toBeUndefined(); // the owner may
      expect(
        await tdb.db.select().from(passwordSetupTokens).where(eq(passwordSetupTokens.userId, admin.id)),
      ).toEqual([]);
    });

    it('is not idempotent: nothing of the response is stored, and a retry with the same key issues a new link', async () => {
      // The seeded creator: the tests before have taken company B close to its seat limit.
      const opts = { bearer: tenantB.ownerToken, tenantId: tenantB.tenantId, idempotencyKey: randomUUID() };
      const first = await callPath(opts, 'access.members.issuePasswordSetup', {
        membershipId: tenantB.creatorMembershipId,
      });
      const second = await callPath(opts, 'access.members.issuePasswordSetup', {
        membershipId: tenantB.creatorMembershipId,
      });
      expect([first.error, second.error]).toEqual([undefined, undefined]);
      const [a, b] = [first, second].map((r) => tokenOf((r.data as { url: string }).url));
      expect(a).not.toBe(b);
      const stored = await tdb.db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.path, 'access.members.issuePasswordSetup'));
      expect(stored).toEqual([]);
      expect(JSON.stringify(await tdb.db.select().from(idempotencyKeys))).not.toContain(a);
      // The retry replaced the first link.
      expect((await post(api, '/auth/password/setup', { token: a, password: PASSWORD })).body).toEqual({
        ok: false,
        error: 'link_invalid',
      });
      expect((await post(api, '/auth/password/setup', { token: b, password: PASSWORD })).status).toBe(200);
    });

    describe('a password chosen through a link stays in the issuing company', () => {
      /** A member of company B with a password set through a link (the link written directly: seats stay free). */
      const linkedMember = async () => {
        const p = await person({ tenant: tenantB });
        const { token, hash } = newOpaqueToken('pst');
        await tdb.db.insert(passwordSetupTokens).values({
          id: newId('passwordSetupToken'),
          tenantId: tenantB.tenantId,
          userId: p.id,
          createdByUserId: tenantB.ownerUserId,
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 3600_000),
        });
        expect((await post(api, '/auth/password/setup', { token, password: PASSWORD })).status).toBe(200);
        const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
        expect(row?.passwordOrigin).toBe('setup_link');
        return p;
      };
      const inviteToA = async (p: { id: string; email: string }) => {
        const id = newId('membership');
        await tdb.db.insert(memberships).values({
          id,
          tenantId: tenantA.tenantId,
          userId: p.id,
          role: 'reviewer',
          status: 'invited',
          allBrands: false,
          invitedEmail: p.email,
        });
        return id;
      };
      const googleSignIn = (email: string) =>
        accessService.signInWithExternalIdentity(
          {
            provider: 'google',
            subject: `google-${randomUUID()}`,
            email,
            emailVerified: true,
            hostedDomain: 'example.test',
          },
          { allowedDomains: null },
          { correlationId: `test-${randomUUID()}`, ipHash: null, userAgentHash: null },
        );
      const statusOf = async (membershipId: string) =>
        (await tdb.db.select().from(memberships).where(eq(memberships.id, membershipId)))[0]?.status;

      it('password sign-in never accepts an invitation; accepting it with Google clears the password and ends its sessions', async () => {
        const p = await linkedMember();
        const invitation = await inviteToA(p);
        expect((await signIn(p.email, PASSWORD)).status).toBe(200);
        expect(await statusOf(invitation)).toBe('invited');
        const passwordSessions = await liveSessions(p.id);
        expect(passwordSessions.length).toBeGreaterThan(0);

        const google = await googleSignIn(p.email);
        expect(google.ok).toBe(true);
        expect(await statusOf(invitation)).toBe('active');
        const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
        expect(row).toMatchObject({ passwordHash: null, passwordOrigin: null });
        // Only the Google session is left; every session the password could have opened has ended.
        expect((await liveSessions(p.id)).map((x) => x.id)).toEqual([
          (google as { sessionId: string }).sessionId,
        ]);
        expect((await authEventsOf(p.id)).map((e) => e.action)).toContain('auth.password_remove');
        expect((await signIn(p.email, PASSWORD)).status).toBe(401);
      });

      it('becoming the owner of a new company (bootstrap) clears it too', async () => {
        const p = await linkedMember();
        await accessService.bootstrapOwner(
          {
            email: p.email,
            name: 'Second company owner',
            tenant: { name: 'Second', slug: `second-${randomUUID().slice(0, 8)}` },
          },
          `test-${randomUUID()}`,
        );
        const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
        expect(row).toMatchObject({ passwordHash: null, passwordOrigin: null });
        expect(await liveSessions(p.id)).toEqual([]);
      });

      // M2 (demo workspace stage 1): opening a demo used to count as joining a second company, so it removed the
      // password and ended every session of anyone whose password came from a setup link.
      it('opening a demo workspace keeps it and every session; a second live company still clears it', async () => {
        const p = await linkedMember();
        const other = await sessionFor(p.id);
        const before = (await liveSessions(p.id)).map((x) => x.id).sort();
        expect(before).toContain(other.id);
        const demo = await accessService.createTenantWithOwner(
          { name: 'Demo workspace', slug: `demo-${randomUUID().slice(0, 8)}` },
          p.id,
          `test-${randomUUID()}`,
          undefined,
          'demo',
        );
        const [kept] = await tdb.db.select().from(users).where(eq(users.id, p.id));
        expect(kept?.passwordOrigin).toBe('setup_link');
        expect(kept?.passwordHash).not.toBeNull();
        expect((await liveSessions(p.id)).map((x) => x.id).sort()).toEqual(before);
        expect((await authEventsOf(p.id)).map((e) => e.action)).not.toContain('auth.password_remove');
        expect(
          (await callPath({ bearer: other.token, tenantId: demo.tenantId }, 'access.me', undefined)).error,
        ).toBeUndefined();
        expect((await signIn(p.email, PASSWORD)).status).toBe(200);

        // The demo does not make a later live company the person's first: B plus a new live company is two.
        await accessService.createTenantWithOwner(
          { name: 'Second live', slug: `second-${randomUUID().slice(0, 8)}` },
          p.id,
          `test-${randomUUID()}`,
        );
        const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
        expect(row).toMatchObject({ passwordHash: null, passwordOrigin: null });
        expect(await liveSessions(p.id)).toEqual([]);
        expect((await signIn(p.email, PASSWORD)).status).toBe(401);
      });

      const linkGoogle = (p: { id: string; email: string }) =>
        tdb.db.insert(externalIdentities).values({
          id: newId('externalIdentity'),
          provider: 'google',
          subject: `google-${randomUUID()}`,
          userId: p.id,
          emailAtLink: p.email,
        });
      const passwordSession = async (email: string, password: string) => {
        const jar = new CookieJar();
        expect((await signIn(email, password, { jar })).status).toBe(200);
        return jar.cookies.get('oremedia_session') as string;
      };

      // Changed behaviour: a change proven with the link password used to make it `self`. Knowing that password only
      // proves the caller held the link (possibly the admin who issued it), so it now stays confined.
      it('changing it with the link password keeps it confined: holding the link is not being the person', async () => {
        const p = await linkedMember();
        const mine = await sessionFor(p.id);
        const changed = 'changed with the link password';
        expect(
          (
            await callPath({ bearer: mine.token }, 'access.account.setPassword', {
              currentPassword: PASSWORD,
              newPassword: changed,
            })
          ).data,
        ).toEqual({ ok: true });
        const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
        expect(row?.passwordOrigin).toBe('setup_link');
        const invitation = await inviteToA(p);
        expect((await signIn(p.email, changed)).status).toBe(200);
        expect(await statusOf(invitation)).toBe('invited');
      });

      it('the issuer keeps no way into a company the person joins later, even after changing the password', async () => {
        // 1-2. Company B's link is redeemed, then the password is changed with it, as the issuer could do.
        const p = await linkedMember();
        const held = await passwordSession(p.email, PASSWORD);
        const changed = 'the issuer picks this one';
        expect(
          (
            await callPath({ bearer: held }, 'access.account.setPassword', {
              currentPassword: PASSWORD,
              newPassword: changed,
            })
          ).data,
        ).toEqual({ ok: true });
        // 3. Company A invites the person, who accepts with Google.
        const invitation = await inviteToA(p);
        const google = await googleSignIn(p.email);
        expect(google.ok).toBe(true);
        expect(await statusOf(invitation)).toBe('active');
        // 4. The password is gone, every session it opened has ended, and it signs nobody in.
        const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
        expect(row).toMatchObject({ passwordHash: null, passwordOrigin: null });
        expect((await liveSessions(p.id)).map((x) => x.id)).toEqual([
          (google as { sessionId: string }).sessionId,
        ]);
        expect((await callPath({ bearer: held }, 'access.listCompanies', undefined)).error?.code).toBe(
          'UNAUTHENTICATED',
        );
        expect((await signIn(p.email, changed)).status).toBe(401);
      });

      it('removing it and setting a first password from a session the link password opened keeps it confined', async () => {
        const p = await linkedMember();
        await linkGoogle(p); // removal needs another sign-in method
        const held = await passwordSession(p.email, PASSWORD);
        expect(
          (await callPath({ bearer: held }, 'access.account.removePassword', { currentPassword: PASSWORD }))
            .data,
        ).toEqual({ ok: true });
        expect(
          (await callPath({ bearer: held }, 'access.account.setPassword', { newPassword: 'set right after' }))
            .data,
        ).toEqual({ ok: true });
        const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
        expect(row?.passwordOrigin).toBe('setup_link');
      });

      it('the person makes it their own from a Google session: remove it, then set a first password', async () => {
        const p = await linkedMember();
        const google = await googleSignIn(p.email); // no invitation: nothing is cleared
        expect(google.ok).toBe(true);
        const token = (google as { token: string }).token;
        expect(
          (await callPath({ bearer: token }, 'access.account.removePassword', { currentPassword: PASSWORD }))
            .data,
        ).toEqual({ ok: true });
        const own = 'my own chosen passphrase';
        expect(
          (await callPath({ bearer: token }, 'access.account.setPassword', { newPassword: own })).data,
        ).toEqual({ ok: true });
        const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
        expect(row?.passwordOrigin).toBe('self');
        const invitation = await inviteToA(p);
        expect((await signIn(p.email, own)).status).toBe(200);
        expect(await statusOf(invitation)).toBe('active');
        expect((await signIn(p.email, own)).status).toBe(200);
      });
    });

    it('the setup route checks Origin like sign-in', async () => {
      const res = await post(
        api,
        '/auth/password/setup',
        { token: 'pst_x', password: PASSWORD },
        { origin: null },
      );
      expect(res).toMatchObject({ status: 403, body: { ok: false, error: 'origin_rejected' } });
    });
  });

  describe('access.account (the signed-in person’s own password)', () => {
    afterEach(() => configureRateLimiter());

    it('sets a first password without a current one; changing it needs the current one; other sessions end, this one stays', async () => {
      const p = await person();
      const mine = await sessionFor(p.id);
      const elsewhere = await sessionFor(p.id);
      const call = (path: string, input?: unknown) => callPath({ bearer: mine.token }, path, input);

      expect((await call('access.account.signInMethods')).data).toEqual({
        hasPassword: false,
        hasGoogle: false,
      });
      const local = p.email.slice(0, p.email.indexOf('@'));
      expect(
        (await call('access.account.setPassword', { newPassword: `x${local}x-long-enough` })).error,
      ).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'newPassword', issue: 'contains_email' }],
      });
      expect((await call('access.account.setPassword', { newPassword: PASSWORD })).data).toEqual({
        ok: true,
      });
      expect((await call('access.account.signInMethods')).data).toEqual({
        hasPassword: true,
        hasGoogle: false,
      });
      expect((await liveSessions(p.id)).map((s) => s.id)).toEqual([mine.id]);
      expect(
        (await tdb.db.select().from(sessions).where(eq(sessions.id, elsewhere.id)))[0]?.revokedAt,
      ).not.toBeNull();
      expect((await authEventsOf(p.id)).at(-1)).toMatchObject({
        action: 'auth.password_set',
        provider: 'password',
        sessionId: mine.id,
      });

      const next = 'a completely new passphrase';
      expect((await call('access.account.setPassword', { newPassword: next })).error).toMatchObject({
        details: [{ path: 'currentPassword', issue: 'required' }],
      });
      expect(
        (await call('access.account.setPassword', { currentPassword: 'not it at all', newPassword: next }))
          .error,
      ).toMatchObject({ details: [{ path: 'currentPassword', issue: 'incorrect' }] });
      expect(
        (await call('access.account.setPassword', { currentPassword: PASSWORD, newPassword: next })).data,
      ).toEqual({ ok: true });
      expect((await signIn(p.email, PASSWORD)).status).toBe(401);
      expect((await signIn(p.email, next)).status).toBe(200);
    });

    it('a first password needs a session signed in within the last 15 minutes (a change is proven by the current password)', async () => {
      const p = await person();
      const stale = await sessionFor(p.id);
      await tdb.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 16 * 60_000), lastSeenAt: new Date() })
        .where(eq(sessions.id, stale.id));
      const refused = await callPath({ bearer: stale.token }, 'access.account.setPassword', {
        newPassword: PASSWORD,
      });
      expect(refused.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Sign in again to set a password',
        details: [{ path: 'session', issue: 'recent_sign_in_required' }],
      });
      const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
      expect(row?.passwordHash).toBeNull();
      const fresh = await sessionFor(p.id);
      expect(
        (await callPath({ bearer: fresh.token }, 'access.account.setPassword', { newPassword: PASSWORD }))
          .data,
      ).toEqual({ ok: true });
      // Once a password exists, the current password proves the person; the session's age does not matter.
      const again = await sessionFor(p.id);
      await tdb.db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 16 * 60_000), lastSeenAt: new Date() })
        .where(eq(sessions.id, again.id));
      expect(
        (
          await callPath({ bearer: again.token }, 'access.account.setPassword', {
            currentPassword: PASSWORD,
            newPassword: 'a completely new passphrase',
          })
        ).data,
      ).toEqual({ ok: true });
    });

    it('guessing the current password locks the change after 10 failures, whichever session guesses', async () => {
      const p = await person({ password: PASSWORD });
      // Two sessions of the same person (each also has its own per-principal limit of 10 calls a minute).
      const [one, two, three] = [await sessionFor(p.id), await sessionFor(p.id), await sessionFor(p.id)];
      const change = (bearer: string, currentPassword: string) =>
        callPath({ bearer }, 'access.account.setPassword', {
          currentPassword,
          newPassword: 'a completely new passphrase',
        });
      for (let i = 0; i < 5; i++) {
        expect((await change(one.token, `guess number ${i}`)).error?.code).toBe('VALIDATION_FAILED');
        expect((await change(two.token, `other guess ${i}`)).error?.code).toBe('VALIDATION_FAILED');
      }
      const locked = await change(three.token, PASSWORD);
      expect(locked.error?.code).toBe('RATE_LIMITED');
      const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
      expect(await verifyPassword(PASSWORD, row?.passwordHash ?? null)).toBe(true);
    }, 60_000);

    it('removing the password is refused without a linked Google identity, allowed with one; other sessions end', async () => {
      const p = await person({ password: PASSWORD });
      const mine = await sessionFor(p.id);
      const elsewhere = await sessionFor(p.id);
      const remove = (currentPassword = PASSWORD) =>
        callPath({ bearer: mine.token }, 'access.account.removePassword', { currentPassword });
      expect((await remove('not the password at all')).error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'currentPassword', issue: 'incorrect' }],
      });
      expect((await remove()).error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'password', issue: 'only_sign_in_method' }],
      });
      await tdb.db.insert(externalIdentities).values({
        id: newId('externalIdentity'),
        provider: 'google',
        subject: `google-${randomUUID()}`,
        userId: p.id,
        emailAtLink: p.email,
      });
      expect(
        (await callPath({ bearer: mine.token }, 'access.account.signInMethods', undefined)).data,
      ).toEqual({
        hasPassword: true,
        hasGoogle: true,
      });
      expect((await liveSessions(p.id)).map((s) => s.id).sort()).toEqual([mine.id, elsewhere.id].sort());
      expect((await remove()).data).toEqual({ ok: true });
      const [row] = await tdb.db.select().from(users).where(eq(users.id, p.id));
      expect(row?.passwordHash).toBeNull();
      // A session the password may have opened ends with it; the one that removed it stays.
      expect((await liveSessions(p.id)).map((s) => s.id)).toEqual([mine.id]);
      expect(
        (await callPath({ bearer: elsewhere.token }, 'access.account.signInMethods', undefined)).error?.code,
      ).toBe('UNAUTHENTICATED');
      expect((await authEventsOf(p.id)).at(-1)).toMatchObject({ action: 'auth.password_remove' });
      expect((await signIn(p.email, PASSWORD)).status).toBe(401);
    });

    it('an API key has no password', async () => {
      const res = await callPath(
        { bearer: tenantA.apiClientKey, tenantId: tenantA.tenantId },
        'access.account.signInMethods',
        undefined,
      );
      expect(res.error?.code).toBe('FORBIDDEN');
    });
  });
});
