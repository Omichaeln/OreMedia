import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type {
  DestinationRefreshActivitiesV1,
  DestinationTokenRefreshArgsV1,
  DestinationTokenRefreshInputV1,
} from '@oremedia/contracts/destinations';

/**
 * Ledger R2-1 (task queue `core`), started daily by the Temporal schedule `destination-token-refresh`: every active
 * destination whose stored token expires within the window (24 hours by default) is refreshed, one activity per
 * destination in its own tenant, so one revoked or unreachable grant never blocks the others. Modelled on
 * tokenRefreshWorkflowV1 for the effect and retentionSweepWorkflowV1 for the fan-out. The payload carries ids only
 * (R5). Once deployed this file is immutable; changes ship as v2.
 */
export const DEFAULT_WITHIN_HOURS = 24;
/** The actor every refresh runs as: a platform job applied inside each tenant (no person requested it). */
export const DESTINATION_REFRESH_ACTOR = {
  kind: 'platform_operator' as const,
  id: 'destination-token-refresh',
};

export interface DestinationTokenRefreshOutcome {
  due: number;
  refreshed: number;
  reconnectNeeded: number;
  skipped: number;
  failed: number;
}

/** The orchestration, separated from the activity proxies so it runs with fakes in unit tests. */
export async function runDestinationTokenRefresh(
  acts: DestinationRefreshActivitiesV1,
  input: DestinationTokenRefreshInputV1,
): Promise<DestinationTokenRefreshOutcome> {
  const due = await acts.listDueDestinationRefreshes(input);
  const outcome: DestinationTokenRefreshOutcome = {
    due: due.length,
    refreshed: 0,
    reconnectNeeded: 0,
    skipped: 0,
    failed: 0,
  };
  for (const ref of due) {
    try {
      const result = await acts.refreshDestinationCredential({
        tenantId: ref.tenantId,
        destinationId: ref.destinationId,
        actor: DESTINATION_REFRESH_ACTOR,
        correlationId: input.correlationId,
      });
      if (result.ok) outcome.refreshed += 1;
      else if (result.reason === 'reconnect_required') outcome.reconnectNeeded += 1;
      else if (result.reason === 'transient') outcome.failed += 1;
      else outcome.skipped += 1; // locked (another refresh in flight) or no longer active
    } catch {
      outcome.failed += 1; // retried on the next day's run; the activity already retried transient errors
    }
  }
  return outcome;
}

export async function destinationTokenRefreshWorkflowV1(
  args: DestinationTokenRefreshArgsV1 = {},
): Promise<DestinationTokenRefreshOutcome> {
  const acts = proxyActivities<DestinationRefreshActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '30s',
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['PolicyDenied', 'ValidationFailed'],
    },
  });
  // A schedule starts this with fixed args: the workflow's deterministic clock and run id fill the rest.
  const input: DestinationTokenRefreshInputV1 = {
    correlationId: args.correlationId ?? `destination-token-refresh:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
    withinHours: args.withinHours ?? DEFAULT_WITHIN_HOURS,
  };
  return runDestinationTokenRefresh(acts, input);
}
