import { describe, expect, it } from 'vitest';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { describeScheduleReconcile, fakeScheduleClient } from '@oremedia/activities/testing/schedules';
import { ensureRetentionScheduleRunning } from './operations-worker';

const argsOf = (fake: ReturnType<typeof fakeScheduleClient>) =>
  fake.schedules.get('retention-sweep')?.action.args;

describe('ensureRetentionScheduleRunning (spec 17.5: the apply mode follows the environment at every start)', () => {
  it('creates the schedule in dry run by default, in apply mode with RETENTION_SWEEP_APPLY=true', async () => {
    const dry = fakeScheduleClient();
    await ensureRetentionScheduleRunning(dry.client, {});
    expect(dry.calls).toEqual([{ op: 'create', scheduleId: 'retention-sweep' }]);
    expect(argsOf(dry)).toEqual([{ dryRun: true }]);
    const apply = fakeScheduleClient();
    await ensureRetentionScheduleRunning(apply.client, { RETENTION_SWEEP_APPLY: 'true' });
    expect(argsOf(apply)).toEqual([{ dryRun: false }]);
  });

  it('an existing schedule is switched to the mode the environment reads now, and left alone when it matches', async () => {
    const fake = fakeScheduleClient();
    await ensureRetentionScheduleRunning(fake.client, {});
    await ensureRetentionScheduleRunning(fake.client, { RETENTION_SWEEP_APPLY: 'true' });
    expect(argsOf(fake)).toEqual([{ dryRun: false }]);
    await ensureRetentionScheduleRunning(fake.client, {});
    expect(argsOf(fake)).toEqual([{ dryRun: true }]);
    await ensureRetentionScheduleRunning(fake.client, {});
    expect(fake.calls.map((c) => c.op)).toEqual(['create', 'update', 'update']);
  });
});

describeScheduleReconcile(
  'ensureRetentionScheduleRunning',
  (client) => ensureRetentionScheduleRunning(client, {}),
  [
    {
      scheduleId: 'retention-sweep',
      workflowType: 'retentionSweepWorkflowV1',
      taskQueue: 'core',
      args: [{ dryRun: true }],
      spec: { calendars: [{ hour: 2, minute: 30 }] },
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: '1 day',
    },
  ],
);
