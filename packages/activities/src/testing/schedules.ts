import { describe, expect, it } from 'vitest';
import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  type Client,
  type ScheduleDescription,
  type ScheduleOptions,
  type ScheduleSpec,
  type ScheduleUpdateOptions,
} from '@temporalio/client';
import { decodeScheduleSpec, encodeScheduleSpec } from '@temporalio/client/lib/schedule-helpers.js';
import { msToNumber } from '@temporalio/common/lib/time.js';

/** A schedule as the fake server holds it: what describe() returns (the parts the workers read). */
export type FakeSchedule = Pick<
  ScheduleDescription,
  'scheduleId' | 'spec' | 'action' | 'policies' | 'state'
> & {
  info: { numActionsTaken: number };
};

export type FakeScheduleCall = {
  op: 'create' | 'update' | 'delete' | 'pause' | 'unpause' | 'trigger' | 'backfill';
  scheduleId: string;
};

/**
 * The server's form of a spec, as a Temporal dev server answers describe() (checked against `temporal server
 * start-dev`): calendar fields as ranges, an empty comment and timezone, intervals in ms with no offset.
 */
export function serverSpec(spec: ScheduleSpec): ScheduleDescription['spec'] {
  const decoded = decodeScheduleSpec(encodeScheduleSpec(spec));
  return {
    calendars: (decoded.calendars ?? []).map((c) => ({ ...c, comment: c.comment ?? '' })),
    intervals: (decoded.intervals ?? []).map((i) => ({ every: i.every })),
    skip: decoded.skip ?? [],
    timezone: decoded.timezone ?? '',
  } as ScheduleDescription['spec'];
}

const serverPolicies = (p: ScheduleOptions['policies']): ScheduleDescription['policies'] => ({
  overlap: p?.overlap ?? ScheduleOverlapPolicy.SKIP,
  catchupWindow: p?.catchupWindow !== undefined ? msToNumber(p.catchupWindow) : 60_000,
  pauseOnFailure: p?.pauseOnFailure === true,
});

/**
 * An in-memory schedule client: create refuses an existing id (ScheduleAlreadyRunning), describe/update/delete
 * refuse an unknown one (ScheduleNotFoundError), and every call is recorded. An update stores exactly what its
 * function returned (a dropped state un-pauses, as on the server), and nothing here takes an action.
 */
export function fakeScheduleClient() {
  const schedules = new Map<string, FakeSchedule>();
  const calls: FakeScheduleCall[] = [];
  const held = (scheduleId: string): FakeSchedule => {
    const s = schedules.get(scheduleId);
    if (!s) throw new ScheduleNotFoundError('schedule not found', scheduleId);
    return s;
  };
  const record = (op: FakeScheduleCall['op'], scheduleId: string) => calls.push({ op, scheduleId });
  const client = {
    schedule: {
      create: async (opts: ScheduleOptions) => {
        if (schedules.has(opts.scheduleId))
          throw new ScheduleAlreadyRunning('schedule already exists', opts.scheduleId);
        if (opts.state?.triggerImmediately) record('trigger', opts.scheduleId);
        if (opts.state?.backfill?.length) record('backfill', opts.scheduleId);
        record('create', opts.scheduleId);
        schedules.set(opts.scheduleId, {
          scheduleId: opts.scheduleId,
          spec: serverSpec(opts.spec),
          action: {
            ...opts.action,
            workflowId: opts.action.workflowId ?? `${opts.scheduleId}-workflow`,
            args: opts.action.args ?? [],
          } as ScheduleDescription['action'],
          policies: serverPolicies(opts.policies),
          state: { paused: opts.state?.paused === true, note: opts.state?.note ?? '' },
          info: { numActionsTaken: 0 },
        });
      },
      getHandle: (scheduleId: string) => ({
        scheduleId,
        describe: async () => structuredClone(held(scheduleId)) as unknown as ScheduleDescription,
        update: async (fn: (previous: ScheduleDescription) => ScheduleUpdateOptions) => {
          const previous = held(scheduleId);
          const next = fn(structuredClone(previous) as unknown as ScheduleDescription);
          // The SDK's update type omits keys from a union with undefined; it is the create state minus trigger/backfill.
          const state = next.state as ScheduleOptions['state'];
          record('update', scheduleId);
          schedules.set(scheduleId, {
            ...previous,
            spec: serverSpec(next.spec),
            action: { ...next.action, args: next.action.args ?? [] } as ScheduleDescription['action'],
            policies: serverPolicies(next.policies),
            state: {
              paused: state?.paused === true,
              note: state?.note ?? '',
              ...(state?.remainingActions !== undefined ? { remainingActions: state.remainingActions } : {}),
            },
          });
        },
        delete: async () => {
          held(scheduleId);
          record('delete', scheduleId);
          schedules.delete(scheduleId);
        },
        pause: async (note?: string) => {
          record('pause', scheduleId);
          held(scheduleId).state = { paused: true, note: note ?? '' };
        },
        unpause: async (note?: string) => {
          record('unpause', scheduleId);
          held(scheduleId).state = { paused: false, note: note ?? '' };
        },
        trigger: async () => record('trigger', scheduleId),
        backfill: async () => record('backfill', scheduleId),
      }),
    },
  } as unknown as Client;
  return { client, schedules, calls };
}

