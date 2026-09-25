import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  defaultPolicyDocument,
  emptyBrandSystemDocument,
  type BrandSystemDocumentV1,
} from '@oremedia/contracts/brand';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import {
  approvedFacts,
  brandObjectives,
  brandVersions,
  brands,
  designTokens,
  policyVersions,
} from '@oremedia/db/schema/brand';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import {
  brandService,
  registerBrandAssetKindSource,
  registerEligibleTemplateSource,
  registerOnboardingRunSource,
  resetBrandAssetKindSource,
  resetEligibleTemplateSource,
  resetOnboardingRunSource,
  type OnboardingRunSource,
} from './service';

const USER = 'usr_brand_test';
const ctx = (tenantId: string, brandIds: ReadonlySet<string> | 'all' = 'all'): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds,
  correlationId: 'corr_brand',
});
const manager = (tenantId: string): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_brand_test',
  membershipStatus: 'active',
  role: 'brand_manager',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const agent = (tenantId: string): ResolvedActor => ({
  kind: 'service_principal',
  id: 'sp_brand_test',
  tenantId,
  status: 'active',
  maxAutonomy: 'create',
  grants: [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'brand.edit_standards', brandIds: 'all' },
    { action: 'brand.publish_version', brandIds: 'all' },
  ],
});

/** Runs a command the way the router does: tenant context + one transaction. */
const run = <T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  brandIds: ReadonlySet<string> | 'all' = 'all',
) => runInTenant(ctx(tenantId, brandIds), () => withTransaction(fn));

const document = (summary = 'Plain and confident'): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  voice: { ...emptyBrandSystemDocument().voice, summary, tone: ['plain'] },
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
    ],
    typeRoles: [{ role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 16 }],
    spacingScale: [4, 8, 16],
    radii: [0, 4],
    contrastTarget: 'AA',
  },
});

const HOUR = 3600_000;
const evidence = [{ kind: 'other' as const, ref: 'test' }];

