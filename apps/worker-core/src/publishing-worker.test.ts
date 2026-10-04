import { describe, expect, it } from 'vitest';
import { ScheduleOverlapPolicy, WorkflowNotFoundError, type Client } from '@temporalio/client';
import { describeScheduleReconcile } from '@oremedia/activities/testing/schedules';
import {
  TemporalWorkflowProbe,
  ensureBrandFactSweepScheduled,
  ensureConnectChoicePurgeScheduleRunning,
  ensureDestinationTokenRefreshScheduled,
  ensureRemoteChangeSweepScheduled,
} from './publishing-worker';

/** A client whose describe() answers as scripted: a status name, or a thrown error. */
const clientDescribing = (answer: string | Error): Pick<Client, 'workflow'> =>
  ({
    workflow: {
      getHandle: () => ({
        describe: async () => {
          if (answer instanceof Error) throw answer;
          return { status: { name: answer } };
        },
      }),
    },
  }) as unknown as Pick<Client, 'workflow'>;

describe('TemporalWorkflowProbe (the sweeper asks before declaring worker loss, spec 14.2)', () => {
  it('reports RUNNING as running and any closed status as not running', async () => {
    expect(await new TemporalWorkflowProbe(clientDescribing('RUNNING')).isRunning('pub:1')).toBe(true);
    expect(await new TemporalWorkflowProbe(clientDescribing('COMPLETED')).isRunning('pub:1')).toBe(false);
  });

  it('an unknown workflow id is not running', async () => {
    const probe = new TemporalWorkflowProbe(
      clientDescribing(new WorkflowNotFoundError('workflow not found', 'pub:1', undefined)),
    );
    expect(await probe.isRunning('pub:1')).toBe(false);
  });

  it('a transport failure (Temporal unreachable) is treated as running, never as worker loss', async () => {
    const unavailable = Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
    expect(await new TemporalWorkflowProbe(clientDescribing(unavailable)).isRunning('pub:1')).toBe(true);
  });
});

const SKIP = ScheduleOverlapPolicy.SKIP;

describeScheduleReconcile(
  'ensureConnectChoicePurgeScheduleRunning',
  ensureConnectChoicePurgeScheduleRunning,
  [
    {
      scheduleId: 'connect-choice-purge',
      workflowType: 'connectChoicePurgeWorkflowV1',
      taskQueue: 'core',
      args: [{}],
      spec: { intervals: [{ every: '15 minutes' }] },
      overlap: SKIP,
      catchupWindow: '1 hour',
    },
  ],
);

describeScheduleReconcile('ensureDestinationTokenRefreshScheduled', ensureDestinationTokenRefreshScheduled, [
  {
    scheduleId: 'destination-token-refresh',
    workflowType: 'destinationTokenRefreshWorkflowV1',
    taskQueue: 'core',
    args: [{}],
    spec: { calendars: [{ hour: 3, minute: 10 }] },
    overlap: SKIP,
    catchupWindow: '1 day',
  },
]);

describeScheduleReconcile('ensureBrandFactSweepScheduled', ensureBrandFactSweepScheduled, [
  {
    scheduleId: 'brand-fact-sweep',
    workflowType: 'brandFactSweepWorkflowV1',
    taskQueue: 'core',
    args: [{}],
    spec: { calendars: [{ hour: 3, minute: 20 }] },
    overlap: SKIP,
    catchupWindow: '1 day',
  },
]);

describeScheduleReconcile('ensureRemoteChangeSweepScheduled', ensureRemoteChangeSweepScheduled, [
  {
    scheduleId: 'remote-change-sweep',
    workflowType: 'remoteChangeSweepWorkflowV1',
    taskQueue: 'core',
    args: [],
    spec: { intervals: [{ every: '1 hour' }] },
    overlap: SKIP,
    catchupWindow: '1 hour',
  },
]);
