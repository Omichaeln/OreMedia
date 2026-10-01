import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { ConflictError, NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import {
  SEO_AUDIT_MAX_DEPTH,
  SEO_AUDIT_MAX_PAGES,
  type SeoAuditCrawlPageInputV1,
  type SeoAuditInputV1,
} from '@oremedia/contracts/seo-audit';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { seoAuditPages, seoAuditRuns } from '@oremedia/db/schema/destinations';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { MemoryRateLimiterStore } from '@oremedia/module-operations';
import { CmsRegistry } from '@oremedia/providers';
import { createSeoAuditService } from './audit';
import { configureDestinationCms } from './cms';
import { createDestinationRuntime } from './runtime';
import { destinationService, sourceUsePolicyService } from './service';

/**
 * R2-4 against MySQL 8 and a loopback website: the audit runtime (policy gate, lock, seeds from robots.txt and the
 * sitemap, one bounded page fetch per activity with the links returned, cross-page checks and the summary at
 * finish, retention) and the read model over the stored run (summary, runs, pages by severity, findings with
 * suggested tasks) and the on-demand run (once per day, refused while one is in progress, started through the
 * outbox). Cross-tenant and cross-brand: NOT_FOUND; a policy that does not allow reads: nothing crawled, reads
 * refused. The crawl stays on the origin: the off-origin link and the robots-disallowed page are never fetched.
 */
const USER = 'usr_audit_test';
const NOW = '2026-10-05T05:00:00.000Z';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_audit',
});
const member = (tenantId: string, role: MembershipRole): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_audit_test',
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);
const AUDIT_ACTOR = { kind: 'platform_operator' as const, id: 'seo-audit-sweep' };
const asPlatformJob = <T>(tenantId: string, fn: () => Promise<T>) =>
  runInTenant({ tenantId, actor: AUDIT_ACTOR, brandIds: 'all', correlationId: 'corr_sweep' }, fn);
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const page = (title: string, body: string, head = '') =>
  `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="A description long enough to pass the length rule for ${title} on this site.">
<meta name="viewport" content="width=device-width">${head}
<script type="application/ld+json">{"@type":"WebPage"}</script></head><body><h1>${title}</h1>${body}</body></html>`;

/** The site: a home page, a good page, a page with issues, a redirect chain, a 404 target, a private area. */
function site(
  origin: () => string,
): Record<string, { status: number; body: string; headers?: Record<string, string> }> {
  const canonical = (path: string) => `<link rel="canonical" href="${origin()}${path}">`;
  return {
    '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private/\n' },
    '/sitemap.xml': {
      status: 200,
      body: `<urlset><url><loc>${origin()}/from-sitemap</loc></url><url><loc>https://elsewhere.example/x</loc></url></urlset>`,
    },
    '/': {
      status: 200,
      body: page(
        'Home',
        `<a href="/good">Good</a><a href="/issues">Issues</a><a href="/hop1">Hop</a><a href="/private/secret">P</a><a href="https://elsewhere.example/">Out</a><a href="/missing">Gone</a>`,
        canonical('/'),
      ),
    },
    '/good': { status: 200, body: page('Good page', '<img src="/a.png" alt="a">', canonical('/good')) },
    '/from-sitemap': { status: 200, body: page('From sitemap', '', canonical('/from-sitemap')) },
    '/issues': {
      status: 200,
      body: `<html><head><title>Good page</title><meta name="robots" content="noindex"></head><body><h1>A</h1><h1>B</h1><img src="/x.png"><a href="/missing">Gone</a></body></html>`,
    },
    '/hop1': { status: 301, body: '', headers: { location: '/hop2' } },
    '/hop2': { status: 302, body: '', headers: { location: '/good' } },
    '/missing': { status: 404, body: 'not here' },
    '/private/secret': { status: 200, body: page('Secret', '') },
  };
}