export interface ExpectedSchedule {
  scheduleId: string;
  workflowType: string;
  taskQueue: string;
  args: unknown[];
  /** The spec the code wants, as written in it (a calendar or an interval). */
  spec: ScheduleSpec;
  overlap: ScheduleOverlapPolicy;
  catchupWindow: string;
}

/** A spec of the same kind that differs: a different interval, or a different time of day. */
const driftedSpec = (spec: ScheduleSpec): ScheduleSpec => {
  const interval = spec.intervals?.[0];
  return interval
    ? { intervals: [{ every: msToNumber(interval.every) * 2 }] }
    : { calendars: [{ hour: 12, minute: 34 }] };
};

const stored = (fake: ReturnType<typeof fakeScheduleClient>, scheduleId: string): FakeSchedule => {
  const s = fake.schedules.get(scheduleId);
  if (!s) throw new Error(`schedule ${scheduleId} was not created`);
  return s;
};

/**
 * The reconcile contract of one worker's ensure*Scheduled function (gap G20), run against the fake client: it
 * creates the schedule when absent; a second start against the schedule it created updates nothing; a drifted
 * interval or calendar, catch-up window or action is brought back with one update that keeps an operator's pause
 * and note; nothing is deleted, triggered or backfilled. `setup` seeds what the function expects to find besides
 * its own schedules (for example a retired schedule it removes).
 */
export function describeScheduleReconcile(
  name: string,
  ensure: (client: Client) => Promise<void>,
  expected: ExpectedSchedule[],
  setup: (fake: ReturnType<typeof fakeScheduleClient>) => Promise<void> = async () => undefined,
): void {
  const ids = expected.map((e) => e.scheduleId);
  const started = async () => {
    const fake = fakeScheduleClient();
    await setup(fake);
    await ensure(fake.client);
    fake.calls.length = 0;
    return fake;
  };
  const updates = (fake: ReturnType<typeof fakeScheduleClient>) => fake.calls;

  describe(`${name} (G20: created once, reconciled with the code at every start)`, () => {
    it('creates the schedule when it is absent, with the spec, action and policies of the code', async () => {
      const fake = fakeScheduleClient();
      await setup(fake);
      fake.calls.length = 0;
      await ensure(fake.client);
      expect(fake.calls.filter((c) => c.op === 'create').map((c) => c.scheduleId)).toEqual(ids);
      for (const e of expected) {
        const s = stored(fake, e.scheduleId);
        expect(s.spec).toEqual(serverSpec(e.spec));
        expect(s.action).toMatchObject({
          workflowType: e.workflowType,
          taskQueue: e.taskQueue,
          args: e.args,
        });
        expect(s.action.workflowId).toBe(`${e.scheduleId}-workflow`);
        expect(s.policies).toEqual({
          overlap: e.overlap,
          catchupWindow: msToNumber(e.catchupWindow),
          pauseOnFailure: false,
        });
        expect(s.state.paused).toBe(false);
      }
    });

    it('a second start against the schedule it created updates nothing', async () => {
      const fake = await started();
      await ensure(fake.client);
      expect(updates(fake)).toEqual([]);
    });

    it('a changed interval or calendar is brought back with one update that keeps the pause and the note', async () => {
      const fake = await started();
      for (const e of expected) {
        const s = stored(fake, e.scheduleId);
        s.spec = serverSpec(driftedSpec(e.spec));
        s.state = { paused: true, note: 'held by on-call' };
      }
      await ensure(fake.client);
      expect(updates(fake)).toEqual(ids.map((scheduleId) => ({ op: 'update', scheduleId })));
      for (const e of expected) {
        const s = stored(fake, e.scheduleId);
        expect(s.spec).toEqual(serverSpec(e.spec));
        expect(s.state).toEqual({ paused: true, note: 'held by on-call' });
        expect(s.policies.overlap).toBe(e.overlap);
        expect(s.action).toMatchObject({
          workflowType: e.workflowType,
          taskQueue: e.taskQueue,
          args: e.args,
        });
        expect(s.action.workflowId).toBe(`${e.scheduleId}-workflow`);
      }
      await ensure(fake.client);
      expect(updates(fake)).toHaveLength(ids.length); // reconciled once; the next start finds it equal
    });

    it('a changed catch-up window, overlap policy or action args is brought back too', async () => {
      const fake = await started();
      for (const e of expected) {
        const s = stored(fake, e.scheduleId);
        s.policies = {
          overlap: ScheduleOverlapPolicy.ALLOW_ALL,
          catchupWindow: 60_000,
          pauseOnFailure: false,
        };
        s.action = { ...s.action, args: [{ stale: true }] };
      }
      await ensure(fake.client);
      expect(updates(fake)).toEqual(ids.map((scheduleId) => ({ op: 'update', scheduleId })));
      for (const e of expected) {
        const s = stored(fake, e.scheduleId);
        expect(s.policies).toEqual({
          overlap: e.overlap,
          catchupWindow: msToNumber(e.catchupWindow),
          pauseOnFailure: false,
        });
        expect(s.action.args).toEqual(e.args);
      }
    });
  });
}
