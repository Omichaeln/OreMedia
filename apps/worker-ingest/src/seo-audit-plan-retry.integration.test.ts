import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { SeoAuditActivitiesV1, SeoAuditInputV1 } from '@oremedia/contracts/seo-audit';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
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
import { MemoryRateLimiterStore } from '@oremedia/module-operations';
import { CmsRegistry } from '@oremedia/providers';
import { runSeoAudit } from '@oremedia/workflows/seo-audit.workflow.v1';

/**
 * A retried scheduled plan (seoAuditWorkflowV2 retries planSeoAudit up to three times with the same input) whose
 * first attempt already opened the run: the retry resumes that run and the crawl proceeds, rather than answering
 * `locked` and leaving the run `running` until a later plan fails it as abandoned. A genuinely concurrent other run
 * is still refused. The activities are the production factory over the real audit runtime, against MySQL and a
 * loopback website; the orchestration is the workflow's own runSeoAudit, with planSeoAudit retried as Temporal
 * retries it. Kept apart from seo-audit-activities.integration.test.ts (the activity-host tests).
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const NOW = '2026-10-05T05:00:00.000Z';
/** seoAuditWorkflowV2's retry policy for planSeoAudit. */
const PLAN_ATTEMPTS = 3;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="A description long enough to pass the length rule for ${title} on this site.">
<meta name="viewport" content="width=device-width"></head><body><h1>${title}</h1>${body}</body></html>`;

interface Site {
  tenantId: string;
  brandId: string;
  destinationId: string;
}

describe('a retried SEO audit plan resumes the run it opened (worker-ingest, MySQL, loopback site)', () => {
  let tdb: TestDatabase;
  let server: Server;
  let origin = '';
  const served: string[] = [];
  /** The lock store the worker shares between attempts (Redis in production). */
  const auditLock = new MemoryRateLimiterStore();
  const acts = createSeoAuditActivities(createDestinationRuntime({ auditLock }).audit);
  const host = { now: () => Date.parse(NOW), sleep: async () => {} };

  const input = (site: Site, now = NOW): SeoAuditInputV1 => ({
    tenantId: site.tenantId,
    actor: SEO_AUDIT_ACTOR,
    correlationId: `corr_retry:${site.destinationId}`,
    destinationId: site.destinationId,
    now,
    trigger: 'scheduled',
  });
  const lockKey = (site: Site) => `lock:seo-audit-sweep:${site.tenantId}:${site.destinationId}`;
  const runsOf = (site: Site) =>
    tdb.db.select().from(seoAuditRuns).where(eq(seoAuditRuns.destinationId, site.destinationId));
  const pagesOf = (runId: string) =>
    tdb.db.select().from(seoAuditPages).where(eq(seoAuditPages.runId, runId));
  const startedAudits = (site: Site) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, site.tenantId),
          eq(auditEvents.action, 'seo_audit.started'),
          eq(auditEvents.resourceId, site.destinationId),
        ),
      );

  /**
   * The activities as seoAuditWorkflowV2 sees them when planSeoAudit's first attempt commits its run and then
   * fails: `afterCommit` is what happened to that attempt; Temporal retries with the same input.
   */
  function retriedPlan(afterCommit: (attempt: SeoAuditInputV1) => Promise<void>) {
    const attempts: Array<Awaited<ReturnType<SeoAuditActivitiesV1['planSeoAudit']>>> = [];
    const retried: SeoAuditActivitiesV1 = {
      ...acts,
      async planSeoAudit(i) {
        for (let attempt = 1; ; attempt++) {
          try {
            const plan = await acts.planSeoAudit(i);
            attempts.push(plan);
            if (attempt === 1) {
              await afterCommit(i);
              throw new Error('attempt 1 failed after its commit');
            }
            return plan;
          } catch (err) {
            if (attempt >= PLAN_ATTEMPTS) throw err;
          }
        }
      },
    };
    return { acts: retried, attempts };
  }

  async function site(label: string, externalId: string): Promise<Site> {
    const tenantId = newId('ten');
    const brandId = newId('brd');
    const userId = newId('usr');
    const membershipId = newId('mem');
    await tdb.db.insert(tenants).values({
      id: tenantId,
      name: label,
      slug: `audit-retry-${label}-${tenantId.slice(-6).toLowerCase()}`,
    });
    await tdb.db.insert(users).values({
      id: userId,
      email: `audit-retry-${userId.slice(-6).toLowerCase()}@example.test`,
      name: label,
    });
    await tdb.db.insert(memberships).values({
      id: membershipId,
      tenantId,
      userId,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(brands).values({
      id: brandId,
      tenantId,
      name: label,
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    const owner: ResolvedActor = {
      kind: 'user',
      id: userId,
      tenantId,
      membershipId,
      membershipStatus: 'active',
      role: 'owner',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    const ctx: TenantContext = {
      tenantId,
      actor: { kind: 'user', id: userId },
      brandIds: 'all',
      correlationId: 'corr_retry',
    };
    const destinationId = await runInTenant(ctx, () =>
      withTransaction(async (tx) => {
        const row = await destinationService.register(
          owner,
          { brandId, kind: 'cms_site', externalId, displayName: 'Loopback site' },
          tx,
        );
        await sourceUsePolicyService.set(
          owner,
          {
            brandId,
            destinationKind: 'cms_site',
            dataType: 'cms.audit',
            allowedUses: ['read'],
            reviewDueAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
          },
          tx,
        );
        return row.id;
      }),
    );
    return { tenantId, brandId, destinationId };
  }

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
    // Tests only: the loopback site is allowed; production refuses it (the dispatcher throws under NODE_ENV).
    configureDestinationCms({ registry: new CmsRegistry(), insecureAllowLoopback: true });
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await tdb?.drop();
  });

  it('a plan whose result was lost after its commit (lock still held) is retried: the same run is crawled and finished', async () => {
    const s = await site('lost', origin);
    // Attempt 1 committed its run and its result never reached the workflow (worker died, timeout): nothing
    // released the lock.
    const { acts: retried, attempts } = retriedPlan(async () => {});
    const outcome = await runSeoAudit(retried, input(s), host);

    expect(attempts).toHaveLength(2);
    const [first, second] = attempts;
    expect(first).toMatchObject({ outcome: 'planned', origin, seeds: [`${origin}/`] });
    expect(second).toEqual(first);
    if (first?.outcome !== 'planned') throw new Error('expected a plan');
    expect(outcome).toMatchObject({ outcome: 'completed', runId: first.runId, crawled: 2, failed: 0 });
    const runs = await runsOf(s);
    expect(runs.map((r) => r.id)).toEqual([first.runId]);
    expect(runs[0]).toMatchObject({ outcome: 'completed', pagesCrawled: 2, trigger: 'scheduled' });
    expect((await pagesOf(first.runId)).map((p) => p.url).sort()).toEqual([`${origin}/`, `${origin}/good`]);
    // One run, one start audit: the resumed plan does not record its start twice.
    expect(await startedAudits(s)).toHaveLength(1);
    expect(served).not.toContain('/private/x');
    // The finish released the lock: next week's plan is not refused.
    expect(await auditLock.hit(lockKey(s), 60)).toMatchObject({ count: 1 });
    await auditLock.reset(lockKey(s));
  });

  it('a plan that failed after its commit (lock released) is retried: the same run is crawled, not left running', async () => {
    const s = await site('failed', origin);
    // Attempt 1 threw after opening its run; planSeoAudit releases the lock it took on a throw.
    const { acts: retried, attempts } = retriedPlan(() => auditLock.reset(lockKey(s)));
    const outcome = await runSeoAudit(retried, input(s), host);

    expect(attempts).toHaveLength(2);
    const [first, second] = attempts;
    if (first?.outcome !== 'planned') throw new Error('expected a plan');
    expect(second).toEqual(first);
    expect(outcome).toMatchObject({ outcome: 'completed', runId: first.runId, crawled: 2 });
    const runs = await runsOf(s);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: first.runId, outcome: 'completed', pagesCrawled: 2 });
    expect(await startedAudits(s)).toHaveLength(1);
  });

  it('a different run in progress still refuses the plan: locked, nothing opened, the other run untouched', async () => {
    const s = await site('busy', origin);
    // Another scheduled run of the destination (another key: a sweep ten minutes earlier), short of
    // SEO_AUDIT_RUN_STALE_MS, so not abandoned.
    const other = newId('sar');
    await tdb.db.insert(seoAuditRuns).values({
      id: other,
      tenantId: s.tenantId,
      brandId: s.brandId,
      destinationId: s.destinationId,
      origin,
      trigger: 'scheduled',
      startedAt: new Date(Date.parse(NOW) - 10 * 60_000),
      outcome: 'running',
    });
    const before = await runsOf(s);
    served.length = 0;

    expect(await acts.planSeoAudit(input(s))).toEqual({ outcome: 'skipped', reason: 'locked' });
    // Its own retry is refused the same way: the open run is not of this plan's key.
    expect(await acts.planSeoAudit(input(s))).toEqual({ outcome: 'skipped', reason: 'locked' });
    expect(await runsOf(s)).toEqual(before);
    expect(served).toEqual([]);
    expect(await startedAudits(s)).toEqual([]);

    // The lock held by another plan (no run of this key opened): refused too, and the lock is left to its holder.
    await tdb.db.delete(seoAuditRuns).where(eq(seoAuditRuns.id, other));
    await auditLock.hit(lockKey(s), 60);
    expect(await acts.planSeoAudit(input(s))).toEqual({ outcome: 'skipped', reason: 'locked' });
    expect(await runsOf(s)).toEqual([]);
    expect((await auditLock.hit(lockKey(s), 60)).count).toBeGreaterThan(1);
    await auditLock.reset(lockKey(s));
  });
});
