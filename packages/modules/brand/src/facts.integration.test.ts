import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FactSource } from '@oremedia/contracts/brand';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { approvedFacts, brands } from '@oremedia/db/schema/brand';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { factDedupeKey } from '@oremedia/domain/facts';
import { newId } from '@oremedia/domain/ids';
import { createBrandFactSweepRuntime } from './fact-sweep';
import { brandService } from './service';

/**
 * BSC-3 facts workspace against MySQL 8: categories, origin and sources; duplicates; editing a proposal; the
 * approval rule for unsourced AI suggestions; correct (supersede on approval), merge, conflicts, mark reviewed and
 * withdraw, each emitting the impact event where a fact stops applying; the workspace filters; the daily sweep
 * (expiry event exactly once, review-due flag once); and tenant isolation of every command.
 */
const USER = newId('user');
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_facts',
});
const manager = (tenantId: string): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_facts_test',
  membershipStatus: 'active',
  role: 'brand_manager',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const AGENT_ID = 'sp_facts_test';
const agent = (tenantId: string): ResolvedActor => ({
  kind: 'service_principal',
  id: AGENT_ID,
  tenantId,
  status: 'active',
  maxAutonomy: 'create',
  requestAutonomy: 'create',
  grants: [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'brand.edit_standards', brandIds: 'all' },
  ],
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const url: FactSource = {
  kind: 'url',
  ref: 'https://example.test/about',
  title: 'About us',
  excerpt: 'Since 1998',
};

describe('facts workspace (BSC-3) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  let factOfB = '';

  const row = async (id: string) =>
    (await tdb.db.select().from(approvedFacts).where(eq(approvedFacts.id, id)))[0]!;
  const events = async (type: string, factId: string) =>
    (
      await tdb.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.eventType, type), eq(outboxEvents.aggregateId, factId)))
    ).map((e) => e.payload);
  const propose = (statement: string, extra: Record<string, unknown> = {}, actor: ResolvedActor = A) =>
    run(tenantA, (tx) =>
      brandService.facts.propose(actor, { brandId: brandA, category: 'company', statement, ...extra }, tx),
    );
  const approve = (factId: string, version = 0, extra: Record<string, unknown> = {}) =>
    run(tenantA, (tx) =>
      brandService.facts.approve(A, { brandId: brandA, factId, expectedVersion: version, ...extra }, tx),
    );
  const list = (filters: Record<string, unknown> = {}) =>
    runInTenant(ctx(tenantA), () =>
      brandService.facts.list(A, { brandId: brandA, page: { limit: 200 }, ...filters }),
    );
  const effectiveIds = async () => (await list({ effective: true })).items.map((f) => f.id);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'facts-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'facts-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values({ id: USER, email: `facts-${USER}@example.test`, name: 'Rudo Moyo' });
    await tdb.db.insert(memberships).values({
      id: newId('membership'),
      tenantId: tenantA,
      userId: USER,
      role: 'brand_manager',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    factOfB = (
      await run(tenantB, (tx) =>
        brandService.facts.propose(
          manager(tenantB),
          { brandId: brandB, category: 'claim', statement: 'Foreign fact', sources: [url] },
          tx,
        ),
      )
    ).factId;
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('a fact is proposed with category, scope, origin and sources; the kind follows the category; a legacy kind still works', async () => {
    const p = await propose('Founded in Harare in 1998.', {
      category: 'service',
      scope: 'Zimbabwe',
      sources: [url],
    });
    expect(p).toMatchObject({ version: 0, duplicate: false });
    const r = await row(p.factId);
    expect(r).toMatchObject({
      category: 'service',
      kind: 'product',
      scope: 'Zimbabwe',
      origin: 'user',
      dedupeKey: factDedupeKey('founded in harare in 1998'),
      state: 'proposed',
    });
    expect(r.sources).toEqual([url]);
    expect(r.evidence).toEqual([{ kind: 'url', ref: url.ref }]); // titles and excerpts live in sources only
    const legacy = await run(tenantA, (tx) =>
      brandService.facts.propose(
        A,
        {
          brandId: brandA,
          kind: 'price',
          statement: 'From $10 a month',
          evidence: [{ kind: 'other', ref: 'x' }],
        },
        tx,
      ),
    );
    expect(await row(legacy.factId)).toMatchObject({ category: 'price', kind: 'price', origin: 'user' });
    const listed = (await list()).items.find((f) => f.id === p.factId)!;
    expect(listed).toMatchObject({
      category: 'service',
      origin: 'user',
      scope: 'Zimbabwe',
      sources: [url],
      proposedByName: 'Rudo Moyo',
      effective: false,
      conflicts: [],
    });
  });

  it('the same statement (normalised) is not proposed twice: the live fact is returned with duplicate true', async () => {
    const first = await propose('Open seven days a week');
    const again = await propose('  open SEVEN days a week! ');
    expect(again).toEqual({ factId: first.factId, version: 0, duplicate: true });
    const count = (await list({ search: 'seven days' })).items.length;
    expect(count).toBe(1);
  });

  it('a proposed fact is edited; an agent edits only its own proposals; an approved fact is corrected, not edited', async () => {
    const p = await propose('Ships to SADC countries');
    const edited = await run(tenantA, (tx) =>
      brandService.facts.update(
        A,
        {
          brandId: brandA,
          factId: p.factId,
          expectedVersion: 0,
          statement: 'Ships to all SADC countries',
          scope: 'Africa',
        },
        tx,
      ),
    );
    expect(edited.version).toBe(1);
    expect(await row(p.factId)).toMatchObject({
      statement: 'Ships to all SADC countries',
      scope: 'Africa',
      dedupeKey: factDedupeKey('Ships to all SADC countries'),
    });
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.update(
          agent(tenantA),
          { brandId: brandA, factId: p.factId, expectedVersion: 1, scope: null },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    const mine = await propose('Agents wrote this', {}, agent(tenantA));
    await run(tenantA, (tx) =>
      brandService.facts.update(
        agent(tenantA),
        { brandId: brandA, factId: mine.factId, expectedVersion: 0, scope: 'Web' },
        tx,
      ),
    );
    expect((await row(mine.factId)).scope).toBe('Web');
    await approve(p.factId, 1);
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.update(
          A,
          { brandId: brandA, factId: p.factId, expectedVersion: 2, statement: 'x' },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ details: [{ path: 'factId', issue: 'not_proposed' }] });
  });

  it('an AI suggestion without a source is approved only with a reviewer note, kept as a reviewer source; agents never approve', async () => {
    const s = await propose('Customers love our service', {}, agent(tenantA));
    expect(await row(s.factId)).toMatchObject({ origin: 'suggested', proposedByKind: 'agent' });
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.approve(
          agent(tenantA),
          { brandId: brandA, factId: s.factId, expectedVersion: 0 },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(approve(s.factId)).rejects.toMatchObject({
      details: [{ path: 'reviewerNote', issue: 'reviewer_note_required' }],
    });
    // A note is not a source: an inferred fact citing only a note still needs the reviewer's note.
    const inferred = await propose('Most buyers are under 30', {
      origin: 'inferred',
      sources: [{ kind: 'other', ref: 'Pattern from the last campaign' }],
    });
    await expect(approve(inferred.factId)).rejects.toBeInstanceOf(ValidationFailedError);
    const approved = await approve(s.factId, 0, { reviewerNote: 'Matches the 2026 survey (NPS 71)' });
    expect(approved.state).toBe('approved');
    const r = await row(s.factId);
    expect(r.sources).toContainEqual(
      expect.objectContaining({ kind: 'reviewer', ref: USER, note: 'Matches the 2026 survey (NPS 71)' }),
    );
    expect(r).toMatchObject({ approvedByUserId: USER, reviewedByUserId: USER });
    expect(r.reviewDueAt!.getTime()).toBeGreaterThan(Date.now() + 360 * DAY); // a year by default
    // A sourced suggestion needs no note.
    const sourced = await propose('Rated 4.8 on the store', { sources: [url] }, agent(tenantA));
    expect((await approve(sourced.factId)).state).toBe('approved');
  });

  it('correcting an approved fact proposes a replacement; the original applies until the correction is approved, then is superseded with the impact event', async () => {
    const original = await propose('Delivery takes 3 days', { category: 'service', sources: [url] });
    await approve(original.factId);
    const correction = await run(tenantA, (tx) =>
      brandService.facts.correct(
        A,
        { brandId: brandA, factId: original.factId, expectedVersion: 1, statement: 'Delivery takes 2 days' },
        tx,
      ),
    );
    expect(correction.supersedesFactId).toBe(original.factId);
    expect(await row(correction.factId)).toMatchObject({
      state: 'proposed',
      category: 'service',
      supersedesFactId: original.factId,
    });
    expect(await effectiveIds()).toContain(original.factId);
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.correct(
          A,
          { brandId: brandA, factId: original.factId, expectedVersion: 1, statement: 'Delivery takes 1 day' },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ details: [{ path: 'factId', issue: 'correction_pending' }] });
    const approved = await approve(correction.factId);
    expect(approved.supersededFactIds).toEqual([original.factId]);
    expect(await row(original.factId)).toMatchObject({
      state: 'superseded',
      supersededByFactId: correction.factId,
    });
    const effective = await effectiveIds();
    expect(effective).toContain(correction.factId);
    expect(effective).not.toContain(original.factId);
    expect(await events('brand.fact_revoked', original.factId)).toEqual([
      expect.objectContaining({
        factId: original.factId,
        brandId: brandA,
        previousState: 'approved',
        cause: 'corrected',
        supersededByFactId: correction.factId,
      }),
    ]);
  });

  it('merging keeps one fact, supersedes the others and unions their sources; only an approved one emits the impact event', async () => {
    const keep = await propose('We plant a tree per order', { sources: [url] });
    const other = await propose('One tree is planted for every order', {
      sources: [url, { kind: 'document', ref: 'ast_report', title: 'Impact report' }],
    });
    const third = await propose('A tree for each order placed');
    await approve(keep.factId);
    await approve(other.factId);
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.merge(
          agent(tenantA),
          {
            brandId: brandA,
            keep: { factId: keep.factId, expectedVersion: 1 },
            merge: [{ factId: other.factId, expectedVersion: 1 }],
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    const merged = await run(tenantA, (tx) =>
      brandService.facts.merge(
        A,
        {
          brandId: brandA,
          keep: { factId: keep.factId, expectedVersion: 1 },
          merge: [
            { factId: other.factId, expectedVersion: 1 },
            { factId: third.factId, expectedVersion: 0 },
          ],
        },
        tx,
      ),
    );
    expect(merged.supersededFactIds).toEqual([other.factId, third.factId]);
    expect((await row(keep.factId)).sources).toEqual([
      url,
      { kind: 'document', ref: 'ast_report', title: 'Impact report' },
    ]);
    expect(await row(other.factId)).toMatchObject({ state: 'superseded', supersededByFactId: keep.factId });
    expect(await row(third.factId)).toMatchObject({ state: 'superseded', supersededByFactId: keep.factId });
    expect(await events('brand.fact_revoked', other.factId)).toEqual([
      expect.objectContaining({ cause: 'merged', previousState: 'approved' }),
    ]);
    expect(await events('brand.fact_revoked', third.factId)).toEqual([]);
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.merge(
          A,
          {
            brandId: brandA,
            keep: { factId: keep.factId, expectedVersion: 2 },
            merge: [{ factId: other.factId, expectedVersion: 2 }],
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ details: [{ path: 'merge.0.factId', issue: 'not_live' }] });
  });

  it('close statements are listed as possible duplicates of each other', async () => {
    const a = await propose('Free returns within 30 days of delivery');
    const b = await propose('Free returns within 30 days of delivery for members');
    const listed = await list({ possibleDuplicates: true });
    const byId = new Map(listed.items.map((f) => [f.id, f]));
    expect(byId.get(a.factId)?.possibleDuplicates).toEqual([
      { id: b.factId, statement: 'Free returns within 30 days of delivery for members' },
    ]);
    expect(byId.has(b.factId)).toBe(true);
  });

  it('a conflict is resolved by keeping the other fact (this one superseded), by annotating with a note, never twice', async () => {
    const truth = await propose('Head office is in Bulawayo', { category: 'location', sources: [url] });
    await approve(truth.factId);
    const claim = await propose('Head office is in Harare city centre', {
      category: 'location',
      sources: [url],
      conflicts: [
        { factId: truth.factId, note: 'The website says Bulawayo' },
        { note: 'Old letterhead differs' },
      ],
    });
    expect((await list({ hasConflicts: true })).items.map((f) => f.id)).toContain(claim.factId);
    const dto = (await list({ hasConflicts: true })).items.find((f) => f.id === claim.factId)!;
    expect(dto.conflicts[0]).toMatchObject({
      id: 'c1',
      status: 'open',
      factStatement: 'Head office is in Bulawayo',
    });
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.resolveConflict(
          A,
          {
            brandId: brandA,
            factId: claim.factId,
            expectedVersion: 0,
            conflictId: 'c2',
            outcome: 'annotated',
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ details: [{ path: 'note', issue: 'required' }] });
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.resolveConflict(
          A,
          {
            brandId: brandA,
            factId: claim.factId,
            expectedVersion: 0,
            conflictId: 'c2',
            outcome: 'kept_other',
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ details: [{ path: 'outcome', issue: 'no_live_conflicting_fact' }] });
    await run(tenantA, (tx) =>
      brandService.facts.resolveConflict(
        A,
        {
          brandId: brandA,
          factId: claim.factId,
          expectedVersion: 0,
          conflictId: 'c2',
          outcome: 'annotated',
          note: 'Letterhead predates the move',
        },
        tx,
      ),
    );
    const resolved = await run(tenantA, (tx) =>
      brandService.facts.resolveConflict(
        A,
        {
          brandId: brandA,
          factId: claim.factId,
          expectedVersion: 1,
          conflictId: 'c1',
          outcome: 'kept_other',
        },
        tx,
      ),
    );
    expect(resolved).toMatchObject({ state: 'superseded', version: 3 });
    const r = await row(claim.factId);
    expect(r).toMatchObject({ state: 'superseded', supersededByFactId: truth.factId });
    expect(r.conflicts!.map((c) => [c.id, c.status, c.resolution?.outcome])).toEqual([
      ['c1', 'resolved', 'kept_other'],
      ['c2', 'resolved', 'annotated'],
    ]);
    expect((await list({ hasConflicts: true })).items.map((f) => f.id)).not.toContain(claim.factId);
    expect((await row(truth.factId)).state).toBe('approved');
  });

  it('withdraw needs a reason, keeps it and emits the impact event; mark reviewed sets the reviewer and the next date', async () => {
    const f = await propose('Free parking for customers', { sources: [url] });
    await approve(f.factId);
    await run(tenantA, (tx) =>
      brandService.facts.markReviewed(
        A,
        {
          brandId: brandA,
          factId: f.factId,
          expectedVersion: 1,
          nextReviewDueAt: new Date(Date.now() + 30 * DAY).toISOString(),
          note: 'Checked on site',
        },
        tx,
      ),
    );
    const reviewed = await row(f.factId);
    expect(reviewed.reviewedByUserId).toBe(USER);
    expect(Math.abs(reviewed.reviewDueAt!.getTime() - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
    expect(reviewed.sources).toContainEqual(
      expect.objectContaining({ kind: 'reviewer', note: 'Checked on site' }),
    );
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.withdraw(
          A,
          { brandId: brandA, factId: f.factId, expectedVersion: 2, reason: '   ' },
          tx,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      run(tenantA, (tx) =>
        brandService.facts.withdraw(
          agent(tenantA),
          { brandId: brandA, factId: f.factId, expectedVersion: 2, reason: 'x' },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    const w = await run(tenantA, (tx) =>
      brandService.facts.withdraw(
        A,
        { brandId: brandA, factId: f.factId, expectedVersion: 2, reason: 'Car park closed' },
        tx,
      ),
    );
    expect(w.state).toBe('revoked');
    expect(await row(f.factId)).toMatchObject({ revokeReason: 'Car park closed', revokedByUserId: USER });
    expect(await events('brand.fact_revoked', f.factId)).toEqual([
      expect.objectContaining({ cause: 'withdrawn', reason: 'Car park closed', previousState: 'approved' }),
    ]);
    expect(await effectiveIds()).not.toContain(f.factId);
  });

  it('the workspace filters by category, origin, review due, expiring soon and text', async () => {
    const soon = await propose('Winter sale: 20% off', {
      category: 'offer',
      sources: [url],
      validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
    });
    await approve(soon.factId);
    const later = await propose('Spring sale: 10% off', {
      category: 'offer',
      sources: [url],
      validUntil: new Date(Date.now() + 60 * DAY).toISOString(),
    });
    await approve(later.factId);
    const due = await propose('Our CEO is Tariro Ncube', { category: 'company', sources: [url] });
    await approve(due.factId, 0, { reviewDueAt: new Date(Date.now() + HOUR).toISOString() });
    await tdb.db
      .update(approvedFacts)
      .set({ reviewDueAt: new Date(Date.now() - HOUR) })
      .where(eq(approvedFacts.id, due.factId));
    expect((await list({ expiringWithinDays: 7 })).items.map((f) => f.id)).toEqual([soon.factId]);
    expect((await list({ category: 'offer' })).items.map((f) => f.id).sort()).toEqual(
      [soon.factId, later.factId].sort(),
    );
    const reviewDue = (await list({ reviewDue: true })).items;
    expect(reviewDue.map((f) => f.id)).toEqual([due.factId]);
    expect(reviewDue[0]).toMatchObject({
      reviewDue: true,
      reviewedByName: 'Rudo Moyo',
      approvedByName: 'Rudo Moyo',
    });
    expect((await list({ search: '20%' })).items.map((f) => f.id)).toEqual([soon.factId]); // % is literal
    expect((await list({ search: 'tariro' })).items.map((f) => f.id)).toEqual([due.factId]);
    // A brief's offer facts by id: another tenant's id is simply left out.
    expect((await list({ ids: [soon.factId, factOfB] })).items.map((f) => f.id)).toEqual([soon.factId]);
    const suggested = (await list({ origin: 'suggested' })).items;
    expect(suggested.length).toBeGreaterThan(0);
    expect(suggested.every((f) => f.origin === 'suggested')).toBe(true);
    // A row written before 0023 (no category or origin) reads and filters as its kind and proposer.
    const legacy = await propose(
      'Legacy statistic: 1,000 customers',
      { category: 'statistic' },
      agent(tenantA),
    );
    await tdb.db
      .update(approvedFacts)
      .set({ category: null, origin: null, sources: null })
      .where(eq(approvedFacts.id, legacy.factId));
    expect((await list({ category: 'statistic', origin: 'suggested' })).items.map((f) => f.id)).toContain(
      legacy.factId,
    );
  });

  it('the daily sweep emits the expiry event once, flags review-due facts once and keys facts stored without a key', async () => {
    const offer = await propose('Flash sale: two for one', {
      category: 'offer',
      sources: [url],
      validUntil: new Date(Date.now() + HOUR).toISOString(),
    });
    await approve(offer.factId, 0, { reviewDueAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    const unkeyed = await propose('Stored before duplicate keys');
    await tdb.db.update(approvedFacts).set({ dedupeKey: null }).where(eq(approvedFacts.id, unkeyed.factId));
    const runtime = createBrandFactSweepRuntime();
    const now = new Date(Date.now() + 3 * HOUR).toISOString();
    const targets = await runtime.listBrandFactSweepTargets({ correlationId: 'corr_sweep', now });
    expect(targets).toContainEqual({ tenantId: tenantA, brandId: brandA });
    expect(targets.some((t) => t.tenantId === tenantB)).toBe(false);
    const sweep = () =>
      runInTenant(
        {
          tenantId: tenantA,
          actor: { kind: 'platform_operator', id: 'brand-fact-sweep' },
          brandIds: 'all',
          correlationId: 'corr_sweep',
        },
        () =>
          runtime.sweepBrandFacts({
            tenantId: tenantA,
            brandId: brandA,
            actor: { kind: 'platform_operator', id: 'brand-fact-sweep' },
            correlationId: 'corr_sweep',
            now,
          }),
      );
    const first = await sweep();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(first.reviewDue).toBeGreaterThanOrEqual(1);
    expect(first.keyed).toBe(1);
    expect(await events('brand.fact_expired', offer.factId)).toEqual([
      expect.objectContaining({
        factId: offer.factId,
        brandId: brandA,
        cause: 'expired',
        previousState: 'approved',
        actorKind: 'user',
        actorId: USER,
      }),
    ]);
    expect(await row(offer.factId)).toMatchObject({ state: 'approved' });
    expect((await row(offer.factId)).reviewFlaggedAt).not.toBeNull();
    expect((await row(unkeyed.factId)).dedupeKey).toBe(factDedupeKey('Stored before duplicate keys'));
    expect(await sweep()).toEqual({ expired: 0, reviewDue: 0, keyed: 0 });
    expect(await events('brand.fact_expired', offer.factId)).toHaveLength(1);
    expect(
      (await runtime.listBrandFactSweepTargets({ correlationId: 'corr_sweep', now })).some(
        (t) => t.brandId === brandA,
      ),
    ).toBe(false);
    const audits = await tdb.db.select().from(auditEvents).where(eq(auditEvents.resourceId, offer.factId));
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['brand.fact.expire', 'brand.fact.review_due']),
    );
    // Marking it reviewed clears the flag, so a later due date is flagged again.
    const r = await row(offer.factId);
    await run(tenantA, (tx) =>
      brandService.facts.markReviewed(
        A,
        { brandId: brandA, factId: offer.factId, expectedVersion: r.version },
        tx,
      ),
    );
    expect((await row(offer.factId)).reviewFlaggedAt).toBeNull();
  });

  it("tenant B's fact is NOT_FOUND to every command from tenant A, and nothing of B changes", async () => {
    const before = JSON.stringify(await row(factOfB));
    const B = { brandId: brandB, factId: factOfB, expectedVersion: 0 };
    const attempts: Array<(tx: Tx) => Promise<unknown>> = [
      (tx) => brandService.facts.update(A, { ...B, statement: 'x' }, tx),
      (tx) => brandService.facts.approve(A, B, tx),
      (tx) => brandService.facts.withdraw(A, { ...B, reason: 'x' }, tx),
      (tx) => brandService.facts.correct(A, { ...B, statement: 'x' }, tx),
      (tx) => brandService.facts.markReviewed(A, B, tx),
      (tx) => brandService.facts.resolveConflict(A, { ...B, conflictId: 'c1', outcome: 'kept_this' }, tx),
      (tx) =>
        brandService.facts.merge(
          A,
          {
            brandId: brandB,
            keep: { factId: factOfB, expectedVersion: 0 },
            merge: [{ factId: factOfB, expectedVersion: 0 }],
          },
          tx,
        ),
      (tx) => brandService.facts.propose(A, { brandId: brandB, category: 'claim', statement: 'x' }, tx),
      (tx) => brandService.facts.sweep(brandB, new Date(), tx),
      // Tenant B's fact named from tenant A's own brand, and as a conflicting fact.
      (tx) => brandService.facts.approve(A, { ...B, brandId: brandA }, tx),
      (tx) =>
        brandService.facts.propose(
          A,
          { brandId: brandA, category: 'claim', statement: 'Names B', conflicts: [{ factId: factOfB }] },
          tx,
        ),
    ];
    for (const attempt of attempts) await expect(run(tenantA, attempt)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      runInTenant(ctx(tenantA), () => brandService.facts.list(A, { brandId: brandB, page: { limit: 10 } })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(JSON.stringify(await row(factOfB))).toBe(before);
  });
});
