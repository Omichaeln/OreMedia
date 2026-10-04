import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { SeoAuditInputV1 } from '@oremedia/contracts/seo-audit';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { seoAuditPages, seoAuditRuns } from '@oremedia/db/schema/destinations';
import { auditEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { SEO_AUDIT_ACTOR, createSeoAuditActivities } from '@oremedia/activities';
import {
  configureDestinationCms,
  createDestinationRuntime,
  destinationService,
  sourceUsePolicyService,
} from '@oremedia/module-destinations';
import { CmsRegistry } from '@oremedia/providers';

/**
 * Ledger G21: the SEO audit's activity hosts (seoAuditSweepWorkflowV2 and seoAuditWorkflowV2 on `ingest-metrics`),
 * built from the production factory over the real audit runtime (one per process, as ingest-worker.ts composes it),
 * against MySQL and a loopback website. The target listing is platform-level and writes nothing; every other
 * activity runs in its destination's tenant as the platform job; a foreign destination or run is refused
 * non-retryably before any policy is read or page fetched; the run, its pages, its summary and the audit are
 * written, and a replayed call causes no second effect.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const NOW = '2026-10-05T05:00:00.000Z';

const refusal = async (p: Promise<unknown>) => {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { name?: string; type?: string; nonRetryable?: boolean } | null;
  expect(err?.name).toBe('ApplicationFailure');
  return { type: err?.type, nonRetryable: err?.nonRetryable };
};

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="A description long enough to pass the length rule for ${title} on this site.">
<meta name="viewport" content="width=device-width"></head><body><h1>${title}</h1>${body}</body></html>`;

describe('SEO audit activity hosts (worker-ingest) against MySQL and a loopback site (ledger G21)', () => {
  let tdb: TestDatabase;
  let server: Server;
  let origin = '';
  const served: string[] = [];
  const tenantA = newId('ten');
  const tenantB = newId('ten');
  const brandA = newId('brd');
  const brandB = newId('brd');
  const userA = newId('usr');
  const userB = newId('usr');
  const membershipA = newId('mem');
  const membershipB = newId('mem');
  const acts = createSeoAuditActivities(createDestinationRuntime().audit);
  let siteA = '';
  let siteB = '';
  let runB = '';

  const owner = (tenantId: string, userId: string): ResolvedActor => ({
    kind: 'user',
    id: userId,
    tenantId,
    membershipId: tenantId === tenantA ? membershipA : membershipB,
    membershipStatus: 'active',
    role: 'owner',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  });
  const ctx = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    brandIds: 'all',
    correlationId: 'corr_audit_acts',
  });
  const run = <T>(tenantId: string, userId: string, fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx(tenantId, userId), () => withTransaction(fn));
  const input = (tenantId: string, destinationId: string): SeoAuditInputV1 => ({
    tenantId,
    actor: SEO_AUDIT_ACTOR,
    correlationId: 'corr_audit_acts',
    destinationId,
    now: NOW,
    trigger: 'scheduled',
  });
  const runRow = async (id: string) =>
    (await tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.id, id)))[0]!;
  const runsOf = (destinationId: string) =>
    tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.destinationId, destinationId));
  const pagesOf = (runId: string) =>
    tdb.db.select().from(seoAuditPages).where(eq(seoAuditPages.runId, runId));
  const auditsOf = (tenantId: string, action: string, resourceId: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.action, action),
          eq(auditEvents.resourceId, resourceId),
        ),
      );
  const register = async (tenantId: string, userId: string, brandId: string, externalId: string) =>
    (
      await run(tenantId, userId, (tx) =>
        destinationService.register(
          owner(tenantId, userId),
          { brandId, kind: 'cms_site', externalId, displayName: 'Loopback site' },
          tx,
        ),
      )
    ).id;
  const setPolicy = (
    tenantId: string,
    userId: string,
    brandId: string,
    allowedUses: Array<'read' | 'retain'>,
    expectedVersion?: number,
  ) =>
    run(tenantId, userId, (tx) =>
      sourceUsePolicyService.set(
        owner(tenantId, userId),
        {
          brandId,
          destinationKind: 'cms_site',
          dataType: 'cms.audit',
          allowedUses,
          ...(allowedUses.includes('retain') ? { retentionDays: 30 } : {}),
          reviewDueAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        },
        tx,
      ),
    );

  beforeAll(async () => {
    const pages: Record<string, { status: number; body: string }> = {
      '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private/\n' },
      '/': { status: 200, body: page('Home', '<a href="/good">Good</a><a href="/private/x">P</a>') },
      '/good': { status: 200, body: page('Good page', '') },
    };
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      served.push(path);
      const p = pages[path] ?? { status: 404, body: 'nope' };
      res.writeHead(p.status, { 'content-type': path.endsWith('.txt') ? 'text/plain' : 'text/html' });
      res.end(p.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'audit-acts-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'audit-acts-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values([
      { id: userA, email: `audit-acts-${userA.slice(-6).toLowerCase()}@example.test`, name: 'A' },
      { id: userB, email: `audit-acts-${userB.slice(-6).toLowerCase()}@example.test`, name: 'B' },
    ]);
    await tdb.db.insert(memberships).values([
      { id: membershipA, tenantId: tenantA, userId: userA, role: 'owner', status: 'active', allBrands: true },
      { id: membershipB, tenantId: tenantB, userId: userB, role: 'owner', status: 'active', allBrands: true },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    // Tests only: the loopback site is allowed; production refuses it (the dispatcher throws under NODE_ENV).
    configureDestinationCms({ registry: new CmsRegistry(), insecureAllowLoopback: true });
    siteA = await register(tenantA, userA, brandA, origin);
    siteB = await register(tenantB, userB, brandB, origin.replace('127.0.0.1', 'localhost'));
    await setPolicy(tenantA, userA, brandA, ['read']);
    await setPolicy(tenantB, userB, brandB, ['read']);
    // Tenant B's own running audit: a run id a foreign caller might name.
    runB = newId('sar');
    await tdb.db.insert(seoAuditRuns).values({
      id: runB,
      tenantId: tenantB,
      brandId: brandB,
      destinationId: siteB,
      origin: origin.replace('127.0.0.1', 'localhost'),
      trigger: 'scheduled',
      startedAt: new Date(NOW),
      outcome: 'running',
    });
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await tdb?.drop();
  });

  it('the target listing is platform-level: references of every tenant, nothing written; a replay lists the same', async () => {
    const before = await tdb.db.select().from(seoAuditRuns);
    const targets = await acts.listSeoAuditTargets({ correlationId: 'corr_audit_acts', now: NOW });
    expect(targets).toEqual(
      expect.arrayContaining([
        { tenantId: tenantA, destinationId: siteA },
        { tenantId: tenantB, destinationId: siteB },
      ]),
    );
    expect(Object.keys(targets[0] ?? {})).toEqual(['tenantId', 'destinationId']);
    expect(await acts.listSeoAuditTargets({ correlationId: 'corr_audit_acts', now: NOW })).toEqual(targets);
    expect(await tdb.db.select().from(seoAuditRuns)).toEqual(before);
  });

  it('a foreign destination or run is refused by every tenant-scoped activity before any page is fetched', async () => {
    served.length = 0;
    const runBBefore = await runRow(runB);
    const foreign = input(tenantA, siteB);
    for (const call of [
      () => acts.planSeoAudit(foreign),
      () => acts.crawlSeoAuditPage({ ...foreign, runId: runB, url: `${origin}/`, depth: 0 }),
      () => acts.finishSeoAudit({ ...foreign, runId: runB, limitsHit: [], failedPages: 0 }),
      () => acts.pruneSeoAudits(foreign),
    ])
      expect(await refusal(call())).toEqual({ type: 'PolicyDenied', nonRetryable: true });
    // Tenant A's own destination naming tenant B's run: refused the same way.
    expect(
      await refusal(
        acts.crawlSeoAuditPage({ ...input(tenantA, siteA), runId: runB, url: `${origin}/`, depth: 0 }),
      ),
    ).toEqual({ type: 'PolicyDenied', nonRetryable: true });
    expect(served).toEqual([]);
    expect(await runRow(runB)).toEqual(runBBefore);
    expect(await pagesOf(runB)).toEqual([]);
    expect(await auditsOf(tenantA, 'seo_audit.started', siteB)).toEqual([]);
  });

  let runId = '';
  it('plans in the destination tenant as the platform job and opens one run; a replayed plan opens no second run', async () => {
    const plan = await acts.planSeoAudit(input(tenantA, siteA));
    expect(plan).toMatchObject({ outcome: 'planned', origin, seeds: [`${origin}/`] });
    if (plan.outcome !== 'planned') throw new Error('expected a plan');
    runId = plan.runId;
    expect(await runRow(runId)).toMatchObject({
      tenantId: tenantA,
      brandId: brandA,
      destinationId: siteA,
      outcome: 'running',
      trigger: 'scheduled',
      robotsDisallow: ['/private/'],
    });
    const started = await auditsOf(tenantA, 'seo_audit.started', siteA);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ actorKind: SEO_AUDIT_ACTOR.kind, actorId: SEO_AUDIT_ACTOR.id });
    expect((await acts.planSeoAudit(input(tenantA, siteA))).outcome).toBe('skipped');
    expect((await runsOf(siteA)).map((r) => r.id)).toEqual([runId]);
    expect(await auditsOf(tenantA, 'seo_audit.started', siteA)).toHaveLength(1);
  });

  it('a crawl stores the page once; a replayed crawl of the same URL keeps one row', async () => {
    const crawl = { ...input(tenantA, siteA), runId, url: `${origin}/`, depth: 0 };
    const first = await acts.crawlSeoAuditPage(crawl);
    expect(first).toEqual({ outcome: 'crawled', status: 200, links: [`${origin}/good`] });
    expect(await acts.crawlSeoAuditPage(crawl)).toEqual(first);
    const rows = await pagesOf(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: tenantA, brandId: brandA, url: `${origin}/`, status: 200 });
    await acts.crawlSeoAuditPage({ ...crawl, url: `${origin}/good`, depth: 1 });
    expect(await pagesOf(runId)).toHaveLength(2);
    expect(served).not.toContain('/private/x');
  });

  it('finish closes the run with its summary and audits once; a replayed finish changes nothing', async () => {
    const finish = { ...input(tenantA, siteA), runId, limitsHit: [], failedPages: 0 };
    expect(await acts.finishSeoAudit(finish)).toEqual({ outcome: 'completed', pages: 2 });
    const closed = await runRow(runId);
    expect(closed).toMatchObject({ outcome: 'completed', pagesCrawled: 2 });
    const finished = await auditsOf(tenantA, 'seo_audit.finished', siteA);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ actorKind: SEO_AUDIT_ACTOR.kind, decision: 'allowed' });
    expect(await acts.finishSeoAudit(finish)).toEqual({ outcome: 'completed', pages: 2 });
    expect(await runRow(runId)).toEqual(closed);
    expect(await auditsOf(tenantA, 'seo_audit.finished', siteA)).toHaveLength(1);
    // A crawl replayed after the close records nothing.
    expect(await acts.crawlSeoAuditPage({ ...finish, url: `${origin}/good`, depth: 1 })).toEqual({
      outcome: 'skipped',
      reason: 'not_running',
    });
    expect(await pagesOf(runId)).toHaveLength(2);
  });

  it('prune removes runs past the retention in the destination tenant; a replayed prune removes nothing more', async () => {
    const policy = (
      await runInTenant(ctx(tenantA, userA), () =>
        sourceUsePolicyService.list(owner(tenantA, userA), { brandId: brandA, destinationKind: 'cms_site' }),
      )
    ).items.find((p) => p.dataType === 'cms.audit')!;
    await setPolicy(tenantA, userA, brandA, ['read', 'retain'], policy.version);
    const old = newId('sar');
    await tdb.db.insert(seoAuditRuns).values({
      id: old,
      tenantId: tenantA,
      brandId: brandA,
      destinationId: siteA,
      origin,
      trigger: 'scheduled',
      startedAt: new Date(Date.parse(NOW) - 90 * 86_400_000),
      finishedAt: new Date(Date.parse(NOW) - 90 * 86_400_000),
      outcome: 'completed',
    });
    expect(await acts.pruneSeoAudits(input(tenantA, siteA))).toEqual({ deleted: 1 });
    expect((await runsOf(siteA)).map((r) => r.id)).toEqual([runId]);
    expect(await auditsOf(tenantA, 'seo_audit.pruned', siteA)).toHaveLength(1);
    expect(await acts.pruneSeoAudits(input(tenantA, siteA))).toEqual({ deleted: 0 });
    expect(await auditsOf(tenantA, 'seo_audit.pruned', siteA)).toHaveLength(1);
    expect(await runRow(runB)).toBeDefined(); // tenant B's run is not the tenant A prune's to remove
  });
});
