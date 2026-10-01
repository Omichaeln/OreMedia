import { ParentClosePolicy, proxyActivities, sleep, startChild, workflowInfo } from '@temporalio/workflow';
import type {
  SeoAuditActivitiesV1,
  SeoAuditInputV1,
  SeoAuditLimit,
  SeoAuditOutcome as SeoAuditRunOutcome,
  SeoAuditSweepActivitiesV1,
  SeoAuditSweepArgsV1,
  SeoAuditSweepInputV1,
} from '@oremedia/contracts/seo-audit';

/**
 * Ledger R2-4 (task queue `ingest-metrics`, worker-ingest): a bounded crawl of one website destination. The plan
 * activity checks the policy, takes the lock, opens the run and returns the seeds (the origin, the sitemap); the
 * workflow then carries the frontier (as commentIngestionWorkflowV1 carries its cursor) and fetches one page per
 * activity with a pause between fetches, so the run is resumable and every cap is enforced here: pages, depth and
 * the run deadline. The finish activity adds the cross-page checks and closes the run; the prune applies retention.
 * The weekly sweep starts one child per website with a deterministic weekly id (a week's audit runs once).
 * Payloads carry ids, URLs and counts only (R5). Once deployed this file is immutable; changes ship as v2.
 */
export const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed', 'NotFound'];
/** The actor every scheduled run runs as: a platform job applied inside each tenant (no person requested it). */
export const SEO_AUDIT_ACTOR = { kind: 'platform_operator' as const, id: 'seo-audit-sweep' };
export const SEO_AUDIT_MAX_PAGES = 200;
export const SEO_AUDIT_MAX_DEPTH = 3;
export const SEO_AUDIT_FETCH_GAP_MS = 250;
export const SEO_AUDIT_RUN_DEADLINE_MS = 20 * 60_000;

