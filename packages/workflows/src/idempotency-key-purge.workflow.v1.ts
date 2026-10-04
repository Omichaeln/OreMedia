import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type {
  IdempotencyKeyPurgeActivitiesV1,
  IdempotencyKeyPurgeArgsV1,
  IdempotencyKeyPurgeInputV1,
  IdempotencyKeyPurgeResultV1,
} from '@oremedia/contracts/operations';

/**
 * Spec 7.3 idempotency records (task queue `core`), started every hour by the Temporal schedule
 * `idempotency-key-purge`: records past their expiry (24 hours, 72 for publication commands) are deleted across
 * tenants. A record is a replay cache, never replayed once expired, so it always applies (it is not a retention class
 * and has no dry run). Once deployed this file is immutable; changes ship as v2.
 */
export async function runIdempotencyKeyPurge(
  acts: IdempotencyKeyPurgeActivitiesV1,
  input: IdempotencyKeyPurgeInputV1,
): Promise<IdempotencyKeyPurgeResultV1> {
  return acts.purgeExpiredIdempotencyKeys(input);
}

export async function idempotencyKeyPurgeWorkflowV1(
  args: IdempotencyKeyPurgeArgsV1 = {},
): Promise<IdempotencyKeyPurgeResultV1> {
  const acts = proxyActivities<IdempotencyKeyPurgeActivitiesV1>({
    startToCloseTimeout: '10 minutes',
    retry: { initialInterval: '30s', maximumAttempts: 3 },
  });
  // A schedule starts this with fixed args: the workflow's deterministic clock and run id fill the rest.
  return runIdempotencyKeyPurge(acts, {
    correlationId: args.correlationId ?? `idempotency-key-purge:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
  });
}
