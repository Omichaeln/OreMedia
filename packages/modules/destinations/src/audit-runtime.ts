import type { ActivityHooks } from '@oremedia/contracts/agents';
import {
  CMS_AUDIT_DATA_TYPE,
  SEO_AUDIT_DESTINATION_KIND,
  SEO_AUDIT_FETCH_TIMEOUT_MS,
  SEO_AUDIT_KEEP_RUNS,
  SEO_AUDIT_LOCK_SECONDS,
  SEO_AUDIT_MAX_HOPS,
  SEO_AUDIT_PAGE_MAX_BYTES,
  SEO_AUDIT_RUN_STALE_MS,
  SEO_AUDIT_SITEMAP_SEEDS,
  type SeoAuditCrawlPageInputV1,
  type SeoAuditCrawlPageResultV1,
  type SeoAuditFinishInputV1,
  type SeoAuditInputV1,
  type SeoAuditLimit,
  type SeoAuditPlanV1,
  type SeoAuditRuntimeV1,
  type SeoAuditSweepInputV1,
} from '@oremedia/contracts/seo-audit';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import { requireTenant, runAsPlatform, withTransaction, type Tx } from '@oremedia/db';
import { sha256Hex } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { MemoryRateLimiterStore, audit, type RateLimiterStore } from '@oremedia/module-operations';
import { logger } from '@oremedia/observability';
import {
  BlockedAddressError,
  ProviderTransportError,
  RenderedPageError,
  assertSafeUrl,
  fetchPageBounded,
  type ProviderIO,
} from '@oremedia/providers';
import {
  auditPage,
  crossPageChecks,
  isHtml,
  pageSeverity,
  robotsAllows,
  robotsDisallowFor,
  sameOriginUrl,
  sitemapUrls,
  summarise,
} from './audit-crawl';
import { cmsIO } from './cms';
import {
  BrandDestinationRepository,
  SeoAuditPageRepository,
  SeoAuditRunRepository,
  SeoAuditTargetRepository,
  SourceUsePolicyRepository,
} from './repositories';
import { sourceUseDecision } from './service';

const destinationsRepo = new BrandDestinationRepository();
const policiesRepo = new SourceUsePolicyRepository();
const runsRepo = new SeoAuditRunRepository();
const pagesRepo = new SeoAuditPageRepository();
const targetsRepo = new SeoAuditTargetRepository();
/** The platform job the target listing declares (spec 5.3); references only leave it. */
const AUDIT_JOB = 'seo-audit-sweep';
/** robots.txt and a sitemap are read against this cap (a bigger one is read truncated, never more). */
const CONTROL_FILE_MAX_BYTES = 512 * 1024;
/** Nested sitemaps of an index read (one level deep, R2-4). */
const SITEMAP_INDEX_MAX = 5;
/** A scheduled run is skipped when any run started inside this window (an on-demand run this week suffices). */
const SCHEDULED_REPEAT_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;

export interface SeoAuditRuntimeOptions {
  now?: () => Date;
  /** Per-destination run lock (Redis-backed in production; memory by default). */
  auditLock?: RateLimiterStore;
}

/**
 * The runtime behind seoAuditSweepWorkflowV1 and seoAuditWorkflowV1 (ledger R2-4; worker-ingest): the websites to
 * audit across tenants, and per destination the policy gate, the lock, the run row, the seeds (origin, robots.txt,
 * sitemap), one bounded page fetch per activity (SSRF-checked per hop, pinned to the origin, no credentials), the
 * cross-page checks and the summary at finish, the audit of the outcome and the retention prune. Modelled on the
 * report runtime (report-runtime.ts). Bodies never enter Temporal: an activity returns a status and links only.
 */
