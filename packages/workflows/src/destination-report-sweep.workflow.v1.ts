import { ParentClosePolicy, proxyActivities, startChild, workflowInfo } from '@temporalio/workflow';
import type {
  DestinationHealth,
  DestinationReportSweepActivitiesV1,
  DestinationReportSweepArgsV1,
  DestinationReportSweepInputV1,
  DestinationReportsActivitiesV1,
  DestinationReportsInputV1,
} from '@oremedia/contracts/destinations';

/**
 * Ledger R2-1 part B (task queue `ingest-metrics`, worker-ingest), started daily by the Temporal schedule
 * `destination-report-sweep`: every active GA4 and Search Console destination with a grant gets one child
 * (deterministic id `destination-reports:<destinationId>:<day>`, so a day's read runs once) that checks the
 * source-use policy, plans the incremental ranges, reads each report through the broker, records the outcome
 * as the destination's health and prunes by the retention. Quota-aware: a 429 ends the child as `degraded` and
 * the next day's run catches up from the last stored day; nothing is retried tightly. Modelled on
 * brandAnalystSweepWorkflowV1 (fan-out) and destinationTokenRefreshWorkflowV1 (the effect). Payloads carry ids,
 * ranges and counts only (R5). Once deployed this file is immutable; changes ship as v2.
 */
export const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed'];
/** The actor every read runs as: a platform job applied inside each tenant (no person requested it). */
export const DESTINATION_REPORTS_ACTOR = {
  kind: 'platform_operator' as const,
  id: 'destination-report-sweep',
};
export const destinationReportsWorkflowId = (destinationId: string, day: string): string =>
  `destination-reports:${destinationId}:${day.slice(0, 10)}`;

export interface DestinationReportsOutcome {
  outcome: 'skipped' | 'fetched' | 'degraded' | 'unreachable';
  reason: string | null;
  reports: number;
  rows: number;
  pruned: number;
}

/** The orchestration of one destination, separated from the activity proxies so it runs with fakes in unit tests. */
export async function runDestinationReports(
  acts: DestinationReportsActivitiesV1,
  input: DestinationReportsInputV1,
): Promise<DestinationReportsOutcome> {
  const plan = await acts.planDestinationReports(input);
  if (plan.outcome === 'skipped')
    return { outcome: 'skipped', reason: plan.reason, reports: 0, rows: 0, pruned: 0 };
  const fetched: Array<{ reportKey: string; rows: number }> = [];
  let health: DestinationHealth = 'healthy';
  let reason: string | null = null;
  for (const range of plan.reports) {
    let result;
    try {
      result = await acts.fetchDestinationReport({ ...input, ...range });
    } catch {
      // The activity host retried transient failures; a permanent one leaves the destination degraded for today.
      health = 'degraded';
      reason = `activity_failed:${range.reportKey}`;
      break;
    }
    if (result.outcome === 'fetched') {
      fetched.push({ reportKey: range.reportKey, rows: result.rows });
      continue;
    }
    if (result.outcome === 'skipped')
      return { outcome: 'skipped', reason: result.reason, reports: fetched.length, rows: 0, pruned: 0 };
    // Rate limited (quota), unreachable (grant revoked or refused) or transient: stop here, never retry tightly;
    // the next day's run reads on from the last stored day.
    health = result.outcome === 'unreachable' ? 'unreachable' : 'degraded';
    reason = result.outcome === 'rate_limited' ? 'rate_limited' : result.reason;
    break;
  }
  await acts.finishDestinationReports({ ...input, health, fetched, reason });
  let pruned = 0;
  try {
    pruned = (await acts.pruneDestinationReports(input)).deleted;
  } catch {
    // Retention is applied again on the next day's run; a failed prune never fails the read.
  }
  return {
    outcome: health === 'healthy' ? 'fetched' : health,
    reason,
    reports: fetched.length,
    rows: fetched.reduce((n, f) => n + f.rows, 0),
    pruned,
  };
}

export async function destinationReportsWorkflowV1(
  input: DestinationReportsInputV1,
): Promise<DestinationReportsOutcome> {
  const acts = proxyActivities<DestinationReportsActivitiesV1>({
    startToCloseTimeout: '10 minutes',
    heartbeatTimeout: '2 minutes',
    retry: { initialInterval: '30s', maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
  });
  return runDestinationReports(acts, input);
}

/** How the sweep starts one child per destination; the workflow uses a child workflow, tests a fake. */
export interface DestinationReportSweepHost {
  startReports(input: DestinationReportsInputV1, workflowId: string): Promise<void>;
}

export interface DestinationReportSweepOutcome {
  targets: number;
  started: number;
  /** A child of the same id already ran today (the deterministic id joins it). */
  alreadyStarted: number;
  failed: number;
}

export async function runDestinationReportSweep(
  acts: DestinationReportSweepActivitiesV1,
  input: DestinationReportSweepInputV1,
  host: DestinationReportSweepHost,
): Promise<DestinationReportSweepOutcome> {
  const targets = await acts.listDestinationReportTargets(input);
  const outcome: DestinationReportSweepOutcome = {
    targets: targets.length,
    started: 0,
    alreadyStarted: 0,
    failed: 0,
  };
  for (const t of targets) {
    const child: DestinationReportsInputV1 = {
      tenantId: t.tenantId,
      actor: DESTINATION_REPORTS_ACTOR,
      correlationId: `${input.correlationId}:${t.destinationId}`,
      destinationId: t.destinationId,
      now: input.now,
    };
    try {
      await host.startReports(child, destinationReportsWorkflowId(t.destinationId, input.now));
      outcome.started += 1;
    } catch (err) {
      if ((err as { name?: string }).name === 'WorkflowExecutionAlreadyStartedError')
        outcome.alreadyStarted += 1;
      else outcome.failed += 1; // one destination's failure never blocks the others
    }
  }
  return outcome;
}

export async function destinationReportSweepWorkflowV1(
  args: DestinationReportSweepArgsV1 = {},
): Promise<DestinationReportSweepOutcome> {
  const acts = proxyActivities<DestinationReportSweepActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: { initialInterval: '30s', maximumAttempts: 3 },
  });
  // A schedule starts this with fixed args: the workflow's deterministic clock and run id fill the rest.
  const input: DestinationReportSweepInputV1 = {
    correlationId: args.correlationId ?? `destination-report-sweep:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
  };
  return runDestinationReportSweep(acts, input, {
    async startReports(child, workflowId) {
      await startChild(destinationReportsWorkflowV1, {
        args: [child],
        workflowId,
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
    },
  });
}
