import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';
import { brandGrants, memberships, sessions, users } from '@oremedia/db/schema/access';
import { anomalies } from '@oremedia/db/schema/intelligence';
import { featureFlags } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { hashToken } from '@oremedia/module-access';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src';
import { configureRateLimiter } from './trpc';

/** Prefixed ids without the domain package (apps depend on contracts, not domain). */
const newId = (kind: IdKind) =>
  `${ID_PREFIXES[kind]}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/**
 * The procedures no other test called (the generic cross-tenant harness only sends them foreign ids), each through
 * the real router: the happy path with the shape it returns, a refusal for a caller whose role or brand grant does
 * not cover it, and a foreign tenant's id refused without leaking it (spec 5.3-5.5, 19.3).
 *
 * Callers, all in tenant A: the owner; the seeded creator (brand 1 only, no manager actions); and a reviewer granted
 * brand 2 only, for the reads every role may make, where the refusal is the brand grant (NOT_FOUND, spec 5.4).
 */
describe('procedures with no other caller: allowed, denied, cross-tenant', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let brand2ReviewerToken: string;

  const as = (bearer: string) => ({ bearer, tenantId: tenantA.tenantId, idempotencyKey: randomUUID() });
  const owner = () => as(tenantA.ownerToken);
  const creator = () => as(tenantA.creatorToken);
  const brand2Reviewer = () => as(brand2ReviewerToken);
  const brand1 = () => tenantA.brandIds[0];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    const userId = newId('user');
    const membershipId = newId('membership');
    brand2ReviewerToken = `ses_${randomUUID()}`;
    await tdb.db.insert(users).values({
      id: userId,
      email: `reviewer-${userId.slice(-6).toLowerCase()}@example.test`,
      name: 'reviewer',
    });
    await tdb.db.insert(memberships).values({
      id: membershipId,
      tenantId: tenantA.tenantId,
      userId,
      role: 'reviewer',
      status: 'active',
      allBrands: false,
    });
    await tdb.db.insert(brandGrants).values({
      id: newId('brandGrant'),
      tenantId: tenantA.tenantId,
      membershipId,
      brandId: tenantA.brandIds[1],
      roles: [],
    });
    await tdb.db.insert(sessions).values({
      id: newId('session'),
      userId,
      tokenHash: hashToken(brand2ReviewerToken),
      selectedTenantId: tenantA.tenantId,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    // The seed has no anomaly: one open anomaly on brand 1 of each tenant.
    for (const t of [tenantA, tenantB])
      await tdb.db.insert(anomalies).values({
        id: newId('anomaly'),
        tenantId: t.tenantId,
        brandId: t.brandIds[0],
        signal: 'qualified_enquiries',
        baseline: 10,
        observed: 2,
        severity: 'high',
        detectedAt: new Date('2026-09-05T00:00:00Z'),
      });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  describe('access.brandGrants.set', () => {
    it('an owner grants a restricted member another brand, which the member can then open', async () => {
      const brand2 = tenantA.brandIds[1];
      const before = await callPath(creator(), 'brand.get', { brandId: brand2 });
      expect(before.error?.code).toBe('NOT_FOUND');
      const res = await callPath(owner(), 'access.brandGrants.set', {
        membershipId: tenantA.creatorMembershipId,
        brandId: brand2,
        roles: [],
      });
      expect(res.error).toBeUndefined();
      expect(res.data).toEqual({ grantId: expect.stringMatching(/^\w+_/) });
      const after = await callPath(creator(), 'brand.get', { brandId: brand2 });
      expect(after.error).toBeUndefined();
      expect((after.data as { id: string }).id).toBe(brand2);
    });

    it('a creator cannot manage grants (membership.manage)', async () => {
      const res = await callPath(creator(), 'access.brandGrants.set', {
        membershipId: tenantA.creatorMembershipId,
        brandId: brand1(),
        roles: [],
      });
      expect(res.error?.code).toBe('FORBIDDEN');
    });

    it("refuses another tenant's membership on the caller's own brand, and writes nothing there", async () => {
      const snapshot = await tenantB.snapshot();
      const res = await callPath(owner(), 'access.brandGrants.set', {
        membershipId: tenantB.creatorMembershipId,
        brandId: brand1(),
        roles: [],
      });
      expect(res.error?.code).toBe('NOT_FOUND');
      expect(await tenantB.snapshot()).toBe(snapshot);
      const grants = await tdb.db
        .select()
        .from(brandGrants)
        .where(eq(brandGrants.membershipId, tenantB.creatorMembershipId));
      expect(grants.every((g) => g.tenantId === tenantB.tenantId)).toBe(true);
    });
  });

  describe('brand.sources.remove', () => {
    it('a creator cannot remove a source (brand.edit_standards)', async () => {
      const res = await callPath(creator(), 'brand.sources.remove', {
        brandId: brand1(),
        sourceId: tenantA.ids['brandSourceId'],
        expectedVersion: 0,
      });
      expect(res.error?.code).toBe('FORBIDDEN');
    });

    it("refuses another tenant's source under the caller's own brand", async () => {
      const res = await callPath(owner(), 'brand.sources.remove', {
        brandId: brand1(),
        sourceId: tenantB.ids['brandSourceId'],
        expectedVersion: 0,
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });

    it('an owner removes a source at its current version; it leaves the list and cannot be removed again', async () => {
      const sourceId = tenantA.ids['brandSourceId'] as string;
      const remove = (expectedVersion: number) =>
        callPath(owner(), 'brand.sources.remove', { brandId: brand1(), sourceId, expectedVersion });
      expect((await remove(5)).error?.code).toBe('CONFLICT');
      const res = await remove(0);
      expect(res.error).toBeUndefined();
      expect(res.data).toEqual({ sourceId, version: 1 });
      const list = await callPath(owner(), 'brand.sources.list', { brandId: brand1(), page: { limit: 50 } });
      expect((list.data as { items: Array<{ id: string }> }).items.map((s) => s.id)).not.toContain(sourceId);
      expect((await remove(1)).error?.code).toBe('NOT_FOUND');
    });
  });

  describe('brand.assist.list', () => {
    it("lists the brand's assist jobs with their state and suggestion counts", async () => {
      const res = await callPath(owner(), 'brand.assist.list', { brandId: brand1(), page: { limit: 50 } });
      expect(res.error).toBeUndefined();
      const data = res.data as {
        items: Array<{ id: string; brandId: string; state: string }>;
        nextCursor: unknown;
      };
      expect(data.items.map((j) => j.id)).toEqual([tenantA.ids['brandAssistJobId']]);
      expect(data.items[0]).toMatchObject({ brandId: brand1(), state: 'ready' });
      expect(data.nextCursor).toBeNull();
    });

    it('a member without a grant on the brand gets NOT_FOUND', async () => {
      const res = await callPath(brand2Reviewer(), 'brand.assist.list', {
        brandId: brand1(),
        page: { limit: 50 },
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });

    it("refuses another tenant's brand", async () => {
      const res = await callPath(owner(), 'brand.assist.list', {
        brandId: tenantB.brandIds[0],
        page: { limit: 50 },
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('assets.versions.list', () => {
    it("lists an asset's versions", async () => {
      const assetId = tenantA.ids['assetId'];
      const res = await callPath(owner(), 'assets.versions.list', { assetId, page: { limit: 50 } });
      expect(res.error).toBeUndefined();
      const data = res.data as {
        items: Array<{ id: string; assetId: string; number: number; mime: string }>;
      };
      expect(data.items).toHaveLength(1);
      expect(data.items[0]).toMatchObject({
        id: tenantA.ids['assetVersionId'],
        assetId,
        number: 1,
        mime: 'image/png',
      });
    });

    it('a member without a grant on the asset’s brand gets NOT_FOUND', async () => {
      const res = await callPath(brand2Reviewer(), 'assets.versions.list', {
        assetId: tenantA.ids['assetId'],
        page: { limit: 50 },
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });

    it("refuses another tenant's asset", async () => {
      const res = await callPath(owner(), 'assets.versions.list', {
        assetId: tenantB.ids['assetId'],
        page: { limit: 50 },
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('review.approvals.get', () => {
    it('returns the approval with its binding', async () => {
      const approvalId = tenantA.ids['approvalId'];
      const res = await callPath(owner(), 'review.approvals.get', { approvalId });
      expect(res.error).toBeUndefined();
      const data = res.data as { id: string; brandId: string; binding: { v: number; tenantId: string } };
      expect(data).toMatchObject({ id: approvalId, brandId: brand1() });
      expect(data.binding).toMatchObject({ v: 1, tenantId: tenantA.tenantId });
    });

    it('a member without a grant on the approval’s brand gets NOT_FOUND', async () => {
      const res = await callPath(brand2Reviewer(), 'review.approvals.get', {
        approvalId: tenantA.ids['approvalId'],
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });

    it("refuses another tenant's approval", async () => {
      const res = await callPath(owner(), 'review.approvals.get', { approvalId: tenantB.ids['approvalId'] });
      expect(res.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('review.mandates.get', () => {
    it('returns the mandate', async () => {
      const mandateId = tenantA.ids['mandateId'];
      const res = await callPath(owner(), 'review.mandates.get', { mandateId });
      expect(res.error).toBeUndefined();
      expect(res.data).toMatchObject({ id: mandateId, brandId: brand1() });
    });

    it('a member without a grant on the mandate’s brand gets NOT_FOUND', async () => {
      const res = await callPath(brand2Reviewer(), 'review.mandates.get', {
        mandateId: tenantA.ids['mandateId'],
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });

    it("refuses another tenant's mandate", async () => {
      const res = await callPath(owner(), 'review.mandates.get', { mandateId: tenantB.ids['mandateId'] });
      expect(res.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('intelligence.playbook.list and intelligence.playbook.propose', () => {
    it('lists the proposed entry; an owner proposes another from the brand’s own insight', async () => {
      const list = await callPath(owner(), 'intelligence.playbook.list', {
        brandId: brand1(),
        page: { limit: 50 },
      });
      expect(list.error).toBeUndefined();
      const before = (list.data as { items: Array<{ id: string; state: string }> }).items;
      expect(before.map((e) => e.id)).toEqual([tenantA.ids['playbookEntryId']]);
      expect(before[0]?.state).toBe('proposed');
      const res = await callPath(owner(), 'intelligence.playbook.propose', {
        brandId: brand1(),
        practice: 'Lead with the customer question',
        evidenceInsightIds: [tenantA.ids['insightId']],
        strength: 'observed',
        reviewAfter: '2030-01-01T00:00:00.000Z',
      });
      expect(res.error).toBeUndefined();
      const created = res.data as { playbookEntryId: string; state: string; version: number };
      expect(created).toMatchObject({ state: 'proposed', version: 0 });
      const after = await callPath(owner(), 'intelligence.playbook.list', {
        brandId: brand1(),
        page: { limit: 50 },
      });
      expect((after.data as { items: Array<{ id: string }> }).items.map((e) => e.id)).toContain(
        created.playbookEntryId,
      );
    });

    it('a creator cannot propose (insight.manage); a member without a grant on the brand cannot list', async () => {
      const propose = await callPath(creator(), 'intelligence.playbook.propose', {
        brandId: brand1(),
        practice: 'x',
        evidenceInsightIds: [tenantA.ids['insightId']],
        strength: 'observed',
        reviewAfter: '2030-01-01T00:00:00.000Z',
      });
      expect(propose.error?.code).toBe('FORBIDDEN');
      const list = await callPath(brand2Reviewer(), 'intelligence.playbook.list', {
        brandId: brand1(),
        page: { limit: 50 },
      });
      expect(list.error?.code).toBe('NOT_FOUND');
    });

    it("refuses another tenant's brand, and another tenant's insight as evidence under the caller's own brand", async () => {
      const snapshot = await tenantB.snapshot();
      const list = await callPath(owner(), 'intelligence.playbook.list', {
        brandId: tenantB.brandIds[0],
        page: { limit: 50 },
      });
      expect(list.error?.code).toBe('NOT_FOUND');
      const propose = await callPath(owner(), 'intelligence.playbook.propose', {
        brandId: brand1(),
        practice: 'Borrowed evidence',
        evidenceInsightIds: [tenantB.ids['insightId']],
        strength: 'observed',
        reviewAfter: '2030-01-01T00:00:00.000Z',
      });
      expect(propose.error?.code).toBe('VALIDATION_FAILED');
      expect(propose.error?.details).toEqual([{ path: 'evidenceInsightIds', issue: 'insight_not_in_brand' }]);
      expect(await tenantB.snapshot()).toBe(snapshot);
    });
  });

  describe('intelligence.anomalies.list', () => {
    it("lists the brand's open anomaly", async () => {
      const res = await callPath(owner(), 'intelligence.anomalies.list', {
        brandId: brand1(),
        page: { limit: 50 },
      });
      expect(res.error).toBeUndefined();
      const items = (res.data as { items: Array<Record<string, unknown>> }).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        brandId: brand1(),
        signal: 'qualified_enquiries',
        baseline: 10,
        observed: 2,
        severity: 'high',
        state: 'open',
      });
    });

    it('a member without a grant on the brand gets NOT_FOUND', async () => {
      const res = await callPath(brand2Reviewer(), 'intelligence.anomalies.list', {
        brandId: brand1(),
        page: { limit: 50 },
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });

    it("refuses another tenant's brand", async () => {
      const res = await callPath(owner(), 'intelligence.anomalies.list', {
        brandId: tenantB.brandIds[0],
        page: { limit: 50 },
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('experiments.list', () => {
    it("lists the brand's experiment", async () => {
      const res = await callPath(owner(), 'experiments.list', { brandId: brand1(), page: { limit: 50 } });
      expect(res.error).toBeUndefined();
      const items = (res.data as { items: Array<{ id: string; brandId: string }> }).items;
      expect(items.map((x) => x.id)).toEqual([tenantA.ids['experimentId']]);
      expect(items[0]?.brandId).toBe(brand1());
    });

    it('a member without a grant on the brand gets NOT_FOUND', async () => {
      const res = await callPath(brand2Reviewer(), 'experiments.list', {
        brandId: brand1(),
        page: { limit: 50 },
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });

    it("refuses another tenant's brand", async () => {
      const res = await callPath(owner(), 'experiments.list', {
        brandId: tenantB.brandIds[0],
        page: { limit: 50 },
      });
      expect(res.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('operations.flags.snapshot', () => {
    it('every member reads every flag for its own company; a flag targeted at another company stays off', async () => {
      await tdb.db.insert(featureFlags).values({
        key: 'creative.audio_generation',
        enabledDefault: false,
        targeting: { tenantIds: [tenantB.tenantId] },
        owner: 'creative',
        removalDate: new Date('2027-03-31T00:00:00Z'),
        successMetric: 'test',
      });
      for (const caller of [owner(), creator(), brand2Reviewer()]) {
        const res = await callPath(caller, 'operations.flags.snapshot', undefined);
        expect(res.error).toBeUndefined();
        const flags = res.data as Record<string, boolean>;
        expect(Object.values(flags).every((v) => typeof v === 'boolean')).toBe(true);
        expect(flags['creative.audio_generation']).toBe(false);
      }
      const b = await callPath(
        { bearer: tenantB.ownerToken, tenantId: tenantB.tenantId },
        'operations.flags.snapshot',
        undefined,
      );
      expect((b.data as Record<string, boolean>)['creative.audio_generation']).toBe(true);
    });

    it("refuses a caller who selects a company they are not a member of (another tenant's snapshot)", async () => {
      const res = await callPath(
        { bearer: tenantA.ownerToken, tenantId: tenantB.tenantId },
        'operations.flags.snapshot',
        undefined,
      );
      expect(res.error?.code).toBe('FORBIDDEN');
      expect(res.data).toBeUndefined();
    });
  });
});
