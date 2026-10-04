import { ScheduleOverlapPolicy } from '@temporalio/client';
import { describeScheduleReconcile } from '@oremedia/activities/testing/schedules';
import { ensureIntelligenceSchedulesRunning } from './intelligence-worker';

describeScheduleReconcile('ensureIntelligenceSchedulesRunning', ensureIntelligenceSchedulesRunning, [
  {
    scheduleId: 'brand-analyst-weekly',
    workflowType: 'brandAnalystSweepWorkflowV1',
    taskQueue: 'core',
    args: [{}],
    spec: { calendars: [{ dayOfWeek: 'MONDAY', hour: 3, minute: 0 }] },
    overlap: ScheduleOverlapPolicy.SKIP,
    catchupWindow: '1 day',
  },
  {
    scheduleId: 'ranking-baseline-monthly',
    workflowType: 'baselineComparisonWorkflowV1',
    taskQueue: 'core',
    args: [{}],
    spec: { calendars: [{ dayOfMonth: 1, hour: 4, minute: 0 }] },
    overlap: ScheduleOverlapPolicy.SKIP,
    catchupWindow: '1 day',
  },
]);
