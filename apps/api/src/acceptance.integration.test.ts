import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { brandVersions, policyVersions } from '@oremedia/db/schema/brand';
import { memberships, sessions, tenants, users } from '@oremedia/db/schema/access';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  configureCredentialBroker,
  configurePublishingProviders,
  FixtureProviderAdapter,
  LocalKms,
  registerProviderClients,
  FIXTURE_PROVIDER_KEY,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';
import type { AcceptanceConfig } from '../../../tooling/scripts/acceptance/config';
import { isolationChecks, journeyChecks, sessionKey, signInFixtures } from './acceptance/checks';
import { mutate, signInWithPassword } from './acceptance/client';
import {
  FIXTURE_ROLES,
  FIXTURE_TENANTS,
  fixtureEmail,
  provisionFixtures,
  provisionTenant,
  teardownFixtures,
  type FixtureTenant,
} from './acceptance/fixtures';
import { composeModules } from './composition';
import { createServer } from './server';
import { configureRateLimiter } from './trpc';

/**
 * The staging acceptance fixtures against MySQL and the real Express app (docs/runbooks/staging-acceptance.md):
 * provisioning is idempotent (a second run finds every row and creates nothing), every generated credential signs
 * in through the deployed password endpoint with the Origin the api expects, the earlier run's password stops
 * working, the api checks the job runs (isolation, the review journey) pass against the fixtures, and the teardown
 * leaves nothing usable behind. No credential is printed by any of it.
 */
