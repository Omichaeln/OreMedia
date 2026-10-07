import { ScheduleOverlapPolicy, type Client } from '@temporalio/client';
import {
  createDeletionActivities,
  createIdempotencyKeyPurgeActivities,
  createRetentionActivities,
  ensureScheduleReconciled,
} from '@oremedia/activities';
import type { RetentionSweepArgsV1 } from '@oremedia/contracts/operations';
import {
  IDEMPOTENCY_KEY_PURGE_SCHEDULE_ID,
  IDEMPOTENCY_KEY_PURGE_WORKFLOW_TYPE,
  OPERATIONS_TASK_QUEUE,
  RETENTION_SCHEDULE_ID,
  RETENTION_SWEEP_WORKFLOW_TYPE,
  createOperationsRuntime,
} from '@oremedia/module-operations';
import { runWithDatabaseRole } from '@oremedia/db';
import { logger } from '@oremedia/observability';

/**
 * Spec 17.5: deletionRequestWorkflowV1 and retentionSweepWorkflowV1 run on task queue `core` (this worker); their
 * activities join the core worker (publishing-worker.ts). The retention sweep is a daily Temporal schedule created
 * once per namespace. It runs as a dry run (counts only) unless RETENTION_SWEEP_APPLY=true: the retention periods
 * are still to be confirmed (D-09). The mode follows the environment at every worker start (the schedule's action
 * args are brought in line when it already exists), so a deployment flips it by restarting with the variable
 * (docs/runbooks/process-deletion-request.md).
 */
export function operationsActivities() {
  const runtime = createOperationsRuntime();
  return {
    // Spec 17.5 / 6.1: each handler step runs on the deletion role's connection (DATABASE_URL_DELETION,
    // roles/deletion-role.sql), which adds DELETE on the insert-only tables a deletion removes; begin and finish
    // touch only the request and audit rows and stay on the application role.
    ...createDeletionActivities({
      beginDeletion: (input) => runtime.deletion.beginDeletion(input),
      runDeletionHandler: (input) =>
        runWithDatabaseRole('deletion', () => runtime.deletion.runDeletionHandler(input)),
      finishDeletion: (input) => runtime.deletion.finishDeletion(input),
    }),
    // Spec 17.5 / 6.1: the TTL deletes run on the retention role's connection (DATABASE_URL_RETENTION,
    // roles/retention-role.sql), the only role with DELETE on the insert-only tables a TTL class removes.
    ...createRetentionActivities({
      listRetentionTenants: (input) => runtime.retention.listRetentionTenants(input),
      applyRetention: (input) =>
        runWithDatabaseRole('retention', () => runtime.retention.applyRetention(input)),
    }),
    // idempotencyKeyPurgeWorkflowV1 (spec 7.3): expired idempotency records, on the application role (it owns them)
    ...createIdempotencyKeyPurgeActivities(runtime.idempotencyPurge),
  };
}

/** Spec 7.3: every hour, expired idempotency records are deleted (it always applies; no dry run). */
export const IDEMPOTENCY_KEY_PURGE_INTERVAL = '1 hour';

/**
 * The idempotency purge schedule: created once per namespace, and reconciled with the code (interval, action and
 * policies) when it already exists (G20).
 */
export async function ensureIdempotencyKeyPurgeScheduleRunning(client: Client): Promise<void> {
  await ensureScheduleReconciled(client, {
    scheduleId: IDEMPOTENCY_KEY_PURGE_SCHEDULE_ID,
    spec: { intervals: [{ every: IDEMPOTENCY_KEY_PURGE_INTERVAL }] },
    action: {
      workflowType: IDEMPOTENCY_KEY_PURGE_WORKFLOW_TYPE,
      taskQueue: OPERATIONS_TASK_QUEUE,
      args: [{}],
    },
    policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour' },
  });
}

/** Daily at 02:30 UTC, outside the top-of-hour publishing burst. */
export const RETENTION_CALENDAR = { hour: 2, minute: 30 } as const;

export async function ensureRetentionScheduleRunning(
  client: Client,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dryRun = env['RETENTION_SWEEP_APPLY'] !== 'true';
  const mode = dryRun ? 'dry_run' : 'apply';
  const args: [RetentionSweepArgsV1] = [{ dryRun }];
  // The mode is the environment's now, not the one the schedule was created with: the workflow file stays
  // immutable, its args move with the schedule's action (reconciled with the calendar and policies).
  const result = await ensureScheduleReconciled(client, {
    scheduleId: RETENTION_SCHEDULE_ID,
    spec: { calendars: [{ ...RETENTION_CALENDAR }] },
    action: { workflowType: RETENTION_SWEEP_WORKFLOW_TYPE, taskQueue: OPERATIONS_TASK_QUEUE, args },
    policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 day' },
  });
  if (result !== 'unchanged') logger().info({ status: `${RETENTION_SCHEDULE_ID}:${mode}` }, 'retention mode');
}
