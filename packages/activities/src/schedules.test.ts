import { describe, expect, it } from 'vitest';
import { ScheduleOverlapPolicy, type ScheduleDescription } from '@temporalio/client';
import { ensureScheduleReconciled, scheduleDrift, type DesiredSchedule } from './schedules';
import { fakeScheduleClient } from './testing/schedules';

const range = <T>(start: T, end: T = start) => [{ start, end, step: 1 }];

/** describe() of a weekly Monday 03:00 schedule, as `temporal server start-dev` (Server 1.28) answered it. */
const described = {
  scheduleId: 'weekly',
  spec: {
    calendars: [
      {
        second: range(0),
        minute: range(0),
        hour: range(3),
        dayOfMonth: range(1, 31),
        month: range('JANUARY', 'DECEMBER'),
        year: [],
        dayOfWeek: range('MONDAY'),
        comment: '',
      },
    ],
    intervals: [],
    skip: [],
    timezone: '',
  },
  action: {
    type: 'startWorkflow',
    workflowId: 'weekly-workflow',
    workflowType: 'brandAnalystSweepWorkflowV1',
    taskQueue: 'core',
    args: [{}],
    searchAttributes: {},
    typedSearchAttributes: [],
    priority: {},
  },
  policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: 86_400_000, pauseOnFailure: false },
  state: { paused: false, note: '' },
} as unknown as ScheduleDescription;

const weekly: DesiredSchedule = {
  scheduleId: 'weekly',
  spec: { calendars: [{ dayOfWeek: 'MONDAY', hour: 3, minute: 0 }] },
  action: { workflowType: 'brandAnalystSweepWorkflowV1', taskQueue: 'core', args: [{}] },
  policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 day' },
};

describe('scheduleDrift (G20: the code compared with the server form describe() returns)', () => {
  it('a server description of the same schedule has no drift', () => {
    expect(scheduleDrift(described, weekly)).toEqual([]);
    const interval = {
      ...described,
      spec: { calendars: [], intervals: [{ every: 900_000 }], skip: [], timezone: '' },
    } as unknown as ScheduleDescription;
    expect(scheduleDrift(interval, { ...weekly, spec: { intervals: [{ every: '15 minutes' }] } })).toEqual(
      [],
    );
  });

  it('names each part that differs', () => {
    expect(
      scheduleDrift(described, { ...weekly, spec: { calendars: [{ dayOfWeek: 'MONDAY', hour: 4 }] } }),
    ).toEqual(['spec']);
    expect(scheduleDrift(described, { ...weekly, spec: { intervals: [{ every: '1 hour' }] } })).toEqual([
      'spec',
    ]);
    expect(scheduleDrift(described, { ...weekly, action: { ...weekly.action, taskQueue: 'other' } })).toEqual(
      ['action'],
    );
    expect(
      scheduleDrift(described, { ...weekly, action: { ...weekly.action, args: [{ dryRun: true }] } }),
    ).toEqual(['action']);
    expect(
      scheduleDrift(described, {
        ...weekly,
        policies: { overlap: ScheduleOverlapPolicy.BUFFER_ONE, catchupWindow: '1 day' },
      }),
    ).toEqual(['policies']);
    expect(
      scheduleDrift(described, { ...weekly, policies: { ...weekly.policies, catchupWindow: '1 hour' } }),
    ).toEqual(['policies']);
  });
});

describe('ensureScheduleReconciled', () => {
  it('creates, then leaves an equal schedule alone, then updates only a drifted one', async () => {
    const fake = fakeScheduleClient();
    expect(await ensureScheduleReconciled(fake.client, weekly)).toBe('created');
    expect(await ensureScheduleReconciled(fake.client, weekly)).toBe('unchanged');
    const daily = { ...weekly, spec: { calendars: [{ hour: 3, minute: 0 }] } };
    expect(await ensureScheduleReconciled(fake.client, daily)).toBe('reconciled');
    expect(await ensureScheduleReconciled(fake.client, daily)).toBe('unchanged');
    expect(fake.calls).toEqual([
      { op: 'create', scheduleId: 'weekly' },
      { op: 'update', scheduleId: 'weekly' },
    ]);
  });

  it('an update keeps the paused state, the note, the remaining actions and the workflow id', async () => {
    const fake = fakeScheduleClient();
    await ensureScheduleReconciled(fake.client, weekly);
    const held = fake.schedules.get('weekly')!;
    held.state = { paused: true, note: 'held by on-call', remainingActions: 3 };
    await ensureScheduleReconciled(fake.client, { ...weekly, spec: { intervals: [{ every: '1 hour' }] } });
    const s = fake.schedules.get('weekly')!;
    expect(s.state).toEqual({ paused: true, note: 'held by on-call', remainingActions: 3 });
    expect(s.action.workflowId).toBe('weekly-workflow');
    expect(s.spec.intervals).toEqual([{ every: 3_600_000 }]);
    expect(fake.calls.map((c) => c.op)).toEqual(['create', 'update']); // never deleted, triggered or backfilled
  });

  it('any other create failure is thrown, not taken for an existing schedule', async () => {
    const fake = fakeScheduleClient();
    const unavailable = Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
    (fake.client.schedule as { create: unknown }).create = async () => {
      throw unavailable;
    };
    await expect(ensureScheduleReconciled(fake.client, weekly)).rejects.toBe(unavailable);
  });
});
