import { expect, it } from 'vitest';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { describeScheduleReconcile, fakeScheduleClient } from '@oremedia/activities/testing/schedules';
import { ensureDestinationReportSweepScheduled, ensureSeoAuditSweepScheduled } from './ingest-worker';

describeScheduleReconcile('ensureDestinationReportSweepScheduled', ensureDestinationReportSweepScheduled, [
  {
    scheduleId: 'destination-report-sweep',
    workflowType: 'destinationReportSweepWorkflowV1',
    taskQueue: 'ingest-metrics',
    args: [{}],
    spec: { calendars: [{ hour: 4, minute: 0 }] },
    overlap: ScheduleOverlapPolicy.SKIP,
    catchupWindow: '1 day',
  },
]);

/** A namespace that still holds the retired v1 sweep schedule (it is removed at start, idempotently). */
const withV1 = async (fake: ReturnType<typeof fakeScheduleClient>) => {
  await fake.client.schedule.create({
    scheduleId: 'seo-audit-sweep',
    spec: { calendars: [{ dayOfWeek: 'MONDAY', hour: 5 }] },
    action: { type: 'startWorkflow', workflowType: 'seoAuditSweepWorkflowV1', taskQueue: 'ingest-metrics' },
  });
};

describeScheduleReconcile(
  'ensureSeoAuditSweepScheduled',
  ensureSeoAuditSweepScheduled,
  [
    {
      scheduleId: 'seo-audit-sweep-v2',
      workflowType: 'seoAuditSweepWorkflowV2',
      taskQueue: 'ingest-metrics',
      args: [{}],
      spec: { calendars: [{ dayOfWeek: 'MONDAY', hour: 5, minute: 0 }] },
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: '1 day',
    },
  ],
  withV1,
);

it('ensureSeoAuditSweepScheduled removes the retired v1 schedule once', async () => {
  const fake = fakeScheduleClient();
  await withV1(fake);
  await ensureSeoAuditSweepScheduled(fake.client);
  await ensureSeoAuditSweepScheduled(fake.client);
  expect([...fake.schedules.keys()]).toEqual(['seo-audit-sweep-v2']);
  expect(fake.calls.filter((c) => c.op === 'delete')).toEqual([
    { op: 'delete', scheduleId: 'seo-audit-sweep' },
  ]);
});
