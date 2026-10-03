import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import { type SeoAuditCheckV1, type SeoAuditPageSeverity } from '@oremedia/contracts/seo-audit';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { seoAuditPages, seoAuditRuns, seoFindingWork } from '@oremedia/db/schema/destinations';
import { auditEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { MemoryRateLimiterStore } from '@oremedia/module-operations';
import { CmsRegistry } from '@oremedia/providers';
import { createSeoAuditService } from './audit';
import { configureDestinationCms } from './cms';
import { registerFindingWork, resetFindingWork, type FindingWorkInput } from './hooks';
import { createDestinationRuntime } from './runtime';
import { destinationService, sourceUsePolicyService } from './service';

/**
 * RA-11 against MySQL 8: an SEO finding becomes tracked work through the finding-work hook (an in-memory work
 * module here; the composition root registers the intelligence module's recommendations), once per finding
 * (a second call returns the existing item), with its provenance recorded, under insight.manage (a person, never
 * an agent); the findings list carries each finding's status and work; a later completed run that no longer
 * reports the check resolves the work link, a failed run resolves nothing. Cross-tenant and cross-brand:
 * NOT_FOUND, nothing written.
 */
const USER = 'usr_work_test';
const NOW = '2026-10-05T05:00:00.000Z';
const ctx = (
  tenantId: string,
  actor: TenantContext['actor'] = { kind: 'user', id: USER },
): TenantContext => ({
  tenantId,
  actor,
  brandIds: 'all',
  correlationId: 'corr_work',
});
const member = (tenantId: string, role: MembershipRole): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_work_test',
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const principal = (tenantId: string): ResolvedActorServicePrincipal => ({
  kind: 'service_principal',
  id: 'sp_work_test',
  tenantId,
  status: 'active',
  maxAutonomy: 'create',
  grants: [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'insight.manage', brandIds: 'all' },
  ],
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);
const AUDIT_ACTOR = { kind: 'platform_operator' as const, id: 'seo-audit-sweep' };
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const ORIGIN = 'https://site.example';

const fail = (key: SeoAuditCheckV1['key'], severity: 'critical' | 'major' | 'minor', detail: string) =>
  ({ key, ok: false, severity, detail }) as SeoAuditCheckV1;
const pass = (key: SeoAuditCheckV1['key']) =>
  ({ key, ok: true, severity: null, detail: null }) as SeoAuditCheckV1;

describe('SEO findings become tracked work (RA-11) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');
  const owner = () => member(tenantA, 'owner');
  let clock = new Date(NOW);
  const auditLock = new MemoryRateLimiterStore();
  const runtime = createDestinationRuntime({ now: () => clock, auditLock });
  const service = createSeoAuditService({ now: () => clock });
  let siteId = '';
  const run1 = newId('seoAuditRun');
  const run2 = newId('seoAuditRun');
  const run3 = newId('seoAuditRun');
  /** The in-memory work module: what the hook was asked to create, and the items it holds by id. */
  const created: FindingWorkInput[] = [];
  const work = new Map<string, { brandId: string; title: string; state: string }>();

  async function seedRun(
    id: string,
    startedAt: Date,
    outcome: 'completed' | 'running',
    pages: Array<[string, SeoAuditCheckV1[]]>,
  ) {
    await tdb.db.insert(seoAuditRuns).values({
      id,
      tenantId: tenantA,
      brandId: brandA,
      destinationId: siteId,
      origin: ORIGIN,
      trigger: 'scheduled',
      requestedById: null,
      startedAt,
      finishedAt: outcome === 'completed' ? startedAt : null,
      outcome,
      pagesCrawled: outcome === 'completed' ? pages.length : 0,
    });
    for (const [path, checks] of pages) {
      const worst = checks.filter((c) => !c.ok).map((c) => c.severity);
      const severity: SeoAuditPageSeverity = worst.includes('critical')
        ? 'critical'
        : worst.includes('major')
          ? 'major'
          : worst.includes('minor')
            ? 'minor'
            : 'ok';
      await tdb.db.insert(seoAuditPages).values({
        id: newId('seoAuditPage'),
        tenantId: tenantA,
        brandId: brandA,
        runId: id,
        url: `${ORIGIN}${path}`,
        urlHash: sha256Hex(`${ORIGIN}${path}`),
        depth: path === '/' ? 0 : 1,
        status: 200,
        bytes: 1000,
        severity,
        checks,
        titleHash: null,
        metaDescriptionHash: null,
        links: [],
        fetchedAt: startedAt,
      });
    }
  }
  const auditsOf = (action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, action)))
      .orderBy(asc(auditEvents.createdAt));
  const links = () =>
    tdb.db
      .select()
      .from(seoFindingWork)
      .where(eq(seoFindingWork.destinationId, siteId))
      .orderBy(asc(seoFindingWork.check), asc(seoFindingWork.id));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'work-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'work-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values({ id: USER, email: 'work-test@example.test', name: 'Work' });
    await tdb.db.insert(memberships).values({
      id: 'mem_work_test',
      tenantId: tenantA,
      userId: USER,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configureDestinationCms({ registry: new CmsRegistry() });
    registerFindingWork({
      create: async (_actor, input) => {
        created.push(input);
        const workId = newId('recommendation');
        work.set(workId, { brandId: input.brandId, title: input.title, state: 'proposed' });
        return { workType: 'recommendation', workId, title: input.title, state: 'proposed' };
      },
      describe: async (brandId, ids) =>
        ids.flatMap((id) => {
          const w = work.get(id);
          return w && w.brandId === brandId
            ? [{ workType: 'recommendation', workId: id, title: w.title, state: w.state }]
            : [];
        }),
    });
    siteId = (
      await run(tenantA, (tx) =>
        destinationService.register(
          owner(),
          { brandId: brandA, kind: 'cms_site', externalId: ORIGIN, displayName: 'Site' },
          tx,
        ),
      )
    ).id;
    await run(tenantA, (tx) =>
      sourceUsePolicyService.set(
        owner(),
        {
          brandId: brandA,
          destinationKind: 'cms_site',
          dataType: 'cms.audit',
          allowedUses: ['read'],
          reviewDueAt: inDays(60),
        },
        tx,
      ),
    );
    // Run 1 (completed a day ago): a long title on two pages, two H1s on one, the rest fine (lab checks only:
    // the finish recomputes the cross-page checks from the pages' links and hashes, which are empty here).
    await seedRun(run1, new Date('2026-10-04T05:00:00.000Z'), 'completed', [
      ['/', [fail('title', 'minor', 'length=74'), fail('h1', 'major', 'count=2'), pass('canonical')]],
      ['/about', [fail('title', 'minor', 'length=80'), pass('h1'), pass('canonical')]],
      ['/contact', [pass('title'), pass('h1'), pass('canonical')]],
    ]);
  });
  afterAll(async () => {
    resetFindingWork();
    await tdb?.drop();
  });

  it('every reported finding starts open, named by its run and rule, with no work', async () => {
    const findings = await inTenant(tenantA, () =>
      service.findings(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(findings.runId).toBe(run1);
    expect(findings.items.map((f) => [f.check, f.count, f.status, f.work, f.findingId])).toEqual([
      ['h1', 1, 'open', null, `${run1}:h1`],
      ['title', 2, 'open', null, `${run1}:title`],
    ]);
    const summary = await inTenant(tenantA, () =>
      service.summary(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(summary.canCreateWork).toBe(true);
  });

  it('createWork turns one or many findings into work with their provenance, audited; the list shows them tracked', async () => {
    const result = await run(tenantA, (tx) =>
      service.createWork(owner(), { brandId: brandA, destinationId: siteId, checks: ['title', 'h1'] }, tx),
    );
    expect(result.runId).toBe(run1);
    expect(result.items.map((i) => [i.check, i.pageCount, i.workType, i.state, i.resolvedAt])).toEqual([
      ['title', 2, 'recommendation', 'proposed', null],
      ['h1', 1, 'recommendation', 'proposed', null],
    ]);
    expect(result.items[0]).toMatchObject({
      findingId: `${run1}:title`,
      runId: run1,
      severity: 'minor',
      examples: [`${ORIGIN}/`, `${ORIGIN}/about`],
      title: `Missing or long titles on ${ORIGIN}`,
      createdById: USER,
    });
    // The work module was asked once per finding, with the provenance the recommendation records as evidence.
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      brandId: brandA,
      title: `Missing or long titles on ${ORIGIN}`,
      provenance: {
        findingId: `${run1}:title`,
        runId: run1,
        check: 'title',
        severity: 'minor',
        destinationId: siteId,
        origin: ORIGIN,
        pageCount: 2,
        pages: [`${ORIGIN}/`, `${ORIGIN}/about`],
      },
    });
    expect(created[0]?.rationale).toContain('title of 60 characters or fewer for 2 pages');
    const audits = await auditsOf('seo_audit.work_created');
    expect(audits).toHaveLength(2);
    expect(audits[0]?.metadata).toMatchObject({
      brandId: brandA,
      runId: run1,
      scope: `${run1}:title`,
      downstreamType: 'recommendation',
      downstreamId: result.items[0]?.workId,
    });
    expect(await links()).toHaveLength(2);
    const findings = await inTenant(tenantA, () =>
      service.findings(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(
      findings.items.map((f) => [f.check, f.status, f.work?.workId, f.work?.title, f.work?.state]),
    ).toEqual([
      ['h1', 'tracked', result.items[1]?.workId, `Not exactly one H1 on ${ORIGIN}`, 'proposed'],
      ['title', 'tracked', result.items[0]?.workId, `Missing or long titles on ${ORIGIN}`, 'proposed'],
    ]);
  });

  it('a second createWork for the same finding returns the existing item; an unreported check is refused before anything is written', async () => {
    const before = await links();
    const again = await run(tenantA, (tx) =>
      service.createWork(owner(), { brandId: brandA, destinationId: siteId, checks: ['title'] }, tx),
    );
    expect(again.items.map((i) => i.id)).toEqual([before.find((l) => l.check === 'title')?.id]);
    expect(again.items[0]?.workId).toBe(before.find((l) => l.check === 'title')?.workId);
    expect(created).toHaveLength(2); // nothing new asked of the work module
    const err = await run(tenantA, (tx) =>
      service.createWork(
        owner(),
        { brandId: brandA, destinationId: siteId, checks: ['title', 'canonical'] },
        tx,
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect((err as ValidationFailedError).details).toEqual([
      { path: 'checks', issue: 'not_reported:canonical' },
    ]);
    expect(await links()).toEqual(before);
    expect(await auditsOf('seo_audit.work_created')).toHaveLength(2);
  });

  it('insight.manage decides who may create work: an analyst may, a community member may not, an agent never', async () => {
    const summaryForAnalyst = await inTenant(tenantA, () =>
      service.summary(member(tenantA, 'analyst'), { brandId: brandA, destinationId: siteId }),
    );
    expect(summaryForAnalyst.canCreateWork).toBe(true);
    const summaryForCommunity = await inTenant(tenantA, () =>
      service.summary(member(tenantA, 'community'), { brandId: brandA, destinationId: siteId }),
    );
    expect(summaryForCommunity.canCreateWork).toBe(false);
    await expect(
      run(tenantA, (tx) =>
        service.createWork(
          member(tenantA, 'community'),
          { brandId: brandA, destinationId: siteId, checks: ['title'] },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    const agent = await runInTenant(ctx(tenantA, { kind: 'service_principal', id: 'sp_work_test' }), () =>
      withTransaction((tx) =>
        service.createWork(
          principal(tenantA),
          { brandId: brandA, destinationId: siteId, checks: ['title'] },
          tx,
        ),
      ),
    ).catch((e: unknown) => e);
    expect(agent).toBeInstanceOf(PolicyDeniedError); // denied by policy before the person check, as accept is
    expect(await links()).toHaveLength(2);
  });

  it('a foreign tenant or another brand of the tenant finds no website: NOT_FOUND, nothing written', async () => {
    await expect(
      runInTenant(ctx(tenantB), () =>
        withTransaction((tx) =>
          service.createWork(
            member(tenantB, 'owner'),
            { brandId: brandB, destinationId: siteId, checks: ['title'] },
            tx,
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run(tenantA, (tx) =>
        service.createWork(owner(), { brandId: brandA2, destinationId: siteId, checks: ['title'] }, tx),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(tenantA, () => service.findings(owner(), { brandId: brandA2, destinationId: siteId })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await links()).toHaveLength(2);
    expect(created).toHaveLength(2);
  });

  it('a later completed run that no longer reports a check resolves its work; the list says resolved; a failed run resolves nothing', async () => {
    // Run 2: the titles were fixed, the double H1 remains.
    clock = new Date('2026-10-06T05:00:00.000Z');
    await seedRun(run2, clock, 'running', [
      ['/', [pass('title'), fail('h1', 'major', 'count=2'), pass('canonical')]],
      ['/about', [pass('title'), pass('h1'), pass('canonical')]],
    ]);
    const finished = await runInTenant(ctx(tenantA, AUDIT_ACTOR), () =>
      runtime.audit.finishSeoAudit({
        ...ctx(tenantA),
        actor: AUDIT_ACTOR,
        destinationId: siteId,
        now: clock.toISOString(),
        trigger: 'scheduled',
        runId: run2,
        limitsHit: [],
        failedPages: 0,
      }),
    );
    expect(finished).toEqual({ outcome: 'completed', pages: 2 });
    const rows = await links();
    expect(rows.map((l) => [l.check, l.resolvedRunId, l.resolvedAt?.toISOString() ?? null])).toEqual([
      ['h1', null, null],
      ['title', run2, clock.toISOString()],
    ]);
    const findings = await inTenant(tenantA, () =>
      service.findings(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(findings.runId).toBe(run2);
    expect(findings.items.map((f) => [f.check, f.count, f.status, f.work?.workId ?? null])).toEqual([
      ['h1', 1, 'tracked', rows[0]?.workId],
      ['title', 0, 'resolved', rows[1]?.workId],
    ]);
    expect(findings.items[1]).toMatchObject({
      findingId: `${run1}:title`,
      examples: [`${ORIGIN}/`, `${ORIGIN}/about`],
      work: { resolvedRunId: run2, state: 'proposed' },
    });
    // Reading run 1 again: both its findings are tracked as they were (the resolution belongs to run 2).
    const earlier = await inTenant(tenantA, () =>
      service.findings(owner(), { brandId: brandA, destinationId: siteId, runId: run1 }),
    );
    expect(earlier.items.map((f) => [f.check, f.status])).toEqual([
      ['h1', 'tracked'],
      ['title', 'tracked'],
    ]);
    // Run 3 reaches no page: it fails, and proves nothing about the H1.
    clock = new Date('2026-10-07T05:00:00.000Z');
    await seedRun(run3, clock, 'running', []);
    expect(
      await runInTenant(ctx(tenantA, AUDIT_ACTOR), () =>
        runtime.audit.finishSeoAudit({
          ...ctx(tenantA),
          actor: AUDIT_ACTOR,
          destinationId: siteId,
          now: clock.toISOString(),
          trigger: 'scheduled',
          runId: run3,
          limitsHit: [],
          failedPages: 0,
        }),
      ),
    ).toEqual({ outcome: 'failed', pages: 0 });
    expect((await links()).find((l) => l.check === 'h1')?.resolvedAt).toBeNull();
    // The title came back on a later run: it is open again, and a new work item may be created for it.
    const run4 = newId('seoAuditRun');
    clock = new Date('2026-10-08T05:00:00.000Z');
    await seedRun(run4, clock, 'completed', [
      ['/', [fail('title', 'minor', 'length=74'), fail('h1', 'major', 'count=2'), pass('canonical')]],
    ]);
    const back = await inTenant(tenantA, () =>
      service.findings(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(back.items.map((f) => [f.check, f.status])).toEqual([
      ['h1', 'tracked'],
      ['title', 'open'],
    ]);
    const renewed = await run(tenantA, (tx) =>
      service.createWork(owner(), { brandId: brandA, destinationId: siteId, checks: ['title'] }, tx),
    );
    expect(renewed.items[0]).toMatchObject({ findingId: `${run4}:title`, runId: run4, pageCount: 1 });
    expect(renewed.items[0]?.workId).not.toBe(rows[1]?.workId);
    expect(await links()).toHaveLength(3);
  });

  it('two concurrent createWork calls for one finding yield one row and the same work (the destination row lock serialises them)', async () => {
    const run5 = newId('seoAuditRun');
    clock = new Date('2026-10-09T05:00:00.000Z');
    await seedRun(run5, clock, 'completed', [
      [
        '/',
        [
          fail('title', 'minor', 'length=74'),
          fail('h1', 'major', 'count=2'),
          fail('canonical', 'major', 'missing'),
        ],
      ],
    ]);
    const before = created.length;
    const [a, b] = await Promise.all([
      run(tenantA, (tx) =>
        service.createWork(owner(), { brandId: brandA, destinationId: siteId, checks: ['canonical'] }, tx),
      ),
      run(tenantA, (tx) =>
        service.createWork(owner(), { brandId: brandA, destinationId: siteId, checks: ['canonical'] }, tx),
      ),
    ]);
    expect(a.items[0]?.workId).toBe(b.items[0]?.workId);
    expect(a.items[0]?.id).toBe(b.items[0]?.id);
    expect(created.length - before).toBe(1); // the work module was asked once
    expect((await links()).filter((l) => l.check === 'canonical')).toHaveLength(1);
  });
});