describe('staging acceptance fixtures and checks (in-process api)', () => {
  let tdb: TestDatabase;
  let http: Server;
  let origin = '';
  const DOMAIN = 'example.test';

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    composeModules();
    http = createHttpServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    http.on('request', createServer({ auth: null, webOrigin: origin }));
  });
  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()));
    await tdb?.drop();
  });

  const config = (): AcceptanceConfig => ({
    databaseUrl: tdb.url,
    webOrigin: origin,
    apiBaseUrl: origin,
    emailDomain: DOMAIN,
    disabledChannels: new Set(),
    repoDir: process.cwd(),
    e2e: { enabled: false },
    load: { enabled: false, expectedPeak: 1, peakMultiplier: 1 },
    modelEval: { enabled: false, taskKinds: [], timeoutMs: 1000, budgetMicros: 0 },
  });

  const ids = (t: FixtureTenant) => ({
    tenantId: t.tenantId,
    operatorUserId: t.operatorUserId,
    members: Object.fromEntries(
      Object.values(t.members).map((m) => [
        m.role,
        { membershipId: m.membershipId, userId: m.userId, email: m.email },
      ]),
    ),
    brandId: t.brandId,
    publishedVersionId: t.publishedVersionId,
    policyVersionId: t.policyVersionId,
    servicePrincipalId: t.servicePrincipalId,
  });

  let first: FixtureTenant[] = [];
  let second: FixtureTenant[] = [];

  it('provisions two companies with a member per role, a published brand version, an active policy and an agent', async () => {
    first = await provisionFixtures({ emailDomain: DOMAIN, webOrigin: origin });
    expect(first.map((t) => t.slug)).toEqual(FIXTURE_TENANTS.map((t) => t.slug));
    for (const t of first) {
      expect(Object.keys(t.members).sort()).toEqual([...FIXTURE_ROLES].sort());
      for (const m of Object.values(t.members)) {
        expect(m.email).toBe(fixtureEmail(t.slug, m.role, DOMAIN));
        expect(m.password.length).toBeGreaterThanOrEqual(12);
      }
      const [tenant] = await tdb.db.select().from(tenants).where(eq(tenants.id, t.tenantId));
      expect(tenant).toMatchObject({ slug: t.slug, name: t.name, status: 'active' });
      const rows = await tdb.db.select().from(memberships).where(eq(memberships.tenantId, t.tenantId));
      // The operator (owner, no password) plus one active member per role; every invitation was claimed.
      expect(rows).toHaveLength(FIXTURE_ROLES.length + 1);
      expect(rows.every((m) => m.status === 'active')).toBe(true);
      const [version] = await tdb.db
        .select()
        .from(brandVersions)
        .where(eq(brandVersions.id, t.publishedVersionId));
      expect(version).toMatchObject({ brandId: t.brandId, state: 'published' });
      const [policy] = await tdb.db
        .select()
        .from(policyVersions)
        .where(eq(policyVersions.id, t.policyVersionId));
      expect(policy).toMatchObject({ brandId: t.brandId, state: 'active' });
      expect(t.channelConnectionIds).toEqual([]); // no certified provider: never a real account
      const [operator] = await tdb.db.select().from(users).where(eq(users.id, t.operatorUserId));
      expect(operator?.passwordHash).toBeNull();
    }
    // Two different companies, two different brands.
    expect(first[0]!.tenantId).not.toBe(first[1]!.tenantId);
    expect(first[0]!.brandId).not.toBe(first[1]!.brandId);
  }, 120_000);

  it('a second run is idempotent: the same rows, fresh passwords, and the earlier passwords no longer sign in', async () => {
    second = await provisionFixtures({ emailDomain: DOMAIN, webOrigin: origin });
    expect(second.map(ids)).toEqual(first.map(ids));
    for (const [i, t] of second.entries()) {
      const before = first[i]!;
      for (const m of Object.values(t.members)) {
        expect(m.password).not.toBe(before.members[m.role].password);
        const stale = await signInWithPassword(origin, m.email, before.members[m.role].password);
        expect(stale).toMatchObject({ ok: false, status: 401 });
      }
      const rows = await tdb.db.select().from(memberships).where(eq(memberships.tenantId, t.tenantId));
      expect(rows).toHaveLength(FIXTURE_ROLES.length + 1);
      const versions = await tdb.db.select().from(brandVersions).where(eq(brandVersions.brandId, t.brandId));
      expect(versions).toHaveLength(1);
    }
    // The in-process redemptions left no session behind: only the HTTP sign-ins below create any.
    for (const t of second)
      for (const m of Object.values(t.members)) {
        const live = (await tdb.db.select().from(sessions).where(eq(sessions.userId, m.userId))).filter(
          (s) => !s.revokedAt,
        );
        expect(live).toEqual([]);
      }
  }, 120_000);

  it('every generated credential signs in through /auth/password/sign-in, and the api checks pass on the fixtures', async () => {
    const cfg = config();
    configureRateLimiter(); // a fresh window: the password route is limited per address (the stale attempts above)
    const signedIn = await signInFixtures(cfg, second);
    expect(signedIn.results.map((r) => r.outcome)).toEqual(signedIn.results.map(() => 'pass'));
    expect(signedIn.results).toHaveLength(FIXTURE_TENANTS.length * FIXTURE_ROLES.length);
    expect(signedIn.sessions.size).toBe(FIXTURE_TENANTS.length * FIXTURE_ROLES.length);
    for (const s of signedIn.sessions.values()) expect(s.token).toMatch(/^ses_/);

    const [a, b] = second as [FixtureTenant, FixtureTenant];
    const isolation = await isolationChecks(signedIn.sessions, a, b);
    expect(isolation.map((r) => [r.name, r.outcome])).toEqual([
      ['isolation:brand-get', 'pass'],
      ['isolation:tenant-header', 'pass'],
      ['isolation:brand-list', 'pass'],
    ]);
    // No certified provider in the registry, so no channel: the package is created and the rest is skipped, not failed.
    const journey = await journeyChecks(signedIn.sessions, a, 'no certified provider');
    expect(journey.map((r) => [r.name, r.outcome])).toEqual([
      ['journey:package-create', 'pass'],
      ['journey:variants', 'skip'],
      ['journey:review-request', 'skip'],
      ['journey:external-reviewer-link', 'skip'],
      ['journey:external-reviewer-read', 'skip'],
      ['journey:approve', 'skip'],
      ['journey:schedule', 'skip'],
    ]);
    expect(journey.every((r) => r.outcome !== 'skip' || r.detail.includes('no certified provider'))).toBe(
      true,
    );
    // No detail carries a session token, a reviewer link token or a password.
    const everything = [...signedIn.results, ...isolation, ...journey].map((r) => r.detail).join('\n');
    for (const s of signedIn.sessions.values()) expect(everything).not.toContain(s.token);
    for (const t of second)
      for (const m of Object.values(t.members)) expect(everything).not.toContain(m.password);
    expect(everything).not.toMatch(/\brl_/);
  }, 120_000);

  it('with a certified channel on the fixture brand the journey runs to a scheduled, then cancelled, publication', async () => {
    // The test fixture provider stands in for a certified channel (never registered in production: staging has
    // none today, so the job skips these steps there). Connected through the deployed connect path as a publisher.
    configurePublishingProviders({
      registry: new ProviderRegistry().register(new FixtureProviderAdapter()),
      insecureAllowLoopback: true,
    });
    configureCredentialBroker({ kms: new LocalKms('acceptance-test-master-secret-0123456789') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    configureRateLimiter();
    const [a] = second as [FixtureTenant, FixtureTenant];
    let signedIn = await signInFixtures(config(), [a]);
    const publisher = signedIn.sessions.get(sessionKey(a, 'publisher'))!;
    const started = await mutate<{ state: string }>(publisher, 'publishing.channels.connect.start', {
      brandId: a.brandId,
      providerKey: FIXTURE_PROVIDER_KEY,
      redirectUri: `${origin}/connect/callback`,
    });
    expect(started.error).toBe('');
    const completed = await mutate<{ outcome: string }>(publisher, 'publishing.channels.connect.complete', {
      state: started.data!.state,
      code: 'good',
    });
    expect(completed.data?.outcome).toBe('connected');

    // A third provisioning finds the connection (and, as every run does, rotates the passwords: new sessions).
    const [spec] = FIXTURE_TENANTS;
    const again = await provisionTenant(spec, { emailDomain: DOMAIN, webOrigin: origin });
    expect(ids(again)).toEqual(ids(a));
    expect(again.channelConnectionIds).toHaveLength(1);
    second = [again, second[1]!];
    configureRateLimiter();
    signedIn = await signInFixtures(config(), [again]);
    const journey = await journeyChecks(signedIn.sessions, again, 'fixture provider');
    expect(journey.map((r) => [r.name, r.outcome])).toEqual([
      ['journey:package-create', 'pass'],
      ['journey:variants', 'pass'],
      ['journey:review-request', 'pass'],
      ['journey:external-reviewer-link', 'pass'],
      ['journey:external-reviewer-read', 'pass'],
      ['journey:approve', 'pass'],
      ['journey:schedule', 'pass'],
      ['journey:schedule-cancel', 'pass'],
    ]);
    const everything = journey.map((r) => r.detail).join('\n');
    expect(everything).not.toMatch(/\b(rl|ses)_/);
  }, 120_000);

  it('teardown locks every fixture account: the passwords stop working and every session is revoked', async () => {
    const results = await teardownFixtures({ emailDomain: DOMAIN, webOrigin: origin });
    expect(results.map((r) => [r.name, r.outcome])).toEqual(
      FIXTURE_TENANTS.map((t) => [`teardown:${t.slug}`, 'pass']),
    );
    configureRateLimiter();
    for (const t of second)
      for (const m of Object.values(t.members)) {
        expect(await signInWithPassword(origin, m.email, m.password)).toMatchObject({
          ok: false,
          status: 401,
        });
        const live = (await tdb.db.select().from(sessions).where(eq(sessions.userId, m.userId))).filter(
          (s) => !s.revokedAt,
        );
        expect(live).toEqual([]);
      }
  }, 120_000);
});
