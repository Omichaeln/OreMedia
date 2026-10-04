import { ScheduleAlreadyRunning, ScheduleOverlapPolicy, type Client } from '@temporalio/client';
import {
  createDeletionActivities,
  createIdempotencyKeyPurgeActivities,
  createRetentionActivities,
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
    ...createDeletionActivities(runtime.deletion),
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

/** The idempotency purge schedule: created once per namespace, joined when it already exists. */
export async function ensureIdempotencyKeyPurgeScheduleRunning(client: Client): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: IDEMPOTENCY_KEY_PURGE_SCHEDULE_ID,
      spec: { intervals: [{ every: IDEMPOTENCY_KEY_PURGE_INTERVAL }] },
      action: {
        type: 'startWorkflow',
        workflowType: IDEMPOTENCY_KEY_PURGE_WORKFLOW_TYPE,
        taskQueue: OPERATIONS_TASK_QUEUE,
        args: [{}],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour' },
    });
    logger().info({ status: IDEMPOTENCY_KEY_PURGE_SCHEDULE_ID }, 'schedule created');
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) return; // one per namespace; joined
    throw err;
  }
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
  try {
    await client.schedule.create({
      scheduleId: RETENTION_SCHEDULE_ID,
      spec: { calendars: [{ ...RETENTION_CALENDAR }] },
      action: {
        type: 'startWorkflow',
        workflowType: RETENTION_SWEEP_WORKFLOW_TYPE,
        taskQueue: OPERATIONS_TASK_QUEUE,
        args,
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 day' },
    });
    logger().info({ status: `${RETENTION_SCHEDULE_ID}:${mode}` }, 'schedule created');
  } catch (err) {
    if (!(err instanceof ScheduleAlreadyRunning)) throw err;
    // One per namespace; joined. The mode is the environment's now, not the one the schedule was created with:
    // the workflow file stays immutable, its args move with the schedule's action.
    const handle = client.schedule.getHandle(RETENTION_SCHEDULE_ID);
    const previous = await handle.describe();
    const current = (previous.action.args?.[0] ?? {}) as RetentionSweepArgsV1;
    if ((current.dryRun ?? true) === dryRun) return;
    await handle.update((schedule) => ({ ...schedule, action: { ...schedule.action, args } }));
    logger().info({ status: `${RETENTION_SCHEDULE_ID}:${mode}` }, 'schedule updated');
  }
}
