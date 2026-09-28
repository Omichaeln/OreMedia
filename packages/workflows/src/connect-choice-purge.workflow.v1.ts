import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type {
  ConnectChoicePurgeActivitiesV1,
  ConnectChoicePurgeArgsV1,
  ConnectChoicePurgeInputV1,
  ConnectChoicePurgeResultV1,
} from '@oremedia/contracts/publishing';

/**
 * Spec 14.7 account choice (task queue `core`), started every 15 minutes by the Temporal schedule
 * `connect-choice-purge`: expired pending choices, which hold sealed long-lived user tokens, are shredded and
 * deleted across tenants. It always applies (a pending choice is not a retention class and has no dry run). Once
 * deployed this file is immutable; changes ship as v2.
 */
export async function runConnectChoicePurge(
  acts: ConnectChoicePurgeActivitiesV1,
  input: ConnectChoicePurgeInputV1,
): Promise<ConnectChoicePurgeResultV1> {
  return acts.purgeExpiredConnectChoices(input);
}

export async function connectChoicePurgeWorkflowV1(
  args: ConnectChoicePurgeArgsV1 = {},
): Promise<ConnectChoicePurgeResultV1> {
  const acts = proxyActivities<ConnectChoicePurgeActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: { initialInterval: '30s', maximumAttempts: 3 },
  });
  // A schedule starts this with fixed args: the workflow's deterministic clock and run id fill the rest.
  return runConnectChoicePurge(acts, {
    correlationId: args.correlationId ?? `connect-choice-purge:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
  });
}
