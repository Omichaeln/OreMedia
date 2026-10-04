import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { runInTenant, withTransaction } from '@oremedia/db';
import { brandGrants, memberships, sessions, users } from '@oremedia/db/schema/access';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { accessService, authenticate, hashToken, resolveTenantContext } from '@oremedia/module-access';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src';

const PREFIX = { user: 'usr', membership: 'mem', session: 'ses' } as const;
/** Prefixed 26-character ids like newId (apps may not import the domain package). */
const newId = (kind: keyof typeof PREFIX) =>
  `${PREFIX[kind]}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/**
 * G03 team and roles through the real router against MySQL: a role change and brand grants (setRole,
 * brandGrants.set / remove), and access.members.disable / enable with their rules: membership.manage, people only,
 * an owner or admin only by an owner, never yourself, never the last active owner (neither demoted nor disabled, even
 * by concurrent requests), version-checked, audited, every session ended in the same transaction, the disabled member
 * refused at tenant resolution while the person's other companies are untouched.
 */
describe('members: role, brand grants, disable and enable', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  /** A person with an active membership in `tenant` and a live session there (role and brand scope as given). */
  const person = async (
    tenant: SeededTenant,
    opts: { role?: 'owner' | 'admin' | 'creator' | 'reviewer'; allBrands?: boolean } = {},
  ) => {
    const id = newId('user');
    await tdb.db.insert(users).values({
      id,
      email: `m-${randomUUID().slice(0, 8)}@example.test`,
      name: 'Member person',
      status: 'active',
    });
    const membershipId = newId('membership');
    await tdb.db.insert(memberships).values({
      id: membershipId,
      tenantId: tenant.tenantId,
      userId: id,
      role: opts.role ?? 'creator',
      status: 'active',
      allBrands: opts.allBrands ?? true,
    });
    return { id, membershipId, token: await sessionFor(id, tenant.tenantId) };
  };
  /** A new live session (a sign-in) for a user. */
  const sessionFor = async (userId: string, tenantId: string): Promise<string> => {
    const token = `ses_${randomUUID()}`;
    await tdb.db.insert(sessions).values({
      id: newId('session'),
      userId,
      tokenHash: hashToken(token),
      selectedTenantId: tenantId,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return token;
  };
  const membership = async (id: string) =>
    (await tdb.db.select().from(memberships).where(eq(memberships.id, id)))[0]!;
  const liveSessions = async (userId: string) =>
    (await tdb.db.select().from(sessions).where(eq(sessions.userId, userId))).filter((s) => !s.revokedAt);
  const auditOf = (tenantId: string, action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action)));
  const as = (tenant: SeededTenant, bearer: string) => ({ bearer, tenantId: tenant.tenantId });
  const disable = (tenant: SeededTenant, bearer: string, membershipId: string, expectedVersion: number) =>
    callPath(as(tenant, bearer), 'access.members.disable', { membershipId, expectedVersion });
  const enable = (tenant: SeededTenant, bearer: string, membershipId: string, expectedVersion: number) =>
    callPath(as(tenant, bearer), 'access.members.enable', { membershipId, expectedVersion });
  /** A read any member may make: answers data, or the refusal of the session or membership. */
  const brandList = (tenant: SeededTenant, bearer: string) =>
    callPath(as(tenant, bearer), 'brand.list', undefined);

  // Every membership.manage decision is gated on the seat entitlement (10 by default): the members added below are
  // spread over the two companies so neither reaches it.
  beforeAll(async () => {
    tdb = await createTestDatabase();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('an owner makes a creator a reviewer restricted to one brand: sessions end, the scope follows the grants', async () => {
    const p = await person(tenantA, { role: 'creator', allBrands: true });
    const [brand1, brand2] = tenantA.brandIds;
    const role = await callPath(as(tenantA, tenantA.ownerToken), 'access.members.setRole', {
      membershipId: p.membershipId,
      expectedVersion: 0,
      role: 'reviewer',
      allBrands: false,
    });
    expect(role.error).toBeUndefined();
    expect(await liveSessions(p.id)).toEqual([]);
    for (const brandId of [brand1, brand2])
      expect(
        (
          await callPath(as(tenantA, tenantA.ownerToken), 'access.brandGrants.set', {
            membershipId: p.membershipId,
            brandId,
            roles: [],
          })
        ).error,
      ).toBeUndefined();
    const removed = await callPath(as(tenantA, tenantA.ownerToken), 'access.brandGrants.remove', {
      membershipId: p.membershipId,
      brandId: brand2,
    });
    expect(removed.data).toEqual({ removed: true });
    expect(
      (await auditOf(tenantA.tenantId, 'brand_grant.remove')).some((e) => e.resourceId === p.membershipId),
    ).toBe(true);
    // Removing a grant that is not there answers removed: false and records nothing more.
    expect(
      (
        await callPath(as(tenantA, tenantA.ownerToken), 'access.brandGrants.remove', {
          membershipId: p.membershipId,
          brandId: brand2,
        })
      ).data,
    ).toEqual({ removed: false });
    const signedIn = await sessionFor(p.id, tenantA.tenantId);
    const me = await callPath(as(tenantA, signedIn), 'access.me', undefined);
    expect(me.data).toMatchObject({ actor: { role: 'reviewer', allBrands: false }, brandIds: [brand1] });
    const listed = (
      (await callPath(as(tenantA, tenantA.ownerToken), 'access.members.list', undefined)).data as {
        items: Array<{ membershipId: string; role: string; brandIds: string[] }>;
      }
    ).items.find((m) => m.membershipId === p.membershipId);
    expect(listed).toMatchObject({ role: 'reviewer', brandIds: [brand1] });
  });

  it('brand grants are membership.manage; a foreign membership or brand is NOT_FOUND', async () => {
    const p = await person(tenantA, { allBrands: false });
    expect(
      (
        await callPath(as(tenantA, tenantA.creatorToken), 'access.brandGrants.remove', {
          membershipId: p.membershipId,
          brandId: tenantA.brandIds[0],
        })
      ).error?.code,
    ).toBe('FORBIDDEN');
    expect(
      (
        await callPath(as(tenantA, tenantA.ownerToken), 'access.brandGrants.remove', {
          membershipId: tenantB.creatorMembershipId,
          brandId: tenantA.brandIds[0],
        })
      ).error?.code,
    ).toBe('NOT_FOUND');
    expect(
      (
        await callPath(as(tenantA, tenantA.ownerToken), 'access.brandGrants.remove', {
          membershipId: p.membershipId,
          brandId: tenantB.brandIds[0],
        })
      ).error?.code,
    ).toBe('NOT_FOUND');
    // The foreign creator keeps their grant.
    expect(
      await tdb.db
        .select()
        .from(brandGrants)
        .where(eq(brandGrants.membershipId, tenantB.creatorMembershipId)),
    ).toHaveLength(1);
  });

  it('disabling ends every session in the same transaction, is audited, and refuses the member in this company only', async () => {
    const p = await person(tenantA);
    // The same person also belongs to company B.
    await tdb.db.insert(memberships).values({
      id: newId('membership'),
      tenantId: tenantB.tenantId,
      userId: p.id,
      role: 'creator',
      status: 'active',
      allBrands: true,
    });
    expect((await brandList(tenantA, p.token)).error).toBeUndefined();
    const res = await disable(tenantA, tenantA.ownerToken, p.membershipId, 0);
    expect(res.data).toEqual({ membershipId: p.membershipId, status: 'disabled', version: 1 });
    expect(await membership(p.membershipId)).toMatchObject({ status: 'disabled', version: 1 });
    expect(await liveSessions(p.id)).toEqual([]);
    // The session they held no longer authenticates.
    expect((await brandList(tenantA, p.token)).error?.code).toBe('UNAUTHENTICATED');
    // A fresh sign-in is refused at tenant resolution for this company, and the company leaves their portfolio.
    const again = await sessionFor(p.id, tenantA.tenantId);
    expect((await brandList(tenantA, again)).error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your membership is not active',
    });
    const principal = await authenticate(again);
    await expect(resolveTenantContext(principal!, tenantA.tenantId, 'corr-members')).rejects.toMatchObject({
      reason: 'membership_inactive',
    });
    const companies = (await callPath({ bearer: again }, 'access.listCompanies', undefined)).data as Array<{
      tenantId: string;
    }>;
    expect(companies.map((c) => c.tenantId)).toEqual([tenantB.tenantId]);
    // Company B is untouched: membership status is per company; the account (users.status) stays active.
    expect((await brandList(tenantB, again)).error).toBeUndefined();
    expect((await tdb.db.select().from(users).where(eq(users.id, p.id)))[0]?.status).toBe('active');
    const [audited] = (await auditOf(tenantA.tenantId, 'membership.disable')).filter(
      (e) => e.resourceId === p.membershipId,
    );
    expect(audited).toMatchObject({ decision: 'allowed', actorId: tenantA.ownerUserId });
    expect(
      (
        await tdb.db
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.tenantId, tenantA.tenantId),
              eq(outboxEvents.eventType, 'membership.changed'),
            ),
          )
      ).some((e) => (e.payload as { membershipId?: string; change?: string }).change === 'disabled'),
    ).toBe(true);
  });

  it('enabling restores access with the role and brands as they were; each change is version-checked and audited', async () => {
    const p = await person(tenantB, { role: 'reviewer' });
    expect((await disable(tenantB, tenantB.ownerToken, p.membershipId, 0)).error).toBeUndefined();
    // A stale version is CONFLICT.
    expect((await enable(tenantB, tenantB.ownerToken, p.membershipId, 0)).error?.code).toBe('CONFLICT');
    const res = await enable(tenantB, tenantB.ownerToken, p.membershipId, 1);
    expect(res.data).toEqual({ membershipId: p.membershipId, status: 'active', version: 2 });
    expect(await membership(p.membershipId)).toMatchObject({ status: 'active', role: 'reviewer' });
    const signedIn = await sessionFor(p.id, tenantB.tenantId);
    expect((await brandList(tenantB, signedIn)).error).toBeUndefined();
    expect(
      (await auditOf(tenantB.tenantId, 'membership.enable')).some((e) => e.resourceId === p.membershipId),
    ).toBe(true);
  });

  it('only an active membership is disabled and only a disabled one enabled', async () => {
    const p = await person(tenantB);
    expect((await enable(tenantB, tenantB.ownerToken, p.membershipId, 0)).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'membershipId', issue: 'membership_is_active' }],
    });
    const invited = newId('membership');
    await tdb.db.insert(memberships).values({
      id: invited,
      tenantId: tenantB.tenantId,
      userId: (await person(tenantA)).id,
      role: 'creator',
      status: 'invited',
      allBrands: false,
    });
    expect((await disable(tenantB, tenantB.ownerToken, invited, 0)).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'membershipId', issue: 'membership_is_invited' }],
    });
  });

  it('never yourself; an owner or admin only by an owner; members without membership.manage and API keys are refused', async () => {
    expect((await disable(tenantA, tenantA.ownerToken, tenantA.ownerMembershipId, 0)).error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You cannot disable your own membership',
    });
    const admin = await person(tenantA, { role: 'admin' });
    const otherAdmin = await person(tenantA, { role: 'admin' });
    expect((await disable(tenantA, admin.token, tenantA.ownerMembershipId, 0)).error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only an owner can disable an owner or admin',
    });
    expect((await disable(tenantA, admin.token, otherAdmin.membershipId, 0)).error?.code).toBe('FORBIDDEN');
    // A creator cannot manage members at all.
    const target = await person(tenantA);
    expect((await disable(tenantA, tenantA.creatorToken, target.membershipId, 0)).error?.code).toBe(
      'FORBIDDEN',
    );
    // An API key (a service principal) is never a person.
    expect(
      (
        await callPath({ bearer: tenantA.apiClientKey }, 'access.members.disable', {
          membershipId: target.membershipId,
          expectedVersion: 0,
        })
      ).error?.code,
    ).toBe('FORBIDDEN');
    expect((await membership(target.membershipId)).status).toBe('active');
    // An admin may disable a creator.
    expect((await disable(tenantA, admin.token, target.membershipId, 0)).error).toBeUndefined();
    // Denials are audited (on their own connection) with the decision.
    expect((await auditOf(tenantA.tenantId, 'membership.manage')).some((e) => e.decision === 'denied')).toBe(
      true,
    );
  });

  it('never the last active owner, even for a request resolved before the other owner was disabled', async () => {
    const second = await person(tenantB, { role: 'owner' });
    // Resolved while both owners are active (a request in flight).
    const stale = await resolveTenantContext(
      (await authenticate(second.token))!,
      tenantB.tenantId,
      'corr-last-owner',
    );
    expect((await disable(tenantB, tenantB.ownerToken, second.membershipId, 0)).error).toBeUndefined();
    // The disabled owner's in-flight request cannot take the remaining owner with it.
    await expect(
      runInTenant(stale.context, () =>
        withTransaction((tx) =>
          accessService.disableMember(
            stale.actor,
            { membershipId: tenantB.ownerMembershipId, expectedVersion: 0 },
            tx,
          ),
        ),
      ),
    ).rejects.toMatchObject({ reason: 'last_owner' });
    expect(await membership(tenantB.ownerMembershipId)).toMatchObject({ status: 'active', role: 'owner' });
    expect((await brandList(tenantB, tenantB.ownerToken)).error).toBeUndefined();
  });

  // Sole-owner guard on a role change: each case runs in a company of its own, as it changes who owns it.
  const LAST_OWNER = 'The company must keep at least one active owner';
  const freshCompany = async () => (await seedTwoTenants(tdb.db)).tenantA;
  const setRole = (tenant: SeededTenant, bearer: string, membershipId: string, role: 'owner' | 'admin') =>
    callPath(as(tenant, bearer), 'access.members.setRole', { membershipId, expectedVersion: 0, role });
  const activeOwners = async (tenantId: string) =>
    (await tdb.db.select().from(memberships).where(eq(memberships.tenantId, tenantId))).filter(
      (m) => m.role === 'owner' && m.status === 'active',
    );

  it('the last active owner cannot demote themselves: refused, nothing changes and their sessions stay', async () => {
    const company = await freshCompany();
    const res = await setRole(company, company.ownerToken, company.ownerMembershipId, 'admin');
    expect(res.error).toMatchObject({ code: 'FORBIDDEN', message: LAST_OWNER });
    expect(await membership(company.ownerMembershipId)).toMatchObject({ role: 'owner', version: 0 });
    expect(await liveSessions(company.ownerUserId)).not.toEqual([]);
    expect(await auditOf(company.tenantId, 'membership.set_role')).toEqual([]);
  });

  it('one of two owners is demoted; the remaining owner then cannot demote themselves', async () => {
    const company = await freshCompany();
    const second = await person(company, { role: 'owner' });
    expect((await setRole(company, company.ownerToken, second.membershipId, 'admin')).error).toBeUndefined();
    expect(await membership(second.membershipId)).toMatchObject({ role: 'admin', version: 1 });
    expect(await activeOwners(company.tenantId)).toHaveLength(1);
    expect(
      (await setRole(company, company.ownerToken, company.ownerMembershipId, 'admin')).error,
    ).toMatchObject({ code: 'FORBIDDEN', message: LAST_OWNER });
    expect(await membership(company.ownerMembershipId)).toMatchObject({ role: 'owner', status: 'active' });
  });

  it('two owners demoting each other at the same time: exactly one succeeds and one owner remains', async () => {
    const company = await freshCompany();
    const second = await person(company, { role: 'owner' });
    const results = await Promise.all([
      setRole(company, company.ownerToken, second.membershipId, 'admin'),
      setRole(company, second.token, company.ownerMembershipId, 'admin'),
    ]);
    expect(results.filter((r) => r.error === undefined)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error).toMatchObject({ code: 'FORBIDDEN', message: LAST_OWNER });
    expect(await activeOwners(company.tenantId)).toHaveLength(1);
  });

  it('demoting yourself while the other owner is disabled at the same time: exactly one succeeds', async () => {
    const company = await freshCompany();
    const second = await person(company, { role: 'owner' });
    const results = await Promise.all([
      disable(company, company.ownerToken, second.membershipId, 0),
      setRole(company, company.ownerToken, company.ownerMembershipId, 'admin'),
    ]);
    expect(results.filter((r) => r.error === undefined)).toHaveLength(1);
    expect(results.find((r) => r.error)?.error).toMatchObject({ code: 'FORBIDDEN', message: LAST_OWNER });
    expect(await activeOwners(company.tenantId)).toHaveLength(1);
  });

  it('a foreign membership is NOT_FOUND and nothing changes in the other company', async () => {
    expect((await disable(tenantA, tenantA.ownerToken, tenantB.creatorMembershipId, 0)).error?.code).toBe(
      'NOT_FOUND',
    );
    expect((await enable(tenantA, tenantA.ownerToken, tenantB.creatorMembershipId, 0)).error?.code).toBe(
      'NOT_FOUND',
    );
    expect(await membership(tenantB.creatorMembershipId)).toMatchObject({ status: 'active', version: 0 });
    expect((await brandList(tenantB, tenantB.creatorToken)).error).toBeUndefined();
  });
});