export function createSeoAuditRuntime(opts: SeoAuditRuntimeOptions = {}): SeoAuditRuntimeV1 {
  const now = opts.now ?? (() => new Date());
  const auditLock = opts.auditLock ?? new MemoryRateLimiterStore();
  const log = logger().child('destinations');
  const workflowActor = () => requireTenant().actor;

  const skippedAudit = (row: { id: string; brandId: string; kind: string }, reason: string, tx: Tx) =>
    audit.record(
      workflowActor(),
      'seo_audit.skipped',
      { type: 'brand_destination', id: row.id },
      'denied',
      tx,
      { brandId: row.brandId, kind: row.kind, reason },
    );

  const io = (tenantId: string, hooks?: ActivityHooks): ProviderIO =>
    cmsIO(SEO_AUDIT_DESTINATION_KIND, tenantId, {
      timeoutMs: SEO_AUDIT_FETCH_TIMEOUT_MS,
      ...(hooks ? { hooks } : {}),
    });

  /** A control file (robots.txt, a sitemap) as text when the site serves it with 200; null otherwise. */
  async function readControlFile(client: ProviderIO, url: string, host: string): Promise<string | null> {
    try {
      const page = await fetchPageBounded(client, url, {
        host,
        maxBytes: CONTROL_FILE_MAX_BYTES,
        maxHops: SEO_AUDIT_MAX_HOPS,
        accept: 'text/plain, application/xml, text/xml',
      });
      return page.status === 200 ? page.html : null;
    } catch (err) {
      if (
        err instanceof RenderedPageError ||
        err instanceof ProviderTransportError ||
        err instanceof BlockedAddressError
      )
        return null;
      throw err;
    }
  }

  return {
    listSeoAuditTargets: ({ correlationId }: SeoAuditSweepInputV1) =>
      runAsPlatform(AUDIT_JOB, correlationId, () => targetsRepo.listTargets(SEO_AUDIT_DESTINATION_KIND)),

    async planSeoAudit(input: SeoAuditInputV1): Promise<SeoAuditPlanV1> {
      const { tenantId, destinationId } = input;
      const at = new Date(input.now);
      const row = await destinationsRepo.getById(destinationId); // a foreign id is NOT_FOUND
      if (row.status !== 'active') return { outcome: 'skipped', reason: 'not_active' };
      if (row.kind !== SEO_AUDIT_DESTINATION_KIND) return { outcome: 'skipped', reason: 'not_a_site' };
      let origin: string;
      let host: string;
      try {
        const u = assertSafeUrl(row.externalId);
        origin = u.origin;
        host = u.host;
      } catch {
        await withTransaction((tx) => skippedAudit(row, 'origin_unsafe', tx));
        return { outcome: 'skipped', reason: 'origin_unsafe' };
      }
      // D-17: no crawl without a current policy allowing it; the refusal is recorded, nothing is fetched.
      const decision = sourceUseDecision(
        await policiesRepo.findByKey(row.brandId, row.kind, CMS_AUDIT_DATA_TYPE),
        'read',
        at,
      );
      if (!decision.allowed) {
        await withTransaction((tx) => skippedAudit(row, `${decision.reason}:${CMS_AUDIT_DATA_TYPE}`, tx));
        return {
          outcome: 'skipped',
          reason: decision.reason as 'no_policy' | 'review_overdue' | 'not_allowed',
        };
      }
      const lock = await auditLock.hit(
        `lock:${AUDIT_JOB}:${tenantId}:${destinationId}`,
        SEO_AUDIT_LOCK_SECONDS,
      );
      if (lock.count > 1) return { outcome: 'skipped', reason: 'locked' };
      // A run still open: in progress (skip) or abandoned by a dead worker (closed as failed, then on we go).
      const open = await runsRepo.latest(row.brandId, row.id, 'running');
      if (open && open.id !== input.runId) {
        if (at.getTime() - open.startedAt.getTime() < SEO_AUDIT_RUN_STALE_MS)
          return { outcome: 'skipped', reason: 'locked' };
        await withTransaction(async (tx) => {
          const locked = await runsRepo.lock(open.id, tx);
          if (locked.outcome === 'running')
            await runsRepo.update(
              locked.id,
              locked.version,
              { outcome: 'failed', reason: 'abandoned', finishedAt: now() },
              tx,
            );
        });
      }
      if (input.trigger === 'scheduled') {
        const recent = await runsRepo.startedBetween(
          row.brandId,
          row.id,
          new Date(at.getTime() - SCHEDULED_REPEAT_MS),
          new Date(at.getTime() + DAY_MS),
        );
        if (recent.some((r) => r.id !== input.runId)) return { outcome: 'skipped', reason: 'already_ran' };
      }
      // The run row: the API created an on-demand one when the person asked; a scheduled run creates its own.
      let runId = input.runId ?? null;
      if (runId) {
        const existing = await runsRepo.getById(runId);
        if (existing.destinationId !== row.id)
          throw new ValidationFailedError([{ path: 'runId', issue: 'other_destination' }]);
        if (existing.outcome !== 'running') return { outcome: 'skipped', reason: 'already_ran' };
      } else {
        runId = newId('seoAuditRun');
        const id = runId;
        await withTransaction((tx) =>
          runsRepo.create(
            {
              id,
              brandId: row.brandId,
              destinationId: row.id,
              origin,
              trigger: input.trigger,
              requestedById: null,
              startedAt: at,
              outcome: 'running',
            },
            tx,
          ),
        );
      }
      // The seeds: the origin itself, then what robots.txt allows of the sitemap (an index one level deep).
      const client = io(tenantId);
      const limitsHit: SeoAuditLimit[] = [];
      const robotsText = await readControlFile(client, `${origin}/robots.txt`, host);
      const robots = robotsText ? robotsDisallowFor(robotsText) : { disallow: [], truncated: false };
      if (robots.truncated) limitsHit.push('robots_rules');
      const seeds = new Set<string>([`${origin}/`]);
      const sitemapText = await readControlFile(client, `${origin}/sitemap.xml`, host);
      if (sitemapText) {
        const listing = sitemapUrls(sitemapText);
        const urls = [...listing.urls];
        for (const nested of listing.sitemaps.slice(0, SITEMAP_INDEX_MAX)) {
          const target = sameOriginUrl(nested, origin, origin);
          if (!target) continue;
          const text = await readControlFile(client, target, host);
          if (text) urls.push(...sitemapUrls(text).urls);
        }
        for (const raw of urls) {
          const url = sameOriginUrl(raw, origin, origin);
          if (!url || !robotsAllows(robots.disallow, url)) continue;
          if (seeds.size >= SEO_AUDIT_SITEMAP_SEEDS + 1) {
            limitsHit.push('sitemap_seeds');
            break;
          }
          seeds.add(url);
        }
      }
      const id = runId;
      await withTransaction(async (tx) => {
        const locked = await runsRepo.lock(id, tx);
        await runsRepo.update(locked.id, locked.version, { robotsDisallow: robots.disallow, limitsHit }, tx);
        await audit.record(
          workflowActor(),
          'seo_audit.started',
          { type: 'brand_destination', id: row.id },
          'allowed',
          tx,
          { brandId: row.brandId, kind: row.kind, runId: id, count: seeds.size, reason: input.trigger },
        );
      });
      log.info({ destinationId, count: seeds.size, scope: input.trigger }, 'seo audit planned');
      return { outcome: 'planned', runId: id, origin, seeds: [...seeds], limitsHit };
    },

    async crawlSeoAuditPage(
      input: SeoAuditCrawlPageInputV1,
      hooks?: ActivityHooks,
    ): Promise<SeoAuditCrawlPageResultV1> {
      const run = await runsRepo.getById(input.runId); // a foreign id is NOT_FOUND
      if (run.destinationId !== input.destinationId)
        throw new ValidationFailedError([{ path: 'runId', issue: 'other_destination' }]);
      if (run.outcome !== 'running') return { outcome: 'skipped', reason: 'not_running' };
      // The URL is one the crawl found; it is checked here again, never trusted from the payload.
      const url = sameOriginUrl(input.url, run.origin, run.origin);
      if (!url) return { outcome: 'skipped', reason: 'unsafe' };
      try {
        assertSafeUrl(url);
      } catch {
        return { outcome: 'skipped', reason: 'unsafe' };
      }
      if (!robotsAllows(run.robotsDisallow, url)) return { outcome: 'skipped', reason: 'robots' };
      hooks?.heartbeat(`audit:${input.runId}:${input.depth}`);
      const host = new URL(run.origin).host;
      let facts;
      try {
        const page = await fetchPageBounded(io(input.tenantId, hooks), url, {
          host,
          maxBytes: SEO_AUDIT_PAGE_MAX_BYTES,
          maxHops: SEO_AUDIT_MAX_HOPS,
        });
        facts = {
          url,
          origin: run.origin,
          status: page.status,
          html: isHtml(page.contentType) ? page.html : '',
          bytes: page.bytes,
          truncated: page.truncated,
          hops: page.hops,
          contentType: page.contentType,
        };
      } catch (err) {
        if (
          !(err instanceof RenderedPageError) &&
          !(err instanceof ProviderTransportError) &&
          !(err instanceof BlockedAddressError)
        )
          throw err;
        log.warn(
          { destinationId: input.destinationId, errorName: (err as Error).name },
          'seo audit page unreachable',
        );
        facts = {
          url,
          origin: run.origin,
          status: null,
          html: '',
          bytes: 0,
          truncated: false,
          hops: 0,
          contentType: null,
        };
      }
      const result = auditPage(facts);
      const links = result.links.filter((l) => robotsAllows(run.robotsDisallow, l));
      await withTransaction((tx) =>
        pagesRepo.upsert(
          {
            id: newId('seoAuditPage'),
            brandId: run.brandId,
            runId: run.id,
            url,
            urlHash: sha256Hex(url),
            depth: input.depth,
            status: facts.status,
            bytes: facts.bytes,
            severity: pageSeverity(result.checks),
            checks: result.checks,
            title: result.title,
            metaDescription: result.metaDescription,
            links,
            fetchedAt: now(),
          },
          tx,
        ),
      );
      return { outcome: 'crawled', status: facts.status, links };
    },

    /** The cross-page checks, the summary counts and the run's close, under the row lock. */
    async finishSeoAudit({ runId, destinationId, limitsHit, failedPages }: SeoAuditFinishInputV1) {
      return withTransaction(async (tx) => {
        const locked = await runsRepo.lock(runId, tx);
        if (locked.destinationId !== destinationId)
          throw new ValidationFailedError([{ path: 'runId', issue: 'other_destination' }]);
        if (locked.outcome !== 'running') return { outcome: locked.outcome, pages: locked.pagesCrawled };
        const pages = await pagesRepo.listForRun(locked.brandId, locked.id, tx);
        const crossed = crossPageChecks(
          pages.map((p) => ({
            url: p.url,
            status: p.status,
            title: p.title,
            metaDescription: p.metaDescription,
            links: p.links,
            checks: p.checks as Parameters<typeof crossPageChecks>[0][number]['checks'],
          })),
        );
        const checked = [];
        for (const p of pages) {
          const checks =
            crossed.get(p.url) ?? (p.checks as Parameters<typeof summarise>[0][number]['checks']);
          const severity = pageSeverity(checks);
          if (crossed.has(p.url))
            await pagesRepo.setChecks(locked.brandId, p.id, { checks: [...checks], severity }, tx);
          checked.push({ severity, checks });
        }
        const summary = summarise(checked);
        const home = pages.find((p) => p.depth === 0 && p.status !== null);
        const outcome = pages.length === 0 || !home ? 'failed' : 'completed';
        const reason =
          outcome === 'failed'
            ? 'origin_unreachable'
            : failedPages > 0
              ? `failed_pages=${failedPages}`
              : null;
        await runsRepo.update(
          locked.id,
          locked.version,
          {
            outcome,
            reason,
            finishedAt: now(),
            pagesCrawled: pages.length,
            limitsHit: [...new Set([...locked.limitsHit, ...limitsHit])],
            summary,
          },
          tx,
        );
        await audit.record(
          workflowActor(),
          'seo_audit.finished',
          { type: 'brand_destination', id: locked.destinationId },
          outcome === 'completed' ? 'allowed' : 'denied',
          tx,
          {
            brandId: locked.brandId,
            runId: locked.id,
            count: pages.length,
            scope: [...new Set([...locked.limitsHit, ...limitsHit])].join(',') || null,
            reason,
            toState: outcome,
          },
        );
        return { outcome, pages: pages.length };
      });
    },

    /**
     * Retention: the policy's retentionDays when `retain` is allowed (runs started before the cut-off go), else
     * the last SEO_AUDIT_KEEP_RUNS runs per destination are kept (D-17 working default). A running run stays.
     */
    async pruneSeoAudits({ destinationId, now: at }: SeoAuditInputV1) {
      const row = await destinationsRepo.getById(destinationId);
      const decision = sourceUseDecision(
        await policiesRepo.findByKey(row.brandId, row.kind, CMS_AUDIT_DATA_TYPE),
        'retain',
        new Date(at),
      );
      const days = decision.allowed && decision.policy?.retentionDays ? decision.policy.retentionDays : null;
      const runs = (await runsRepo.listForDestination(row.brandId, row.id, 200)).filter(
        (r) => r.outcome !== 'running',
      );
      const cutoff = days ? new Date(Date.parse(at) - days * DAY_MS) : null;
      const doomed = cutoff
        ? runs.filter((r) => r.startedAt.getTime() < cutoff.getTime())
        : runs.slice(SEO_AUDIT_KEEP_RUNS);
      const ids = doomed.map((r) => r.id);
      const deleted = await withTransaction(async (tx) => {
        await pagesRepo.deleteForRuns(row.brandId, ids, tx);
        const n = await runsRepo.deleteRuns(row.brandId, ids, tx);
        if (n > 0)
          await audit.record(
            workflowActor(),
            'seo_audit.pruned',
            { type: 'brand_destination', id: row.id },
            'allowed',
            tx,
            {
              brandId: row.brandId,
              kind: row.kind,
              count: n,
              scope: CMS_AUDIT_DATA_TYPE,
              reason: cutoff
                ? `cutoff=${cutoff.toISOString()},retentionDays=${days}`
                : `keep=${SEO_AUDIT_KEEP_RUNS}`,
            },
          );
        return n;
      });
      return { deleted };
    },
  };
}
