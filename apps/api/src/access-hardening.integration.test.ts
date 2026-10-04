import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';
import { apiClients, memberships, sessions, users } from '@oremedia/db/schema/access';
import { idempotencyKeys } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { accessService, hashToken } from '@oremedia/module-access';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src';
import { configureRateLimiter } from './trpc';

/** Prefixed ids without the domain package (apps depend on contracts, not domain). */
const newId = (kind: IdKind) =>
  `${ID_PREFIXES[kind]}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/**
 * Who may hand out access, and what is kept of it: plaintext keys and reviewer tokens are never stored for replay,
 * credentials and memberships are changed only by people of the company (never a support session), brand-level
 * owner/admin roles only by an owner, a revoked key is not rotated again, assignments need experiment.manage, a
 * disabled person's sessions stop working, new keys name a scope and reviewer links last at most 30 days.
 */
describe('access hardening (credentials, memberships and grants)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  const as = (bearer: string) => ({ bearer, tenantId: tenantA.tenantId });

  /** A member of company A with a live session (`allBrands` true unless restricted). */
  const member = async (role: 'admin' | 'creator', allBrands = true) => {
    const userId = newId('user');
    const membershipId = newId('membership');
    const token = `ses_${randomUUID()}`;
    await tdb.db
      .insert(users)
      .values({ id: userId, email: `${userId.toLowerCase()}@example.test`, name: `${role} member` });
    await tdb.db
      .insert(memberships)
      .values({ id: membershipId, tenantId: tenantA.tenantId, userId, role, status: 'active', allBrands });
    const sessionFor = async () => {
      const bearer = `ses_${randomUUID()}`;
      await tdb.db.insert(sessions).values({
        id: newId('session'),
        userId,
        tokenHash: hashToken(bearer),
        selectedTenantId: tenantA.tenantId,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return bearer;
    };
    await tdb.db.insert(sessions).values({
      id: newId('session'),
      userId,
      tokenHash: hashToken(token),
      selectedTenantId: tenantA.tenantId,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return { userId, membershipId, token, sessionFor };
  };
  const versionOf = async (membershipId: string) =>
    (await tdb.db.select().from(memberships).where(eq(memberships.id, membershipId)))[0]!.version;

  /** An operator's support session on company A, read-only or escalated by a second operator (spec 5.7). */
  const supportSession = async (escalate: boolean) => {
    const operator = async () => {
      const userId = newId('user');
      const tokenPart = randomUUID();
      await tdb.db
        .insert(users)
        .values({ id: userId, email: `${userId.toLowerCase()}@ops.example.test`, name: 'op' });
      await tdb.db.insert(sessions).values({
        id: newId('session'),
        userId,
        tokenHash: hashToken(`ses_${tokenPart}`),
        selectedTenantId: null,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const { supportSessionId } = await accessService.openSupportSession(
        userId,
        {
          tenantId: tenantA.tenantId,
          reason: 'customer asked for help with their keys',
          ticketRef: 'SUP-9',
          consentRecorded: true,
          durationMinutes: 60,
        },
        `corr-${randomUUID()}`,
      );
      return { supportSessionId, bearer: `sup_${tokenPart}.${supportSessionId}` };
    };
    const first = await operator();
    if (!escalate) return first.bearer;
    const second = await operator();
    const escalated = await callPath(as(second.bearer), 'access.supportSessions.escalate', {
      supportSessionId: first.supportSessionId,
      reason: 'second operator approves the change in SUP-9',
    });
    expect(escalated.error).toBeUndefined();
    return first.bearer;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA } = await seedTwoTenants(tdb.db));
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('API keys and reviewer tokens are never stored for replay: a retry after a demotion is FORBIDDEN', async () => {
    const admin = await member('admin');
    const key = randomUUID();
    const created = await callPath({ ...as(admin.token), idempotencyKey: key }, 'access.apiClients.create', {
      servicePrincipalId: tenantA.servicePrincipalId,
      scopes: ['brands:read'],
    });
    expect(created.error).toBeUndefined();
    const plaintext = (created.data as { key: string }).key;
    const link = await callPath(as(admin.token), 'review.externalLinks.create', {
      reviewRequestId: tenantA.ids['reviewRequestId'],
      email: 'client@example.test',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(link.error).toBeUndefined();
    const token = (link.data as { token: string }).token;
    const stored = JSON.stringify(await tdb.db.select().from(idempotencyKeys));
    expect(stored).not.toContain(plaintext);
    expect(stored).not.toContain(token);
    expect(
      await tdb.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.path, 'access.apiClients.create')),
    ).toEqual([]);

    // Demoted to creator (which ends their sessions); a new session replays the same request and key.
    const demoted = await callPath(as(tenantA.ownerToken), 'access.members.setRole', {
      membershipId: admin.membershipId,
      expectedVersion: await versionOf(admin.membershipId),
      role: 'creator',
    });
    expect(demoted.error).toBeUndefined();
    const replay = await callPath(
      { ...as(await admin.sessionFor()), idempotencyKey: key },
      'access.apiClients.create',
      { servicePrincipalId: tenantA.servicePrincipalId, scopes: ['brands:read'] },
    );
    expect(replay.error?.code).toBe('FORBIDDEN');
    expect(JSON.stringify(replay)).not.toContain(plaintext);
  });

  it('an escalated support session cannot invite, change roles, grant brands or mint and rotate keys', async () => {
    const support = await supportSession(true);
    const creatorVersion = await versionOf(tenantA.creatorMembershipId);
    const attempts: Array<[string, unknown]> = [
      ['access.members.invite', { email: `owner-${randomUUID()}@example.test`, role: 'owner' }],
      [
        'access.members.setRole',
        { membershipId: tenantA.creatorMembershipId, expectedVersion: creatorVersion, role: 'owner' },
      ],
      [
        'access.brandGrants.set',
        { membershipId: tenantA.creatorMembershipId, brandId: tenantA.brandIds[1], roles: ['creator'] },
      ],
      [
        'access.apiClients.create',
        { servicePrincipalId: tenantA.servicePrincipalId, scopes: ['brands:read'] },
      ],
      ['access.apiClients.rotate', { apiClientId: tenantA.apiClientId }],
    ];
    const keysBefore = await tdb.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.tenantId, tenantA.tenantId));
    for (const [path, input] of attempts)
      expect((await callPath(as(support), path, input)).error?.code, path).toBe('FORBIDDEN');
    expect(await tdb.db.select().from(apiClients).where(eq(apiClients.tenantId, tenantA.tenantId))).toEqual(
      keysBefore,
    );
    expect(await versionOf(tenantA.creatorMembershipId)).toBe(creatorVersion);
  });

  it('brand grant roles are membership roles, and only an owner grants owner or admin on a brand', async () => {
    const admin = await member('admin');
    const target = await member('creator', false);
    const grant = (bearer: string, roles: string[]) =>
      callPath(as(bearer), 'access.brandGrants.set', {
        membershipId: target.membershipId,
        brandId: tenantA.brandIds[0],
        roles,
      });
    expect((await grant(admin.token, ['owner'])).error?.code).toBe('FORBIDDEN');
    expect((await grant(admin.token, ['reviewer', 'admin'])).error?.code).toBe('FORBIDDEN');
    expect((await grant(admin.token, ['superuser'])).error?.code).toBe('VALIDATION_FAILED');
    expect((await grant(admin.token, ['reviewer'])).error).toBeUndefined();
    expect((await grant(tenantA.ownerToken, ['admin'])).error).toBeUndefined();
  });

  it('a key is rotated only while active: rotating the one already replaced is refused', async () => {
    const earlierKeys = await tdb.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.servicePrincipalId, tenantA.servicePrincipalId));
    const created = await callPath(as(tenantA.ownerToken), 'access.apiClients.create', {
      servicePrincipalId: tenantA.servicePrincipalId,
      scopes: ['brands:read'],
    });
    const { apiClientId } = created.data as { apiClientId: string };
    const first = await callPath(as(tenantA.ownerToken), 'access.apiClients.rotate', { apiClientId });
    expect(first.error).toBeUndefined();
    const again = await callPath(as(tenantA.ownerToken), 'access.apiClients.rotate', { apiClientId });
    expect(again.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'apiClientId', issue: 'not_active' }],
    });
    // One successor only: the replaced key stays revoked and no second active key was started beside it.
    const before = new Set([tenantA.apiClientId, ...earlierKeys.map((c) => c.id)]);
    const since = (
      await tdb.db
        .select()
        .from(apiClients)
        .where(eq(apiClients.servicePrincipalId, tenantA.servicePrincipalId))
    ).filter((c) => !before.has(c.id));
    expect(since.map((c) => [c.id, c.status]).sort()).toEqual(
      [
        [apiClientId, 'revoked'],
        [(first.data as { apiClientId: string }).apiClientId, 'active'],
      ].sort(),
    );
  });

  it('experiment assignments need experiment.manage: a creator or a read-only support session is refused', async () => {
    const input = {
      experimentId: tenantA.ids['experimentId'],
      unitType: 'visitor',
      unitIdHash: 'e'.repeat(40),
    };
    expect((await callPath(as(tenantA.creatorToken), 'experiments.assign', input)).error?.code).toBe(
      'FORBIDDEN',
    );
    expect((await callPath(as(await supportSession(false)), 'experiments.assign', input)).error?.code).toBe(
      'FORBIDDEN',
    );
  });

  it('a new API key names at least one scope; a reviewer link lasts at most 30 days', async () => {
    const noScope = await callPath(as(tenantA.ownerToken), 'access.apiClients.create', {
      servicePrincipalId: tenantA.servicePrincipalId,
      scopes: [],
    });
    expect(noScope.error?.code).toBe('VALIDATION_FAILED');
    const link = (days: number) =>
      callPath(as(tenantA.ownerToken), 'review.externalLinks.create', {
        reviewRequestId: tenantA.ids['reviewRequestId'],
        email: 'client@example.test',
        expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
      });
    expect((await link(31)).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'expiresAt' }],
    });
    expect((await link(29)).error).toBeUndefined();
  });

  it('a person disabled outside the application is signed out of every session on the next request', async () => {
    const person = await member('creator');
    expect((await callPath(as(person.token), 'access.me', undefined)).error).toBeUndefined();
    await tdb.db.update(users).set({ status: 'disabled' }).where(eq(users.id, person.userId));
    expect((await callPath(as(person.token), 'access.me', undefined)).error?.code).toBe('UNAUTHENTICATED');
    expect((await callPath({ bearer: person.token }, 'access.listCompanies', undefined)).error?.code).toBe(
      'UNAUTHENTICATED',
    );
    await tdb.db.update(users).set({ status: 'active' }).where(eq(users.id, person.userId));
    expect((await callPath(as(person.token), 'access.me', undefined)).error).toBeUndefined();
  });
});