describe('brand module (spec 8) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  let v1 = '';
  let v2 = '';
  let versionBOfB = '';
  let factBOfB = '';

  /** Rows of the other brand tables, to prove publishing never touches approved work. */
  const otherRows = async () =>
    JSON.stringify({
      facts: await tdb.db.select().from(approvedFacts).where(eq(approvedFacts.tenantId, tenantA)),
      objectives: await tdb.db.select().from(brandObjectives).where(eq(brandObjectives.tenantId, tenantA)),
      policies: await tdb.db.select().from(policyVersions).where(eq(policyVersions.tenantId, tenantA)),
    });
  const publishedVersions = async (brandId: string) =>
    tdb.db
      .select()
      .from(brandVersions)
      .where(and(eq(brandVersions.brandId, brandId), eq(brandVersions.state, 'published')));
  const eventsOf = async (type: string) =>
    tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, type)));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'brand-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'brand-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      {
        id: brandA,
        tenantId: tenantA,
        name: 'A1',
        timezone: 'Africa/Harare',
        defaultLocale: 'en',
        status: 'active',
      },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'setup' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    // Tenant B has a draft version and a proposed fact of its own, for the foreign-id checks.
    versionBOfB = (
      await run(tenantB, (tx) => brandService.versions.createDraft(manager(tenantB), { brandId: brandB }, tx))
    ).versionId;
    factBOfB = (
      await run(tenantB, (tx) =>
        brandService.facts.propose(
          manager(tenantB),
          { brandId: brandB, kind: 'claim', statement: 'B', evidence },
          tx,
        ),
      )
    ).factId;
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  describe('version lifecycle (spec 8.2)', () => {
    it('a first draft starts from the empty document with number 1 and a canonical content hash', async () => {
      const created = await run(tenantA, (tx) =>
        brandService.versions.createDraft(A, { brandId: brandA }, tx),
      );
      v1 = created.versionId;
      expect(created.number).toBe(1);
      const got = await runInTenant(ctx(tenantA), () =>
        brandService.versions.get(A, { brandId: brandA, versionId: v1 }),
      );
      expect(got.state).toBe('draft');
      expect(got.document).toEqual(emptyBrandSystemDocument());
      expect(got.contentHash).toBe(hashCanonical(emptyBrandSystemDocument()));
    });

    it('update validates the document, recomputes the hash and bumps version; a stale expectedVersion is CONFLICT', async () => {
      const updated = await run(tenantA, (tx) =>
        brandService.versions.update(
          A,
          { brandId: brandA, versionId: v1, expectedVersion: 0, document: document() },
          tx,
        ),
      );
      expect(updated.version).toBe(1);
      expect(updated.contentHash).toBe(hashCanonical(document()));
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.update(
            A,
            { brandId: brandA, versionId: v1, expectedVersion: 0, document: document() },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.update(
            A,
            {
              brandId: brandA,
              versionId: v1,
              expectedVersion: 1,
              document: { ...document(), schemaVersion: 2 } as never,
            },
            tx,
          ),
        ),
      ).rejects.toThrow();
    });

    it('a draft cannot be published without review; submit → publish sets exactly one published version, its tokens and the event', async () => {
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.publish(A, { brandId: brandA, versionId: v1, expectedVersion: 1 }, tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const submitted = await run(tenantA, (tx) =>
        brandService.versions.submitForReview(A, { brandId: brandA, versionId: v1, expectedVersion: 1 }, tx),
      );
      expect(submitted.state).toBe('in_review');
      const published = await run(tenantA, (tx) =>
        brandService.versions.publish(A, { brandId: brandA, versionId: v1, expectedVersion: 2 }, tx),
      );
      expect(published.state).toBe('published');
      expect((await publishedVersions(brandA)).map((v) => v.id)).toEqual([v1]);
      const brand = (await tdb.db.select().from(brands).where(eq(brands.id, brandA)))[0]!;
      expect(brand.publishedVersionId).toBe(v1);
      const tokens = (
        await tdb.db.select().from(designTokens).where(eq(designTokens.brandVersionId, v1))
      )[0]!;
      expect(tokens.tokenSet).toEqual({
        schemaVersion: 1,
        colour: { ink: '#172120', paper: '#F4F6F3' },
        typeRoles: { body: { fontAssetId: 'ast_font', weight: 400, minSizePx: 16 } },
        spacing: [4, 8, 16],
        radius: [0, 4],
      });
      const events = await eventsOf('brand.version_published');
      expect(events.length).toBe(1);
      expect(events[0]!.aggregateId).toBe(v1);
      expect(events[0]!.payload).toMatchObject({
        brandVersionId: v1,
        brandId: brandA,
        number: 1,
        previousVersionId: null,
      });
      expect(events[0]!.correlationId).toBe('corr_brand');
    });

    it('a second draft starts from the published document; publishing it retires the previous one and touches no other table', async () => {
      // Approved work exists before the second publish.
      const fact = await run(tenantA, (tx) =>
        brandService.facts.propose(
          A,
          { brandId: brandA, kind: 'claim', statement: 'Made in Harare', evidence },
          tx,
        ),
      );
      await run(tenantA, (tx) =>
        brandService.facts.approve(A, { brandId: brandA, factId: fact.factId, expectedVersion: 0 }, tx),
      );
      const created = await run(tenantA, (tx) =>
        brandService.versions.createDraft(A, { brandId: brandA }, tx),
      );
      v2 = created.versionId;
      expect(created.number).toBe(2);
      const draft = await runInTenant(ctx(tenantA), () =>
        brandService.versions.get(A, { brandId: brandA, versionId: v2 }),
      );
      expect(draft.document).toEqual(document());
      await run(tenantA, (tx) =>
        brandService.versions.update(
          A,
          { brandId: brandA, versionId: v2, expectedVersion: 0, document: document('Warm') },
          tx,
        ),
      );
      await run(tenantA, (tx) =>
        brandService.versions.submitForReview(A, { brandId: brandA, versionId: v2, expectedVersion: 1 }, tx),
      );
      const before = await otherRows();
      await run(tenantA, (tx) =>
        brandService.versions.publish(A, { brandId: brandA, versionId: v2, expectedVersion: 2 }, tx),
      );
      expect(await otherRows()).toBe(before);
      expect((await publishedVersions(brandA)).map((v) => v.id)).toEqual([v2]);
      const old = (await tdb.db.select().from(brandVersions).where(eq(brandVersions.id, v1)))[0]!;
      expect(old.state).toBe('retired');
      expect((await tdb.db.select().from(brands).where(eq(brands.id, brandA)))[0]!.publishedVersionId).toBe(
        v2,
      );
      const events = await eventsOf('brand.version_published');
      expect(events.length).toBe(2);
      expect(events.find((e) => e.aggregateId === v2)!.payload).toMatchObject({
        previousVersionId: v1,
        number: 2,
      });
    });

    it('published and retired versions cannot be edited (policy resource_state); illegal transitions are rejected', async () => {
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.update(
            A,
            { brandId: brandA, versionId: v2, expectedVersion: 3, document: document('x') },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'resource_state' });
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.submitForReview(
            A,
            { brandId: brandA, versionId: v1, expectedVersion: 3 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.publish(A, { brandId: brandA, versionId: v1, expectedVersion: 3 }, tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.publish(A, { brandId: brandA, versionId: v2, expectedVersion: 3 }, tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect((await publishedVersions(brandA)).length).toBe(1);
    });

    it('an agent can never publish a version', async () => {
      const created = await run(tenantA, (tx) =>
        brandService.versions.createDraft(A, { brandId: brandA }, tx),
      );
      await run(tenantA, (tx) =>
        brandService.versions.submitForReview(
          A,
          { brandId: brandA, versionId: created.versionId, expectedVersion: 0 },
          tx,
        ),
      );
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.publish(
            agent(tenantA),
            { brandId: brandA, versionId: created.versionId, expectedVersion: 1 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      expect((await publishedVersions(brandA)).map((v) => v.id)).toEqual([v2]);
    });

    it('versions.list paginates newest first with an opaque cursor', async () => {
      const first = await runInTenant(ctx(tenantA), () =>
        brandService.versions.list(A, { brandId: brandA, page: { limit: 2 } }),
      );
      expect(first.items.length).toBe(2);
      expect(first.items[1]!.id).toBe(v2);
      expect(first.nextCursor).not.toBeNull();
      const second = await runInTenant(ctx(tenantA), () =>
        brandService.versions.list(A, { brandId: brandA, page: { limit: 2, cursor: first.nextCursor! } }),
      );
      expect(second.items.map((v) => v.id)).toEqual([v1]);
      expect(second.nextCursor).toBeNull();
      expect('document' in first.items[0]!).toBe(false);
    });
  });

  describe('facts and the brand snapshot (spec 8.3)', () => {
    let baseHash = '';
    const resolve = () =>
      runInTenant(ctx(tenantA), () => brandService.resolveBrandSnapshot(A, { brandId: brandA }));

    it('a brand without a published version has no snapshot', async () => {
      await expect(
        runInTenant(ctx(tenantA), () => brandService.resolveBrandSnapshot(A, { brandId: brandA2 })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('the snapshot is deterministic and records the published version, the effective facts and the default policy', async () => {
      const a = await resolve();
      const b = await resolve();
      expect(a).toEqual(b);
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.brandVersionId).toBe(v2);
      expect(a.brandVersionNumber).toBe(2);
      expect(a.document.voice.summary).toBe('Warm');
      expect(a.facts.map((f) => f.statement)).toEqual(['Made in Harare']);
      expect(a.policyVersionId).toBeNull();
      expect(a.policy.holdOnDependencyRevocation).toBe(true);
      expect(a.eligibleTemplateVersionIds).toEqual([]);
      expect(a.timezone).toBe('Africa/Harare');
      const specific = await runInTenant(ctx(tenantA), () =>
        brandService.resolveBrandSnapshot(A, { brandId: brandA, versionId: v1 }),
      );
      expect(specific.brandVersionId).toBe(v1);
      expect(specific.hash).not.toBe(a.hash);
      baseHash = a.hash;
    });

    it('eligible template versions come from the registered source (sorted) and change the hash', async () => {
      const asked: string[] = [];
      registerEligibleTemplateSource(async (brandId, tx) => {
        asked.push(brandId);
        expect(tx).toBeUndefined(); // the resolver's caller passed no transaction; the source gets the same
        return ['tv_02', 'tv_01'];
      });
      try {
        const withTemplates = await resolve();
        expect(asked).toEqual([brandA]);
        expect(withTemplates.eligibleTemplateVersionIds).toEqual(['tv_01', 'tv_02']);
        expect(withTemplates.hash).not.toBe(baseHash);
      } finally {
        resetEligibleTemplateSource();
      }
      expect((await resolve()).hash).toBe(baseHash);
    });

    it('a proposed fact is not in the snapshot; approving it changes the hash; approving twice is rejected', async () => {
      const fact = await run(tenantA, (tx) =>
        brandService.facts.propose(
          A,
          { brandId: brandA, kind: 'contact', statement: '+263 ...', evidence },
          tx,
        ),
      );
      expect((await resolve()).hash).toBe(baseHash);
      await run(tenantA, (tx) =>
        brandService.facts.approve(A, { brandId: brandA, factId: fact.factId, expectedVersion: 0 }, tx),
      );
      const after = await resolve();
      expect(after.hash).not.toBe(baseHash);
      expect(after.facts.map((f) => f.id)).toContain(fact.factId);
      expect((await resolve()).hash).toBe(after.hash);
      await expect(
        run(tenantA, (tx) =>
          brandService.facts.approve(A, { brandId: brandA, factId: fact.factId, expectedVersion: 1 }, tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const row = (await tdb.db.select().from(approvedFacts).where(eq(approvedFacts.id, fact.factId)))[0]!;
      expect(row.approvedByUserId).toBe(USER);
      expect(row.proposedByKind).toBe('user');
      baseHash = after.hash;
    });

    it('expired or not-yet-valid offers are excluded; a bad window is rejected', async () => {
      const now = Date.now();
      const expired = await run(tenantA, (tx) =>
        brandService.facts.propose(
          A,
          {
            brandId: brandA,
            kind: 'offer',
            statement: 'Expired offer',
            evidence,
            validFrom: new Date(now - 48 * HOUR).toISOString(),
            validUntil: new Date(now - HOUR).toISOString(),
          },
          tx,
        ),
      );
      await run(tenantA, (tx) =>
        brandService.facts.approve(A, { brandId: brandA, factId: expired.factId, expectedVersion: 0 }, tx),
      );
      const future = await run(tenantA, (tx) =>
        brandService.facts.propose(
          A,
          {
            brandId: brandA,
            kind: 'offer',
            statement: 'Future offer',
            evidence,
            validFrom: new Date(now + HOUR).toISOString(),
          },
          tx,
        ),
      );
      await run(tenantA, (tx) =>
        brandService.facts.approve(A, { brandId: brandA, factId: future.factId, expectedVersion: 0 }, tx),
      );
      const s = await resolve();
      expect(s.hash).toBe(baseHash);
      expect(s.facts.map((f) => f.statement)).not.toContain('Expired offer');
      expect(s.facts.map((f) => f.statement)).not.toContain('Future offer');
      await expect(
        run(tenantA, (tx) =>
          brandService.facts.propose(
            A,
            {
              brandId: brandA,
              kind: 'offer',
              statement: 'Backwards',
              evidence,
              validFrom: new Date(now).toISOString(),
              validUntil: new Date(now - HOUR).toISOString(),
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const approved = await runInTenant(ctx(tenantA), () =>
        brandService.facts.list(A, { brandId: brandA, state: 'approved', page: { limit: 50 } }),
      );
      expect(approved.items.every((f) => f.state === 'approved')).toBe(true);
      expect(approved.items.length).toBe(4);
    });

    it('revoking a valid offer emits brand.fact_revoked with the fact id and restores the previous hash', async () => {
      const now = Date.now();
      const offer = await run(tenantA, (tx) =>
        brandService.facts.propose(
          A,
          {
            brandId: brandA,
            kind: 'offer',
            statement: '20% off',
            evidence,
            validFrom: new Date(now - HOUR).toISOString(),
            validUntil: new Date(now + 24 * HOUR).toISOString(),
          },
          tx,
        ),
      );
      await run(tenantA, (tx) =>
        brandService.facts.approve(A, { brandId: brandA, factId: offer.factId, expectedVersion: 0 }, tx),
      );
      const withOffer = await resolve();
      expect(withOffer.hash).not.toBe(baseHash);
      expect(withOffer.facts.map((f) => f.id)).toContain(offer.factId);
      await expect(
        run(tenantA, (tx) =>
          brandService.facts.revoke(
            agent(tenantA),
            { brandId: brandA, factId: offer.factId, expectedVersion: 1 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const revoked = await run(tenantA, (tx) =>
        brandService.facts.revoke(
          A,
          { brandId: brandA, factId: offer.factId, expectedVersion: 1, reason: 'offer withdrawn' },
          tx,
        ),
      );
      expect(revoked.state).toBe('revoked');
      expect((await resolve()).hash).toBe(baseHash);
      const events = await eventsOf('brand.fact_revoked');
      expect(events.length).toBe(1);
      expect(events[0]!.aggregateId).toBe(offer.factId);
      expect(events[0]!.payload).toMatchObject({
        factId: offer.factId,
        brandId: brandA,
        kind: 'offer',
        previousState: 'approved',
        reason: 'offer withdrawn',
      });
      await expect(
        run(tenantA, (tx) =>
          brandService.facts.revoke(A, { brandId: brandA, factId: offer.factId, expectedVersion: 2 }, tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(
        (await tdb.db.select().from(approvedFacts).where(eq(approvedFacts.id, offer.factId)))[0]!
          .revokedByUserId,
      ).toBe(USER);
    });

    it('foreign or mismatched ids are NOT_FOUND, never data, and nothing is written', async () => {
      const before = JSON.stringify(
        await tdb.db.select().from(brandVersions).where(eq(brandVersions.tenantId, tenantB)),
      );
      // Tenant B's ids used from tenant A.
      await expect(
        runInTenant(ctx(tenantA), () =>
          brandService.versions.get(A, { brandId: brandB, versionId: versionBOfB }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.publish(
            A,
            { brandId: brandB, versionId: versionBOfB, expectedVersion: 0 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          brandService.facts.approve(A, { brandId: brandB, factId: factBOfB, expectedVersion: 0 }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Own brand + a foreign version id.
      await expect(
        run(tenantA, (tx) =>
          brandService.versions.publish(
            A,
            { brandId: brandA, versionId: versionBOfB, expectedVersion: 0 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Two brands of the same tenant: a version of A1 through A2 is NOT_FOUND.
      await expect(
        runInTenant(ctx(tenantA), () => brandService.versions.get(A, { brandId: brandA2, versionId: v2 })),
      ).rejects.toBeInstanceOf(NotFoundError);
      // A restricted actor (brand A2 only) cannot see brand A1's versions or snapshot.
      await expect(
        runInTenant(ctx(tenantA, new Set([brandA2])), () =>
          brandService.versions.get(A, { brandId: brandA, versionId: v2 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runInTenant(ctx(tenantA, new Set([brandA2])), () =>
          brandService.resolveBrandSnapshot(A, { brandId: brandA }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        JSON.stringify(await tdb.db.select().from(brandVersions).where(eq(brandVersions.tenantId, tenantB))),
      ).toBe(before);
      // Tenant B still reaches its own rows.
      const own = await runInTenant(ctx(tenantB), () =>
        brandService.versions.get(manager(tenantB), { brandId: brandB, versionId: versionBOfB }),
      );
      expect(own.state).toBe('draft');
    });
  });

  describe('objectives and policy versions', () => {
    const resolve = () =>
      runInTenant(ctx(tenantA), () => brandService.resolveBrandSnapshot(A, { brandId: brandA }));

    it('objectives.set closes the previous objective and changes the snapshot hash', async () => {
      const h0 = (await resolve()).hash;
      const o1 = await run(tenantA, (tx) =>
        brandService.objectives.set(
          A,
          {
            brandId: brandA,
            name: 'Enquiries',
            primaryMetricKey: 'qualified_enquiries',
            guardrailMetricKeys: ['unfollows'],
            activeFrom: new Date(Date.now() - 2 * HOUR).toISOString(),
          },
          tx,
        ),
      );
      expect(o1.closedObjectiveIds).toEqual([]);
      const h1 = (await resolve()).hash;
      expect(h1).not.toBe(h0);
      const from2 = new Date(Date.now() - HOUR);
      const o2 = await run(tenantA, (tx) =>
        brandService.objectives.set(
          A,
          {
            brandId: brandA,
            name: 'Bookings',
            primaryMetricKey: 'bookings',
            guardrailMetricKeys: [],
            activeFrom: from2.toISOString(),
          },
          tx,
        ),
      );
      expect(o2.closedObjectiveIds).toEqual([o1.objectiveId]);
      const closed = (
        await tdb.db.select().from(brandObjectives).where(eq(brandObjectives.id, o1.objectiveId))
      )[0]!;
      expect(closed.activeUntil?.getTime()).toBe(from2.getTime());
      const active = await runInTenant(ctx(tenantA), () =>
        brandService.objectives.list(A, { brandId: brandA, activeOnly: true, page: { limit: 50 } }),
      );
      expect(active.items.map((o) => o.id)).toEqual([o2.objectiveId]);
      const all = await runInTenant(ctx(tenantA), () =>
        brandService.objectives.list(A, { brandId: brandA, activeOnly: false, page: { limit: 50 } }),
      );
      expect(all.items.length).toBe(2);
      const s = await resolve();
      expect(s.objectives.map((o) => o.id)).toEqual([o2.objectiveId]);
      expect(s.hash).not.toBe(h1);
      await expect(
        run(tenantA, (tx) =>
          brandService.objectives.set(
            A,
            {
              brandId: brandA,
              name: 'Bad',
              primaryMetricKey: 'x',
              guardrailMetricKeys: [],
              activeFrom: new Date().toISOString(),
              activeUntil: new Date(Date.now() - HOUR).toISOString(),
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('policy versions: create, activate (retiring the previous), get; the snapshot records the active policy', async () => {
      const h0 = (await resolve()).hash;
      await expect(
        runInTenant(ctx(tenantA), () => brandService.policy.get(A, { brandId: brandA })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          brandService.policy.createVersion(
            agent(tenantA),
            { brandId: brandA, document: defaultPolicyDocument() },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const p1 = await run(tenantA, (tx) =>
        brandService.policy.createVersion(
          A,
          {
            brandId: brandA,
            document: { ...defaultPolicyDocument(), prohibitedTerms: ['cheap'] },
          },
          tx,
        ),
      );
      expect(p1.number).toBe(1);
      expect((await resolve()).hash).toBe(h0); // a draft policy changes nothing
      await expect(
        run(tenantA, (tx) =>
          brandService.policy.activate(
            A,
            { brandId: brandA, policyVersionId: p1.policyVersionId, expectedVersion: 9 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      await run(tenantA, (tx) =>
        brandService.policy.activate(
          A,
          { brandId: brandA, policyVersionId: p1.policyVersionId, expectedVersion: 0 },
          tx,
        ),
      );
      const active = await runInTenant(ctx(tenantA), () => brandService.policy.get(A, { brandId: brandA }));
      expect(active.id).toBe(p1.policyVersionId);
      expect(active.state).toBe('active');
      expect(active.document.prohibitedTerms).toEqual(['cheap']);
      expect(active.document.holdOnDependencyRevocation).toBe(true);
      expect(
        (await tdb.db.select().from(brands).where(eq(brands.id, brandA)))[0]!.activePolicyVersionId,
      ).toBe(p1.policyVersionId);
      const s1 = await resolve();
      expect(s1.policyVersionId).toBe(p1.policyVersionId);
      expect(s1.policy.prohibitedTerms).toEqual(['cheap']);
      expect(s1.hash).not.toBe(h0);
      const p2 = await run(tenantA, (tx) =>
        brandService.policy.createVersion(
          A,
          {
            brandId: brandA,
            document: { ...defaultPolicyDocument(), holdOnDependencyRevocation: false },
          },
          tx,
        ),
      );
      expect(p2.number).toBe(2);
      await run(tenantA, (tx) =>
        brandService.policy.activate(
          A,
          { brandId: brandA, policyVersionId: p2.policyVersionId, expectedVersion: 0 },
          tx,
        ),
      );
      const rows = await tdb.db.select().from(policyVersions).where(eq(policyVersions.brandId, brandA));
      expect(rows.find((r) => r.id === p1.policyVersionId)!.state).toBe('retired');
      expect(rows.filter((r) => r.state === 'active').map((r) => r.id)).toEqual([p2.policyVersionId]);
      expect(
        (await runInTenant(ctx(tenantA), () => brandService.policy.get(A, { brandId: brandA }))).id,
      ).toBe(p2.policyVersionId);
      const s2 = await resolve();
      expect(s2.policy.holdOnDependencyRevocation).toBe(false);
      expect(s2.hash).not.toBe(s1.hash);
      await expect(
        run(tenantA, (tx) =>
          brandService.policy.activate(
            A,
            { brandId: brandA, policyVersionId: p1.policyVersionId, expectedVersion: 2 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const specific = await runInTenant(ctx(tenantA), () =>
        brandService.policy.get(A, { brandId: brandA, policyVersionId: p1.policyVersionId }),
      );
      expect(specific.state).toBe('retired');
    });

    it('every mutation left an allowed audit event in the command transaction', async () => {
      const rows = await tdb.db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantA));
      const actions = new Set(rows.filter((r) => r.decision === 'allowed').map((r) => r.action));
      for (const a of [
        'brand.version.create_draft',
        'brand.version.update',
        'brand.version.submit_for_review',
        'brand.version.publish',
        'brand.fact.propose',
        'brand.fact.approve',
        'brand.fact.revoke',
        'brand.objective.set',
        'brand.policy.create_version',
        'brand.policy.activate',
      ])
        expect(actions.has(a), a).toBe(true);
      expect(rows.every((r) => r.correlationId === 'corr_brand')).toBe(true);
      const revoke = rows.find((r) => r.action === 'brand.fact.revoke')!;
      expect(revoke.metadata).toMatchObject({
        fromState: 'approved',
        toState: 'revoked',
        reason: 'offer withdrawn',
      });
    });
  });

  describe('brand kit references (logos, palette, reference imagery)', () => {
    const brandKit = newId('brand');
    let draft = '';
    let version = 0;
    const asked: Array<{ brandId: string; ids: string[] }> = [];
    const kit = (over: Partial<BrandSystemDocumentV1> = {}): BrandSystemDocumentV1 => ({
      ...document(),
      logoRules: [
        {
          assetId: 'ast_logo',
          variant: 'primary',
          allowedBackgroundColourKeys: ['paper'],
          clearSpaceRatio: 0.5,
          minWidthPx: 96,
        },
      ],
      patterns: [
        {
          key: 'reference-imagery',
          description: 'Site photography',
          exampleAssetIds: ['ast_photo'],
          templateVersionIds: [],
        },
      ],
      ...over,
    });
    const save = (doc: BrandSystemDocumentV1) =>
      run(tenantA, (tx) =>
        brandService.versions.update(
          A,
          { brandId: brandKit, versionId: draft, expectedVersion: version, document: doc },
          tx,
        ),
      );
    const issuesOf = async (doc: BrandSystemDocumentV1) => {
      const err = await save(doc).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationFailedError);
      return (err as ValidationFailedError).details?.map((d) => `${d.path} ${d.issue}`);
    };

    beforeAll(async () => {
      await tdb.db.insert(brands).values({
        id: brandKit,
        tenantId: tenantA,
        name: 'Kit',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'setup',
      });
      draft = (await run(tenantA, (tx) => brandService.versions.createDraft(A, { brandId: brandKit }, tx)))
        .versionId;
      registerBrandAssetKindSource(async (brandId, ids) => {
        asked.push({ brandId, ids });
        const own = new Map([
          ['ast_logo', 'logo'],
          ['ast_photo', 'photo'],
        ] as const);
        return new Map(ids.flatMap((id) => (own.has(id as never) ? [[id, own.get(id as never)!]] : [])));
      });
    });
    afterAll(() => resetBrandAssetKindSource());

    it('saves a draft whose logos and reference images are assets of this brand', async () => {
      const saved = await save(kit());
      version = saved.version;
      expect(asked.at(-1)).toEqual({ brandId: brandKit, ids: ['ast_logo', 'ast_photo'] });
      const got = await runInTenant(ctx(tenantA), () =>
        brandService.versions.get(A, { brandId: brandKit, versionId: draft }),
      );
      expect(got.document.logoRules[0]).toMatchObject({ assetId: 'ast_logo', variant: 'primary' });
      expect(got.document.patterns[0]!.exampleAssetIds).toEqual(['ast_photo']);
    });

    it('rejects every bad reference at once and writes nothing', async () => {
      const issues = await issuesOf(
        kit({
          tokens: {
            ...document().tokens,
            colours: [
              { key: 'ink', value: 'blue', role: 'text' },
              { key: 'ink', value: '#FFF', role: 'background' },
            ],
          },
          logoRules: [
            {
              assetId: 'ast_photo',
              variant: 'mono',
              allowedBackgroundColourKeys: ['paper'],
              clearSpaceRatio: 0.5,
              minWidthPx: 96,
            },
          ],
          patterns: [
            { key: 'refs', description: '', exampleAssetIds: ['ast_other_brand'], templateVersionIds: [] },
          ],
        }),
      );
      expect(issues).toEqual([
        'tokens.colours.0.value not_a_hex_colour',
        'tokens.colours.1.key duplicate_key',
        'logoRules.0.assetId not_a_logo_of_this_brand',
        'logoRules.0.allowedBackgroundColourKeys.0 unknown_colour_key',
        'patterns.0.exampleAssetIds.0 not_an_asset_of_this_brand',
      ]);
      const got = await runInTenant(ctx(tenantA), () =>
        brandService.versions.get(A, { brandId: brandKit, versionId: draft }),
      );
      expect(got.version).toBe(version);
    });

    it('without a registered asset source a draft naming assets is refused (fail closed)', async () => {
      resetBrandAssetKindSource();
      try {
        expect(await issuesOf(kit())).toEqual([
          'logoRules.0.assetId not_a_logo_of_this_brand',
          'patterns.0.exampleAssetIds.0 not_an_asset_of_this_brand',
        ]);
        // A document with no asset references never consults the source.
        const saved = await save(document());
        version = saved.version;
      } finally {
        registerBrandAssetKindSource(async () => new Map());
      }
    });
  });

  describe('brand skill import (guidelines, separation of duties)', () => {
    const brandSkill = newId('brand');
    const importer = manager(tenantA);
    const approver: ResolvedActor = {
      kind: 'user',
      id: 'usr_brand_approver',
      tenantId: tenantA,
      membershipId: 'mem_brand_approver',
      membershipStatus: 'active',
      role: 'brand_manager',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    const skillFiles = [
      {
        path: 'harbour-brand/SKILL.md',
        content:
          '---\nname: harbour-brand\ndescription: Harbour brand system.\n---\n# Harbour\n\n| Token | Value | Use |\n|---|---|---|\n| Primary | Deep Navy `#1a2a4d` | Headings |\n| Text | Ink `#172120` | Body copy |\n',
      },
      { path: 'harbour-brand/references/tone.md', content: '# Tone\nDirect, precise, never loud.' },
      { path: 'harbour-brand/assets/logo.svg', content: '<svg/>' },
    ];
    const versionOf = (versionId: string) =>
      runInTenant(ctx(tenantA), () =>
        brandService.versions.get(importer, { brandId: brandSkill, versionId }),
      );
    const toReview = async (versionId: string) => {
      const v = await versionOf(versionId);
      await run(tenantA, (tx) =>
        brandService.versions.submitForReview(
          importer,
          { brandId: brandSkill, versionId, expectedVersion: v.version },
          tx,
        ),
      );
      return (await versionOf(versionId)).version;
    };
    const publishAs = async (actor: ResolvedActor, versionId: string, expectedVersion: number) =>
      run(tenantA, (tx) =>
        brandService.versions.publish(actor, { brandId: brandSkill, versionId, expectedVersion }, tx),
      );
    let imported = '';

    beforeAll(async () => {
      await tdb.db.insert(brands).values({
        id: brandSkill,
        tenantId: tenantA,
        name: 'Harbour',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'setup',
      });
    });

    it('imports a skill as a new draft with its guidelines and the palette its tables state', async () => {
      const res = await run(tenantA, (tx) =>
        brandService.guidelines.import(importer, { brandId: brandSkill, files: skillFiles }, tx),
      );
      imported = res.versionId;
      expect(res).toMatchObject({
        number: 1,
        documents: ['SKILL.md', 'references/tone.md'],
        coloursAdded: 2,
        skipped: [{ path: 'assets/logo.svg', reason: 'not_text' }],
      });
      const draft = await versionOf(imported);
      expect(draft.state).toBe('draft');
      expect(draft.document.guidelines?.source.name).toBe('harbour-brand');
      expect(draft.document.tokens.colours).toEqual([
        { key: 'primary', value: '#1A2A4D', role: 'primary' },
        { key: 'text', value: '#172120', role: 'text' },
      ]);
    });

    it('the importer cannot publish it; another person can, and agents then receive the guidelines', async () => {
      const expected = await toReview(imported);
      await expect(publishAs(importer, imported, expected)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        reason: 'distinct_approver_required',
      });
      await publishAs(approver, imported, expected);
      const snapshot = await runInTenant(ctx(tenantA), () =>
        brandService.resolveBrandSnapshot(importer, { brandId: brandSkill }),
      );
      expect(snapshot.document.guidelines?.documents.map((d) => d.path)).toEqual([
        'SKILL.md',
        'references/tone.md',
      ]);
    });

    it('an edit to the guidelines makes the editor their author; palette-only edits and unchanged guidelines do not', async () => {
      const draft = await run(tenantA, (tx) =>
        brandService.versions.createDraft(approver, { brandId: brandSkill }, tx),
      );
      const base = (await versionOf(draft.versionId)).document;
      // Unchanged guidelines (carried from the published version): the approver may publish their own palette edit.
      await run(tenantA, (tx) =>
        brandService.versions.update(
          approver,
          {
            brandId: brandSkill,
            versionId: draft.versionId,
            expectedVersion: 0,
            document: { ...base, voice: { ...base.voice, summary: 'Direct.' } },
          },
          tx,
        ),
      );
      // Now the approver edits the guidelines themselves: they become the author and may not publish.
      const edited = {
        ...base,
        guidelines: {
          ...base.guidelines!,
          documents: [...base.guidelines!.documents, { path: 'references/extra.md', content: '# More' }],
        },
      };
      await run(tenantA, (tx) =>
        brandService.versions.update(
          approver,
          { brandId: brandSkill, versionId: draft.versionId, expectedVersion: 1, document: edited },
          tx,
        ),
      );
      const expected = await toReview(draft.versionId);
      await expect(publishAs(approver, draft.versionId, expected)).rejects.toMatchObject({
        reason: 'distinct_approver_required',
      });
      await publishAs(importer, draft.versionId, expected);
    });

    it('removing guidelines needs no second person; an agent cannot import', async () => {
      const draft = await run(tenantA, (tx) =>
        brandService.versions.createDraft(importer, { brandId: brandSkill }, tx),
      );
      const { guidelines: _g, ...withoutGuidelines } = (await versionOf(draft.versionId)).document;
      await run(tenantA, (tx) =>
        brandService.versions.update(
          importer,
          {
            brandId: brandSkill,
            versionId: draft.versionId,
            expectedVersion: 0,
            document: withoutGuidelines,
          },
          tx,
        ),
      );
      await publishAs(importer, draft.versionId, await toReview(draft.versionId));
      await expect(
        run(tenantA, (tx) =>
          brandService.guidelines.import(agent(tenantA), { brandId: brandSkill, files: skillFiles }, tx),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('onboarding: voice and vocabulary proposed from imported guidelines (spec 8.2)', () => {
    const brandOnb = newId('brand');
    const person = manager(tenantA);
    const sp = agent(tenantA);
    const longReference = `# Vocabulary\n${'Say roast, not blend. '.repeat(1200)}`; // > 20000 characters: two evidence items
    const files = [
      {
        path: 'SKILL.md',
        content:
          '---\nname: kiln-brand\ndescription: Kiln.\n---\n# Kiln\nWarm and plain. Never write "artisanal".\n',
      },
      { path: 'references/words.md', content: longReference },
    ];
    /** A stand-in for the agents module: runs keep the brief exactly as the brand module wrote it. */
    const runs = new Map<string, { brandId: string; taskKind: string; brief: Record<string, unknown> }>();
    const source: OnboardingRunSource = {
      async start(_actor, input) {
        const runId = `run_${runs.size + 1}`;
        runs.set(runId, { brandId: input.brandId, taskKind: 'brand_onboarding', brief: input.brief });
        return { runId, state: 'planned', autonomyMode: 'create', workflowId: `run:${runId}` };
      },
      async get(_actor, runId) {
        const r = runs.get(runId);
        if (!r) throw new NotFoundError('AgentRun', runId);
        return { ...r, state: 'running' };
      },
    };
    const proposal = {
      summary: 'Warm and plain.',
      tone: ['warm', 'plain'],
      audiences: [{ key: 'regulars', description: 'Weekly buyers' }],
      preferredTerms: [{ use: 'roast', avoid: ['blend'] }],
      prohibitedPhrases: ['artisanal'],
      locales: ['en-GB'],
      examples: [{ text: 'This week: a Chipinge roast.', verdict: 'on_brand' as const, note: 'plain' }],
    };
    const versionOf = (versionId: string) =>
      runInTenant(ctx(tenantA), () => brandService.versions.get(person, { brandId: brandOnb, versionId }));
    const start = (versionId: string, over: Partial<{ websiteUrls: string[] }> = {}) =>
      run(tenantA, (tx) =>
        brandService.startOnboarding(
          person,
          {
            brandId: brandOnb,
            versionId,
            servicePrincipalId: 'sp_brand_test',
            sourceAssetIds: [],
            websiteUrls: [],
            ...over,
          },
          tx,
        ),
      );
    const propose = (runId: string, voice = proposal) =>
      run(tenantA, (tx) =>
        brandService.proposeVoice(sp, { brandId: brandOnb, runId, voice }, tx, { autonomyMode: 'create' }),
      );
    let draftId = '';

    beforeAll(async () => {
      await tdb.db.insert(brands).values({
        id: brandOnb,
        tenantId: tenantA,
        name: 'Kiln',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'setup',
      });
      draftId = (
        await run(tenantA, (tx) => brandService.guidelines.import(person, { brandId: brandOnb, files }, tx))
      ).versionId;
    });
    afterAll(() => resetOnboardingRunSource());

    it('a brand with nothing published has an empty approved baseline, never its draft', async () => {
      const baseline = await runInTenant(ctx(tenantA), () =>
        brandService.resolveBaselineSnapshot(sp, { brandId: brandOnb }),
      );
      expect(baseline).toMatchObject({ brandVersionId: 'unpublished', brandVersionNumber: 0 });
      expect(baseline.document).toEqual(emptyBrandSystemDocument());
      await expect(
        runInTenant(ctx(tenantA), () => brandService.resolveBrandSnapshot(sp, { brandId: brandOnb })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('refuses without a run source, website captures, and a draft without guidelines; nothing is started', async () => {
      await expect(start(draftId)).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'not_available_yet' });
      registerOnboardingRunSource(source);
      await expect(start(draftId, { websiteUrls: ['https://kiln.example/'] })).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
      const bare = await run(tenantA, (tx) =>
        brandService.versions.createDraft(person, { brandId: brandOnb }, tx),
      );
      await expect(start(bare.versionId)).rejects.toBeInstanceOf(ValidationFailedError);
      expect(runs.size).toBe(0);
    });

    it('starts a run whose brief names the draft, the voice it starts from and the guidelines as untrusted evidence', async () => {
      const started = await start(draftId);
      expect(started).toMatchObject({ runId: 'run_1', versionId: draftId });
      const brief = runs.get('run_1')!.brief;
      const draft = await versionOf(draftId);
      expect(brief).toMatchObject({
        brandVersionId: draftId,
        baseVoiceHash: hashCanonical(draft.document.voice),
      });
      const items = brief['evidence'] as Array<{
        id: string;
        sourceKind: string;
        ref: string;
        trust: string;
        text: string;
      }>;
      expect(items.map((e) => e.ref)).toEqual([
        'guidelines:SKILL.md',
        'guidelines:references/words.md',
        'guidelines:references/words.md',
      ]);
      expect(items.every((e) => e.sourceKind === 'guideline_document' && e.trust === 'untrusted')).toBe(true);
      expect(items.every((e) => e.text.length <= 20_000)).toBe(true);
      expect(items[1]!.text + items[2]!.text).toBe(longReference);
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'brand.onboarding.start')));
      expect(audits.map((a) => a.resourceId)).toContain(draftId);
    });

    it('the run proposes the voice into that draft only; guidelines and palette are untouched; a second proposal is refused', async () => {
      const before = await versionOf(draftId);
      const written = await propose('run_1');
      expect(written).toMatchObject({ versionId: draftId, version: before.version + 1 });
      const after = await versionOf(draftId);
      expect(after.state).toBe('draft');
      expect(after.document.voice).toEqual(proposal);
      expect(after.document.guidelines).toEqual(before.document.guidelines);
      expect(after.document.tokens).toEqual(before.document.tokens);
      // The voice is no longer the one the run started from: a repeat never overwrites.
      await expect(propose('run_1', { ...proposal, summary: 'Loud.' })).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
      expect((await versionOf(draftId)).document.voice.summary).toBe('Warm and plain.');
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'brand.version.propose_voice')));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorKind: 'service_principal', resourceId: draftId });
    });

    it("a person's edit made while the run works wins; other runs and unbounded values are refused", async () => {
      await start(draftId); // run_2 starts from the proposed voice
      const current = await versionOf(draftId);
      await run(tenantA, (tx) =>
        brandService.versions.update(
          person,
          {
            brandId: brandOnb,
            versionId: draftId,
            expectedVersion: current.version,
            document: {
              ...current.document,
              voice: { ...current.document.voice, summary: 'Edited by a person.' },
            },
          },
          tx,
        ),
      );
      await expect(propose('run_2')).rejects.toBeInstanceOf(ValidationFailedError);
      expect((await versionOf(draftId)).document.voice.summary).toBe('Edited by a person.');
      runs.set('run_copy', { brandId: brandOnb, taskKind: 'copywriting', brief: runs.get('run_2')!.brief });
      await expect(propose('run_copy')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        reason: 'not_an_onboarding_run',
      });
      await expect(propose('run_2', { ...proposal, tone: Array(13).fill('x') })).rejects.toThrow();
    });
  });
});