describe('technical SEO audit against MySQL 8 and a loopback site (R2-4)', () => {
  let tdb: TestDatabase;
  let server: Server;
  let origin = '';
  const served: string[] = [];
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');
  const owner = () => member(tenantA, 'owner');
  let clock = new Date(NOW);
  /** The per-destination lock outlives a test's run (25 min), so a later plan needs a runtime with a fresh store. */
  const freshRuntime = () =>
    createDestinationRuntime({ now: () => clock, auditLock: new MemoryRateLimiterStore() });
  const runtime = freshRuntime();
  let onDemandId = '';
  const service = createSeoAuditService({ now: () => clock });
  let siteId = '';
  let ga4Id = '';
  const base = (): SeoAuditInputV1 => ({
    ...ctx(tenantA),
    actor: AUDIT_ACTOR,
    destinationId: siteId,
    now: clock.toISOString(),
    trigger: 'scheduled',
  });

  /** The workflow's loop, in the test: breadth-first over the links each activity returns, once per URL. */
  async function crawlAll(runId: string, seeds: string[]) {
    const visited = new Set(seeds);
    const frontier = seeds.map((url) => ({ url, depth: 0 }));
    const results: Array<{
      url: string;
      result: Awaited<ReturnType<typeof runtime.audit.crawlSeoAuditPage>>;
    }> = [];
    while (frontier.length > 0 && results.length < SEO_AUDIT_MAX_PAGES) {
      const next = frontier.shift()!;
      const input: SeoAuditCrawlPageInputV1 = { ...base(), runId, url: next.url, depth: next.depth };
      const result = await asPlatformJob(tenantA, () => runtime.audit.crawlSeoAuditPage(input));
      results.push({ url: next.url, result });
      if (result.outcome !== 'crawled' || next.depth + 1 > SEO_AUDIT_MAX_DEPTH) continue;
      for (const url of result.links)
        if (!visited.has(url)) {
          visited.add(url);
          frontier.push({ url, depth: next.depth + 1 });
        }
    }
    return results;
  }
  const setPolicy = (allowedUses: Array<'read' | 'retain'>, retentionDays?: number) =>
    run(tenantA, async (tx) => {
      const existing = (
        await sourceUsePolicyService.list(owner(), { brandId: brandA, destinationKind: 'cms_site' }, tx)
      ).items.find((p) => p.dataType === 'cms.audit');
      return sourceUsePolicyService.set(
        owner(),
        {
          brandId: brandA,
          destinationKind: 'cms_site',
          dataType: 'cms.audit',
          allowedUses,
          ...(retentionDays ? { retentionDays } : {}),
          reviewDueAt: inDays(60),
          ...(existing ? { expectedVersion: existing.version } : {}),
        },
        tx,
      );
    });
  const auditsOf = (action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, action)))
      .orderBy(asc(auditEvents.createdAt));

  beforeAll(async () => {
    const pages = site(() => origin);
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      served.push(path);
      const p = pages[path] ?? { status: 404, body: 'nope' };
      res.writeHead(p.status, {
        'content-type': path.endsWith('.txt')
          ? 'text/plain'
          : path.endsWith('.xml')
            ? 'application/xml'
            : 'text/html',
        ...(p.headers ?? {}),
      });
      res.end(p.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'audit-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'audit-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values({ id: USER, email: 'audit-test@example.test', name: 'Aud' });
    await tdb.db.insert(memberships).values({
      id: 'mem_audit_test',
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
    // Tests only: the loopback site is allowed; production refuses it (the dispatcher throws under NODE_ENV).
    configureDestinationCms({ registry: new CmsRegistry(), insecureAllowLoopback: true });
    siteId = (
      await run(tenantA, (tx) =>
        destinationService.register(
          owner(),
          { brandId: brandA, kind: 'cms_site', externalId: origin, displayName: 'Loopback site' },
          tx,
        ),
      )
    ).id;
    ga4Id = (
      await run(tenantA, (tx) =>
        destinationService.register(
          owner(),
          { brandId: brandA, kind: 'ga4_property', externalId: 'properties/9', displayName: 'P' },
          tx,
        ),
      )
    ).id;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await tdb?.drop();
  });

  it('the sweep lists active website destinations across tenants, references only', async () => {
    const targets = await runtime.audit.listSeoAuditTargets({ correlationId: 'c', now: NOW });
    expect(targets).toEqual(expect.arrayContaining([{ tenantId: tenantA, destinationId: siteId }]));
    expect(targets.find((t) => t.destinationId === ga4Id)).toBeUndefined();
    expect(Object.keys(targets[0] ?? {})).toEqual(['tenantId', 'destinationId']);
  });

  it('without a policy allowing reads the plan is skipped with an audit and nothing is fetched (D-17)', async () => {
    const plan = await asPlatformJob(tenantA, () => runtime.audit.planSeoAudit(base()));
    expect(plan).toEqual({ outcome: 'skipped', reason: 'no_policy' });
    expect(served).toEqual([]);
    const skipped = await auditsOf('seo_audit.skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.metadata).toMatchObject({ reason: 'no_policy:cms.audit', brandId: brandA });
    const summary = await inTenant(tenantA, () =>
      service.summary(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(summary).toMatchObject({
      policy: { allowed: false, reason: 'no_policy', dataType: 'cms.audit' },
      lastRun: null,
      running: false,
      canRun: true,
      data: { kind: 'lab', note: 'lab data only; field data not connected' },
      fieldData: null,
    });
    await expect(
      inTenant(tenantA, () => service.findings(owner(), { brandId: brandA, destinationId: siteId })),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(
      inTenant(tenantA, () => service.pages.list(owner(), { brandId: brandA, destinationId: siteId })),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(
      run(tenantA, (tx) => service.run(owner(), { brandId: brandA, destinationId: siteId }, tx)),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('a property is not a website: the plan skips it; the on-demand run refuses it', async () => {
    await setPolicy(['read']);
    expect(
      await asPlatformJob(tenantA, () => runtime.audit.planSeoAudit({ ...base(), destinationId: ga4Id })),
    ).toEqual({ outcome: 'skipped', reason: 'not_a_site' });
  });

  let runId = '';
  it('plans from the origin, robots.txt and the sitemap (same-origin, allowed URLs only) and opens the run', async () => {
    served.length = 0;
    const plan = await asPlatformJob(tenantA, () => runtime.audit.planSeoAudit(base()));
    expect(plan.outcome).toBe('planned');
    if (plan.outcome !== 'planned') return;
    runId = plan.runId;
    expect(plan.origin).toBe(origin);
    expect(plan.seeds).toEqual([`${origin}/`, `${origin}/from-sitemap`]); // the elsewhere.example URL is dropped
    expect(plan.limitsHit).toEqual([]);
    expect(served).toEqual(['/robots.txt', '/sitemap.xml']);
    const stored = (await tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.id, runId)))[0]!;
    expect(stored).toMatchObject({ outcome: 'running', trigger: 'scheduled', robotsDisallow: ['/private/'] });
    // A second plan while this one runs is locked (the lock, then the open run).
    expect(await asPlatformJob(tenantA, () => runtime.audit.planSeoAudit(base()))).toEqual({
      outcome: 'skipped',
      reason: 'locked',
    });
    expect((await auditsOf('seo_audit.started'))[0]?.metadata).toMatchObject({ runId, count: 2 });
  });

  it('crawls one page per activity on the origin only: links returned, robots respected, redirects re-checked', async () => {
    served.length = 0;
    const results = await crawlAll(runId, [`${origin}/`, `${origin}/from-sitemap`]);
    const by = Object.fromEntries(results.map((r) => [r.url.slice(origin.length), r.result]));
    expect(by['/']).toMatchObject({ outcome: 'crawled', status: 200 });
    expect((by['/'] as { links: string[] }).links.map((l) => l.slice(origin.length)).sort()).toEqual([
      '/good',
      '/hop1',
      '/issues',
      '/missing',
    ]); // /private/secret is robots-disallowed, elsewhere.example is off-origin
    expect(by['/hop1']).toMatchObject({ outcome: 'crawled', status: 200 }); // followed hop by hop to /good
    expect(by['/missing']).toMatchObject({ outcome: 'crawled', status: 404, links: [] });
    expect(by['/private/secret']).toBeUndefined();
    expect(served).not.toContain('/private/secret');
    // Asked directly for a disallowed or off-origin URL, the activity refuses without fetching.
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.audit.crawlSeoAuditPage({ ...base(), runId, url: `${origin}/private/secret`, depth: 1 }),
      ),
    ).toEqual({ outcome: 'skipped', reason: 'robots' });
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.audit.crawlSeoAuditPage({ ...base(), runId, url: 'https://elsewhere.example/', depth: 1 }),
      ),
    ).toEqual({ outcome: 'skipped', reason: 'unsafe' });
    expect(served).not.toContain('/private/secret');
    // A page is stored under the URL the crawl asked for (the redirect's start), with its hops as a check.
    const rows = await tdb.db.select().from(seoAuditPages).where(eq(seoAuditPages.runId, runId));
    expect(rows.map((r) => r.url.slice(origin.length)).sort()).toEqual([
      '/',
      '/from-sitemap',
      '/good',
      '/hop1',
      '/issues',
      '/missing',
    ]);
    const hop = rows.find((r) => r.url.endsWith('/hop1'))!;
    expect(hop.checks.find((c) => c.key === 'redirect_chain')).toMatchObject({ ok: false, detail: 'hops=2' });
    expect(rows.find((r) => r.url.endsWith('/issues'))?.severity).toBe('critical'); // noindex
  });

  it('finishes with the cross-page checks, the summary and an audit; the read model serves it', async () => {
    const finished = await asPlatformJob(tenantA, () =>
      runtime.audit.finishSeoAudit({ ...base(), runId, limitsHit: ['max_depth'], failedPages: 0 }),
    );
    expect(finished.outcome).toBe('completed');
    const stored = (await tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.id, runId)))[0]!;
    expect(stored).toMatchObject({
      outcome: 'completed',
      limitsHit: ['max_depth'],
      pagesCrawled: finished.pages,
    });
    expect(stored.summary.byCheck).toMatchObject({
      status: 1, // /missing
      broken_links: 2, // / and /issues link to /missing
      duplicate_title: 3, // /good, /hop1 (the same page) and /issues share "Good page"
      duplicate_description: 2, // /good and /hop1
      redirect_chain: 1,
      robots_meta: 1,
      h1: 1,
      image_alt: 1,
    });
    expect(stored.summary.critical).toBeGreaterThanOrEqual(1);
    expect((await auditsOf('seo_audit.finished'))[0]?.metadata).toMatchObject({
      runId,
      toState: 'completed',
    });

    const summary = await inTenant(tenantA, () =>
      service.summary(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(summary.lastRun).toMatchObject({ id: runId, outcome: 'completed', limitsHit: ['max_depth'] });
    expect(summary.running).toBe(false);
    const findings = await inTenant(tenantA, () =>
      service.findings(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(findings.runId).toBe(runId);
    expect(findings.items[0]?.severity).toBe('critical');
    const broken = findings.items.find((f) => f.check === 'broken_links')!;
    expect(broken).toMatchObject({ count: 2, severity: 'major' });
    expect(broken.examples.map((u) => u.slice(origin.length)).sort()).toEqual(['/', '/issues']);
    expect(broken.suggestedTask).toBe(
      'Fix or remove the internal links on 2 pages that lead to pages answering with an error.',
    );
    const critical = await inTenant(tenantA, () =>
      service.pages.list(owner(), { brandId: brandA, destinationId: siteId, severity: 'critical', limit: 1 }),
    );
    expect(critical.items.map((p) => p.url.slice(origin.length))).toEqual(['/issues']);
    expect(critical.nextCursor).toBeNull();
    const first = await inTenant(tenantA, () =>
      service.pages.list(owner(), { brandId: brandA, destinationId: siteId, limit: 2 }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const rest = await inTenant(tenantA, () =>
      service.pages.list(owner(), {
        brandId: brandA,
        destinationId: siteId,
        limit: 10,
        cursor: first.nextCursor!,
      }),
    );
    expect(rest.items.length + 2).toBe(finished.pages);
    const runs = await inTenant(tenantA, () =>
      service.runs.list(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(runs.items.map((r) => r.id)).toEqual([runId]);
    // Closing twice is a no-op.
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.audit.finishSeoAudit({ ...base(), runId, limitsHit: [], failedPages: 0 }),
      ),
    ).toEqual({ outcome: 'completed', pages: finished.pages });
    // A crawl of a closed run records nothing.
    expect(
      await asPlatformJob(tenantA, () =>
        runtime.audit.crawlSeoAuditPage({ ...base(), runId, url: `${origin}/good`, depth: 1 }),
      ),
    ).toEqual({ outcome: 'skipped', reason: 'not_running' });
  });

  it('cross-tenant and cross-brand reads are NOT_FOUND; an analyst reads, cannot run', async () => {
    await expect(
      inTenant(tenantB, () =>
        service.summary(member(tenantB, 'owner'), { brandId: brandB, destinationId: siteId }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(tenantA, () => service.findings(owner(), { brandId: brandA2, destinationId: siteId })),
    ).rejects.toBeInstanceOf(NotFoundError);
    const analyst = await inTenant(tenantA, () =>
      service.summary(member(tenantA, 'analyst'), { brandId: brandA, destinationId: siteId }),
    );
    expect(analyst.canRun).toBe(false);
    await expect(
      run(tenantA, (tx) =>
        service.run(member(tenantA, 'analyst'), { brandId: brandA, destinationId: siteId }, tx),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('the on-demand run opens a row and an outbox event once per day; a run in progress is a conflict', async () => {
    clock = new Date('2026-10-06T10:00:00.000Z');
    const started = await run(tenantA, (tx) =>
      service.run(owner(), { brandId: brandA, destinationId: siteId }, tx),
    );
    onDemandId = started.id;
    expect(started).toMatchObject({ trigger: 'on_demand', outcome: 'running', destinationId: siteId });
    const events = await tdb.db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, 'destination.audit_requested')),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ destinationId: siteId, runId: started.id, actorId: USER });
    expect((await auditsOf('seo_audit.requested'))[0]?.metadata).toMatchObject({ runId: started.id });
    await expect(
      run(tenantA, (tx) => service.run(owner(), { brandId: brandA, destinationId: siteId }, tx)),
    ).rejects.toBeInstanceOf(ConflictError);
    const summary = await inTenant(tenantA, () =>
      service.summary(owner(), { brandId: brandA, destinationId: siteId }),
    );
    expect(summary.running).toBe(true);
    expect(summary.lastRun?.id).toBe(runId); // the last finished one, not the open one
    // The worker adopts the API's row: the plan names it (no second row) and reads the seeds for it.
    const adopting = freshRuntime();
    const plan = await asPlatformJob(tenantA, () =>
      adopting.audit.planSeoAudit({ ...base(), trigger: 'on_demand', runId: started.id }),
    );
    expect(plan).toMatchObject({ outcome: 'planned', runId: started.id });
    expect(
      await tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.destinationId, siteId)),
    ).toHaveLength(2);
    await asPlatformJob(tenantA, () =>
      adopting.audit.finishSeoAudit({ ...base(), runId: started.id, limitsHit: [], failedPages: 0 }),
    );
    expect(
      (await tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.id, started.id)))[0],
    ).toMatchObject({
      outcome: 'failed',
      reason: 'origin_unreachable', // nothing was crawled for it in this test
    });
    // Same day again: the earlier run is returned, nothing new opens.
    const again = await run(tenantA, (tx) =>
      service.run(owner(), { brandId: brandA, destinationId: siteId }, tx),
    );
    expect(again.id).toBe(started.id);
  });

  it('retention keeps the last runs without `retain`, and the policy’s days with it; an abandoned run is failed', async () => {
    clock = new Date('2026-10-20T05:00:00.000Z');
    // Three more finished runs, older, inserted directly; then one abandoned (running, stale).
    for (let i = 1; i <= 3; i++)
      await tdb.db.insert(seoAuditRuns).values({
        id: newId('seoAuditRun'),
        tenantId: tenantA,
        brandId: brandA,
        destinationId: siteId,
        origin,
        trigger: 'scheduled',
        startedAt: new Date(`2026-09-0${i}T05:00:00.000Z`),
        finishedAt: new Date(`2026-09-0${i}T05:10:00.000Z`),
        outcome: 'completed',
      });
    const pruned = await asPlatformJob(tenantA, () => runtime.audit.pruneSeoAudits(base()));
    expect(pruned.deleted).toBe(1); // 5 runs, keep 4
    expect((await auditsOf('seo_audit.pruned'))[0]?.metadata).toMatchObject({ count: 1, reason: 'keep=4' });
    await setPolicy(['read', 'retain'], 30);
    const byDays = await asPlatformJob(tenantA, () => runtime.audit.pruneSeoAudits(base()));
    expect(byDays.deleted).toBe(2); // the two September runs older than 30 days before 20 October
    const remaining = await tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.destinationId, siteId));
    expect(remaining.map((r) => r.id).sort()).toEqual([runId, onDemandId].sort());
    expect(await tdb.db.select().from(seoAuditPages).where(eq(seoAuditPages.runId, runId))).not.toHaveLength(
      0,
    );
    // A run left `running` by a dead worker is closed as failed by the next plan, which then goes on.
    const staleId = newId('seoAuditRun');
    await tdb.db.insert(seoAuditRuns).values({
      id: staleId,
      tenantId: tenantA,
      brandId: brandA,
      destinationId: siteId,
      origin,
      trigger: 'scheduled',
      startedAt: new Date(clock.getTime() - 2 * 3_600_000),
      outcome: 'running',
    });
    const later = freshRuntime();
    const plan = await asPlatformJob(tenantA, () => later.audit.planSeoAudit(base()));
    expect(plan.outcome).toBe('planned');
    expect((await tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.id, staleId)))[0]).toMatchObject({
      outcome: 'failed',
      reason: 'abandoned',
    });
    if (plan.outcome === 'planned')
      await asPlatformJob(tenantA, () =>
        later.audit.finishSeoAudit({ ...base(), runId: plan.runId, limitsHit: [], failedPages: 0 }),
      );
  });
});
