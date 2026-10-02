import { describe, expect, it } from 'vitest';
import { ScheduleAlreadyRunning, type Client } from '@temporalio/client';
import { RETENTION_SCHEDULE_ID } from '@oremedia/module-operations';
import { ensureRetentionScheduleRunning } from './operations-worker';

/** A schedule client that either creates, or already holds a schedule started with `existingArgs`. */
function scheduleClient(existingArgs: unknown[] | null) {
  const calls: Array<{ op: 'create' | 'update'; args: unknown[] }> = [];
  const client = {
    schedule: {
      create: async (opts: { action: { args: unknown[] } }) => {
        if (existingArgs) throw new ScheduleAlreadyRunning('already', RETENTION_SCHEDULE_ID);
        calls.push({ op: 'create', args: opts.action.args });
      },
      getHandle: () => ({
        describe: async () => ({
          action: { type: 'startWorkflow', workflowType: 'retentionSweepWorkflowV1', args: existingArgs },
          spec: {},
          policies: {},
          state: {},
        }),
        update: async (fn: (prev: unknown) => { action: { args: unknown[] } }) => {
          const next = fn({ action: { type: 'startWorkflow', args: existingArgs }, spec: {}, state: {} });
          calls.push({ op: 'update', args: next.action.args });
        },
      }),
    },
  } as unknown as Client;
  return { client, calls };
}

describe('ensureRetentionScheduleRunning (spec 17.5: the apply mode follows the environment at every start)', () => {
  it('creates the schedule in dry run by default, in apply mode with RETENTION_SWEEP_APPLY=true', async () => {
    const dry = scheduleClient(null);
    await ensureRetentionScheduleRunning(dry.client, {});
    expect(dry.calls).toEqual([{ op: 'create', args: [{ dryRun: true }] }]);
    const apply = scheduleClient(null);
    await ensureRetentionScheduleRunning(apply.client, { RETENTION_SWEEP_APPLY: 'true' });
    expect(apply.calls).toEqual([{ op: 'create', args: [{ dryRun: false }] }]);
  });

  it('an existing schedule is switched to the mode the environment reads now, and left alone when it matches', async () => {
    const flipped = scheduleClient([{ dryRun: true }]);
    await ensureRetentionScheduleRunning(flipped.client, { RETENTION_SWEEP_APPLY: 'true' });
    expect(flipped.calls).toEqual([{ op: 'update', args: [{ dryRun: false }] }]);
    const back = scheduleClient([{ dryRun: false }]);
    await ensureRetentionScheduleRunning(back.client, {});
    expect(back.calls).toEqual([{ op: 'update', args: [{ dryRun: true }] }]);
    const same = scheduleClient([{ dryRun: true }]);
    await ensureRetentionScheduleRunning(same.client, {});
    expect(same.calls).toEqual([]);
  });
});
