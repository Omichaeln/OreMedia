import { ScheduleOverlapPolicy, type Client } from '@temporalio/client';
import {
  createAnalystSweepActivities,
  createBaselineComparisonActivities,
  createBrandAnalystActivities,
  ensureScheduleReconciled,
} from '@oremedia/activities';
import {
  ANALYST_SCHEDULE_ID,
  ANALYST_SWEEP_WORKFLOW_TYPE,
  BASELINE_COMPARISON_SCHEDULE_ID,
  BASELINE_COMPARISON_WORKFLOW_TYPE,
  CORE_TASK_QUEUE,
  createIntelligenceRuntime,
} from '@oremedia/module-intelligence';

/**
 * Spec 16.3 / 16.8: the brand analyst and the ranking baseline comparison run on task queue `core` (this worker).
 * Their activities join the core worker (publishing-worker.ts); the weekly and monthly cadences are Temporal
 * schedules created once per namespace at start (brought in line with the code when they already exist). The analysis itself starts a
 * performance-review agent run on queue `agents`, so this process must host both queues, which it does.
 */
export function intelligenceActivities() {
  const runtime = createIntelligenceRuntime();
  return {
    ...createBrandAnalystActivities(runtime.analyst),
    ...createAnalystSweepActivities(runtime.sweep),
    ...createBaselineComparisonActivities(runtime.baseline),
  };
}

/** Weekly on Monday at 03:00 UTC (analysis) and monthly on the 1st at 04:00 UTC (baseline comparison). */
export const ANALYST_CALENDAR = { dayOfWeek: 'MONDAY', hour: 3, minute: 0 } as const;
export const BASELINE_CALENDAR = { dayOfMonth: 1, hour: 4, minute: 0 } as const;

async function ensureSchedule(
  client: Client,
  scheduleId: string,
  workflowType: string,
  calendar: Record<string, unknown>,
): Promise<void> {
  await ensureScheduleReconciled(client, {
    scheduleId,
    spec: { calendars: [calendar] },
    action: { workflowType, taskQueue: CORE_TASK_QUEUE, args: [{}] },
    policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 day' },
  });
}

export async function ensureIntelligenceSchedulesRunning(client: Client): Promise<void> {
  await ensureSchedule(client, ANALYST_SCHEDULE_ID, ANALYST_SWEEP_WORKFLOW_TYPE, { ...ANALYST_CALENDAR });
  await ensureSchedule(client, BASELINE_COMPARISON_SCHEDULE_ID, BASELINE_COMPARISON_WORKFLOW_TYPE, {
    ...BASELINE_CALENDAR,
  });
}