/** The ISO week (`YYYY-Www`) of an ISO datetime, computed here so the id is deterministic in the workflow. */
export function isoWeekOf(iso: string): string {
  const d = new Date(Date.parse(iso));
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
export const seoAuditWeeklyWorkflowId = (destinationId: string, now: string): string =>
  `seo-audit:${destinationId}:${isoWeekOf(now)}`;

export interface SeoAuditHost {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SeoAuditOutcome {
  outcome: 'skipped' | SeoAuditRunOutcome;
  reason: string | null;
  runId: string | null;
  crawled: number;
  failed: number;
  limitsHit: SeoAuditLimit[];
  pruned: number;
}

/** The orchestration of one run, separated from the activity proxies so it runs with fakes in unit tests. */
export async function runSeoAudit(
  acts: SeoAuditActivitiesV1,
  input: SeoAuditInputV1,
  host: SeoAuditHost,
): Promise<SeoAuditOutcome> {
  const plan = await acts.planSeoAudit(input);
  if (plan.outcome === 'skipped')
    return {
      outcome: 'skipped',
      reason: plan.reason,
      runId: null,
      crawled: 0,
      failed: 0,
      limitsHit: [],
      pruned: 0,
    };
  const { runId } = plan;
  const limitsHit = new Set<SeoAuditLimit>(plan.limitsHit);
  const visited = new Set<string>(plan.seeds);
  const frontier = plan.seeds.map((url) => ({ url, depth: 0 }));
  const started = host.now();
  let crawled = 0;
  let failed = 0;
  let closed = false;
  for (let next = frontier.shift(); next; next = frontier.shift()) {
    if (crawled >= SEO_AUDIT_MAX_PAGES) {
      limitsHit.add('max_pages');
      break;
    }
    if (host.now() - started >= SEO_AUDIT_RUN_DEADLINE_MS) {
      limitsHit.add('deadline');
      break;
    }
    if (crawled > 0 || failed > 0) await host.sleep(SEO_AUDIT_FETCH_GAP_MS);
    let result;
    try {
      result = await acts.crawlSeoAuditPage({ ...input, runId, url: next.url, depth: next.depth });
    } catch {
      // The activity host retried; a page that still fails is counted and the crawl goes on (never tightly).
      failed += 1;
      continue;
    }
    if (result.outcome === 'skipped') {
      if (result.reason === 'not_running') {
        closed = true; // closed elsewhere (abandoned and failed by a later run): nothing more to record
        break;
      }
      continue;
    }
    crawled += 1;
    const fresh = result.links.filter((l) => !visited.has(l));
    if (next.depth + 1 > SEO_AUDIT_MAX_DEPTH) {
      if (fresh.length > 0) limitsHit.add('max_depth');
      continue;
    }
    for (const url of fresh) {
      visited.add(url);
      frontier.push({ url, depth: next.depth + 1 });
    }
  }
  const limits = [...limitsHit];
  if (closed)
    return { outcome: 'failed', reason: 'not_running', runId, crawled, failed, limitsHit: limits, pruned: 0 };
  const finished = await acts.finishSeoAudit({ ...input, runId, limitsHit: limits, failedPages: failed });
  let pruned = 0;
  try {
    pruned = (await acts.pruneSeoAudits(input)).deleted;
  } catch {
    // Retention is applied again on the next run; a failed prune never fails the audit.
  }
  return {
    outcome: finished.outcome,
    reason: failed > 0 ? `failed_pages=${failed}` : null,
    runId,
    crawled,
    failed,
    limitsHit: limits,
    pruned,
  };
}

export async function seoAuditWorkflowV1(input: SeoAuditInputV1): Promise<SeoAuditOutcome> {
  // The plan reads robots.txt and the sitemap (several bounded fetches); a page is one fetch.
  const control = proxyActivities<
    Pick<SeoAuditActivitiesV1, 'planSeoAudit' | 'finishSeoAudit' | 'pruneSeoAudits'>
  >({
    startToCloseTimeout: '5 minutes',
    retry: { initialInterval: '30s', maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
  });
  const pages = proxyActivities<Pick<SeoAuditActivitiesV1, 'crawlSeoAuditPage'>>({
    startToCloseTimeout: '2 minutes',
    heartbeatTimeout: '1 minute',
    retry: { initialInterval: '10s', maximumAttempts: 2, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
  });
  return runSeoAudit({ ...control, ...pages }, input, { now: () => Date.now(), sleep: (ms) => sleep(ms) });
}

/** How the sweep starts one child per website; the workflow uses a child workflow, tests a fake. */
export interface SeoAuditSweepHost {
  startAudit(input: SeoAuditInputV1, workflowId: string): Promise<void>;
}

export interface SeoAuditSweepOutcome {
  targets: number;
  started: number;
  /** A child of the same id already ran this week (the deterministic id joins it). */
  alreadyStarted: number;
  failed: number;
}

export async function runSeoAuditSweep(
  acts: SeoAuditSweepActivitiesV1,
  input: SeoAuditSweepInputV1,
  host: SeoAuditSweepHost,
): Promise<SeoAuditSweepOutcome> {
  const targets = await acts.listSeoAuditTargets(input);
  const outcome: SeoAuditSweepOutcome = { targets: targets.length, started: 0, alreadyStarted: 0, failed: 0 };
  for (const t of targets) {
    const child: SeoAuditInputV1 = {
      tenantId: t.tenantId,
      actor: SEO_AUDIT_ACTOR,
      correlationId: `${input.correlationId}:${t.destinationId}`,
      destinationId: t.destinationId,
      now: input.now,
      trigger: 'scheduled',
    };
    try {
      await host.startAudit(child, seoAuditWeeklyWorkflowId(t.destinationId, input.now));
      outcome.started += 1;
    } catch (err) {
      if ((err as { name?: string }).name === 'WorkflowExecutionAlreadyStartedError')
        outcome.alreadyStarted += 1;
      else outcome.failed += 1; // one website's failure never blocks the others
    }
  }
  return outcome;
}

export async function seoAuditSweepWorkflowV1(args: SeoAuditSweepArgsV1 = {}): Promise<SeoAuditSweepOutcome> {
  const acts = proxyActivities<SeoAuditSweepActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: { initialInterval: '30s', maximumAttempts: 3 },
  });
  // A schedule starts this with fixed args: the workflow's deterministic clock and run id fill the rest.
  const input: SeoAuditSweepInputV1 = {
    correlationId: args.correlationId ?? `seo-audit-sweep:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
  };
  return runSeoAuditSweep(acts, input, {
    async startAudit(child, workflowId) {
      await startChild(seoAuditWorkflowV1, {
        args: [child],
        workflowId,
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
    },
  });
}
