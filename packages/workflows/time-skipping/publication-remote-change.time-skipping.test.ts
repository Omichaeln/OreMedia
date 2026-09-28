import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type {
  PublicationRemoteChangeInputV1,
  RecordRemoteChangeInputV1,
  RemoteChangeAttemptResultV1,
  RemoteChangeControlActivitiesV1,
  RemoteChangeProviderActivitiesV1,
} from '@oremedia/contracts/publishing';
import { CORE_WORKFLOWS, createTestEnvironment, type TestEnvironment } from './environment';

/**
 * publicationRemoteDeleteWorkflowV1 / publicationRemoteEditWorkflowV1 on a real Temporal server: the provider call
 * runs on the provider's queue, the outcome is recorded on `core`, a retryable outcome waits out its backoff on a
 * durable timer, a skipped change records nothing, a worker lost after the platform call resumes from history
 * without calling the platform again, and the histories replay. Activities are recording fakes.
 */
const QUEUE = 'core-remote-change';
const PROVIDER = 'fixture_provider';

let t: TestEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  t = await createTestEnvironment();
  bundle = await bundleWorkflowCode({ workflowsPath: CORE_WORKFLOWS });
}, 300_000);
afterAll(async () => {
  await t?.env.teardown();
});

function fakes(script: RemoteChangeAttemptResultV1[], onProviderCall?: (n: number) => void) {
  const calls: string[] = [];
  const recorded: RecordRemoteChangeInputV1[] = [];
  const answer = (name: string) => async (): Promise<RemoteChangeAttemptResultV1> => {
    calls.push(name);
    const n = calls.filter((c) => c === name).length;
    onProviderCall?.(n);
    return script[Math.min(n - 1, script.length - 1)]!;
  };
  const provider: RemoteChangeProviderActivitiesV1 = {
    deleteRemotePost: answer('deleteRemotePost'),
    editRemotePost: answer('editRemotePost'),
  };
  const control: RemoteChangeControlActivitiesV1 = {
    recordRemoteChangeOutcome: async (i) => {
      calls.push('recordRemoteChangeOutcome');
      recorded.push(i);
      return { state: 'succeeded', publicationState: 'removed', changed: true };
    },
  };
  return { provider, control, calls, recorded };
}
type Fakes = ReturnType<typeof fakes>;

const coreWorker = (f: Fakes, { uncached = false } = {}) =>
  Worker.create({
    connection: t.env.nativeConnection,
    taskQueue: QUEUE,
    workflowBundle: bundle,
    activities: f.control,
    ...(uncached ? { maxCachedWorkflows: 0 } : {}),
  });
const providerWorker = (f: Fakes) =>
  Worker.create({
    connection: t.env.nativeConnection,
    taskQueue: `publish-${PROVIDER}`,
    activities: f.provider,
  });

let seq = 0;
const input = (): PublicationRemoteChangeInputV1 => ({
  tenantId: 'ten_ts',
  actor: { kind: 'user', id: 'usr_ts' },
  correlationId: `corr_rc_${++seq}`,
  publicationId: `pub_rc_${seq}`,
  changeId: `prc_rc_${seq}`,
  providerKey: PROVIDER,
});
const start = (type: 'publicationRemoteDeleteWorkflowV1' | 'publicationRemoteEditWorkflowV1', i = input()) =>
  t.env.client.workflow.start(type, {
    taskQueue: QUEUE,
    workflowId: `pub:${i.publicationId}:remote:${i.changeId}`,
    args: [i],
  });
type History = Awaited<ReturnType<Awaited<ReturnType<typeof start>>['fetchHistory']>>;
const histories: History[] = [];

describe('remote edit and delete workflows on a Temporal server (time-skipping in CI)', () => {
  it('delete: the platform call on publish-<provider>, then the outcome recorded once on core', async () => {
    const f = fakes([{ outcome: 'done' }]);
    const [core, provider] = [await coreWorker(f), await providerWorker(f)];
    const i = input();
    const handle = await provider.runUntil(
      core.runUntil(async () => {
        const h = await start('publicationRemoteDeleteWorkflowV1', i);
        await h.result();
        return h;
      }),
    );
    expect(await handle.result()).toMatchObject({ outcome: 'recorded', attempts: 1 });
    expect(f.calls).toEqual(['deleteRemotePost', 'recordRemoteChangeOutcome']);
    expect(f.recorded).toEqual([{ ...i, result: { outcome: 'done' } }]);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('edit: a throttled call waits out its backoff on a durable timer, then succeeds', async () => {
    const f = fakes([
      { outcome: 'retryable_error', code: 'rate_limited', message: 'slow down' },
      { outcome: 'done' },
    ]);
    const [core, provider] = [await coreWorker(f), await providerWorker(f)];
    const begin = await t.now();
    const handle = await provider.runUntil(
      core.runUntil(async () => {
        const h = await start('publicationRemoteEditWorkflowV1');
        await h.result();
        return h;
      }),
    );
    expect(await t.now()).toBeGreaterThanOrEqual(begin + 30_000);
    expect(f.calls).toEqual(['editRemotePost', 'editRemotePost', 'recordRemoteChangeOutcome']);
    expect(f.recorded[0]?.result).toEqual({ outcome: 'done' });
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('a change that is no longer requested is skipped: nothing is recorded', async () => {
    const f = fakes([{ outcome: 'skipped', reason: 'change_failed' }]);
    const [core, provider] = [await coreWorker(f), await providerWorker(f)];
    const out = await provider.runUntil(
      core.runUntil(async () => (await start('publicationRemoteDeleteWorkflowV1')).result()),
    );
    expect(out).toMatchObject({ outcome: 'skipped' });
    expect(f.calls).toEqual(['deleteRemotePost']);
  }, 300_000);

  it('a core worker lost after the platform call resumes from history: the platform is called once', async () => {
    let lost!: () => void;
    const workerLost = new Promise<void>((r) => (lost = r));
    const f = fakes([{ outcome: 'done' }], (n) => (n === 1 ? lost() : undefined));
    const provider = await providerWorker(f);
    await provider.runUntil(async () => {
      const first = await coreWorker(f, { uncached: true });
      const h = await first.runUntil(async () => {
        const handle = await start('publicationRemoteDeleteWorkflowV1');
        await workerLost;
        return handle;
      });
      const second = await coreWorker(f, { uncached: true });
      await second.runUntil(h.result());
    });
    expect(f.calls).toEqual(['deleteRemotePost', 'recordRemoteChangeOutcome']);
  }, 300_000);

  it('the recorded histories replay against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(2);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, 'remote-change-replay');
  }, 300_000);
});
