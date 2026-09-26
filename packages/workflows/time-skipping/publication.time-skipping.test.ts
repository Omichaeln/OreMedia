import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type {
  AttemptResult,
  PublicationState,
  PublicationWorkflowInputV1,
  PublishControlActivitiesV1,
  PublishProviderActivitiesV1,
  TransitionResultV1,
} from '@oremedia/contracts/publishing';
import { CORE_WORKFLOWS, createTestEnvironment, type TestEnvironment } from './environment';

/**
 * Spec 19.4 / ledger T.4: publicationWorkflowV1 on a real Temporal server with its real timers, signals and
 * workers. The durable wait, the cancel and reschedule races, a worker lost at each activity boundary, and a
 * replay of the recorded histories. Activities are recording fakes; the orchestration is the deployed code.
 */
const QUEUE = 'core-time-skipping';
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

const ok = (state: PublicationState): TransitionResultV1 => ({ state, version: 1, changed: true });

interface Hooks {
  /** Called when an activity runs, after it is recorded and before it returns. */
  onActivity?: (name: string, count: number) => Promise<void> | void;
}

function fakes(schedule: { scheduledFor: string; state?: PublicationState }, hooks: Hooks = {}) {
  const calls: string[] = [];
  const record =
    <I, R>(name: string, fn: (i: I) => R) =>
    async (i: I): Promise<Awaited<R>> => {
      calls.push(name);
      await hooks.onActivity?.(name, calls.filter((c) => c === name).length);
      return fn(i) as Awaited<R>;
    };
  const control: PublishControlActivitiesV1 = {
    readSchedule: record('readSchedule', () => ({
      state: schedule.state ?? 'scheduled',
      scheduledFor: schedule.scheduledFor,
      version: 0,
    })),
    cancelIfNotStarted: record('cancelIfNotStarted', () => ok('cancelled')),
    claimForDispatch: record('claimForDispatch', () => ({
      ok: true as const,
      fencingToken: 1,
      providerKey: PROVIDER,
      channelConnectionId: 'cc_1',
    })),
    evaluateRelease: record('evaluateRelease', () => ({ allow: true as const })),
    hold: record('hold', () => ok('held')),
    releaseClaimAndCancel: record('releaseClaimAndCancel', () => ok('cancelled')),
    openAttempt: record('openAttempt', () => 'att_1'),
    markProcessing: record('markProcessing', () => ok('processing')),
    markPublished: record('markPublished', () => ok('published')),
    markFailed: record('markFailed', () => ok('failed')),
    markOutcomeUnknown: record('markOutcomeUnknown', () => ok('outcome_unknown')),
    markRetryEligible: record('markRetryEligible', () => ok('retry_eligible')),
    holdForHuman: record('holdForHuman', () => ok('held')),
    retryAfterProvenNoEffect: record('retryAfterProvenNoEffect', () => ({
      retried: false as const,
      reason: 'state' as const,
    })),
  };
  const accepted: AttemptResult = {
    attemptId: 'att_1',
    outcome: 'accepted',
    remotePostId: 'post_1',
    remoteUrl: 'https://fixture.example/1',
  };
  const provider: PublishProviderActivitiesV1 = {
    publishOnce: record('publishOnce', () => accepted),
    checkStatus: record('checkStatus', () => ({ status: 'ready' as const })),
    finalize: record('finalize', () => ({
      status: 'completed' as const,
      remotePostId: 'post_1',
      remoteUrl: 'https://fixture.example/1',
    })),
    findRemotePost: record('findRemotePost', () => ({
      status: 'cannot_determine' as const,
      reason: 'fixture',
    })),
  };
  const count = (name: string) => calls.filter((c) => c === name).length;
  return { control, provider, calls, count };
}
type Fakes = ReturnType<typeof fakes>;

/**
 * `uncached` runs without a workflow cache, so there is no sticky task queue: when a worker stops mid-workflow the
 * next task goes to the normal queue at once. The time-skipping test server does not move a task off a stopped
 * worker's sticky queue, so a worker-lost test with the cache on hangs there.
 */
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
const input = (): PublicationWorkflowInputV1 => ({
  tenantId: 'ten_ts',
  actor: { kind: 'user', id: 'usr_ts' },
  correlationId: `corr_ts_${++seq}`,
  publicationId: `pub_ts_${seq}`,
});
const start = (i: PublicationWorkflowInputV1) =>
  t.env.client.workflow.start('publicationWorkflowV1', {
    taskQueue: QUEUE,
    workflowId: `publication:${i.publicationId}`,
    args: [i],
  });
type History = Awaited<ReturnType<Awaited<ReturnType<typeof start>>['fetchHistory']>>;
const histories: History[] = [];

/** Resolves once `predicate` holds, checking every 50 ms (the test's side of a race, never a workflow timer). */
async function until(predicate: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('publicationWorkflowV1 on a Temporal server (time-skipping in CI)', () => {
  it('waits durably until the scheduled time, re-reading the row, then publishes exactly once', async () => {
    const begin = await t.now();
    const f = fakes({ scheduledFor: new Date(begin + 3 * t.day).toISOString() });
    const [core, provider] = [await coreWorker(f), await providerWorker(f)];
    const handle = await provider.runUntil(
      core.runUntil(async () => {
        const h = await start(input());
        await h.result();
        return h;
      }),
    );
    expect(await t.now()).toBeGreaterThanOrEqual(begin + 3 * t.day);
    expect(f.count('readSchedule')).toBeGreaterThanOrEqual(2); // woke before due at least once, re-read the row
    expect(f.calls.filter((c) => c !== 'readSchedule')).toEqual([
      'claimForDispatch',
      'evaluateRelease',
      'openAttempt',
      'publishOnce',
      'markPublished',
    ]);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('a cancel during the wait cancels before any claim; nothing is sent', async () => {
    const begin = await t.now();
    const f = fakes({ scheduledFor: new Date(begin + 2 * t.day).toISOString() });
    const [core, provider] = [await coreWorker(f), await providerWorker(f)];
    await provider.runUntil(
      core.runUntil(async () => {
        const h = await start(input());
        await until(() => f.count('readSchedule') >= 1, 'the first schedule read');
        await h.signal('cancelSignal');
        await h.result();
      }),
    );
    expect(f.calls).toContain('cancelIfNotStarted');
    expect(f.calls).not.toContain('claimForDispatch');
    expect(f.calls).not.toContain('publishOnce');
  }, 300_000);

  it('a reschedule to an earlier time wakes the wait; it publishes then, not at the original time', async () => {
    const begin = await t.now();
    const schedule = { scheduledFor: new Date(begin + 10 * t.day).toISOString() };
    const f = fakes(schedule);
    const [core, provider] = [await coreWorker(f), await providerWorker(f)];
    const handle = await provider.runUntil(
      core.runUntil(async () => {
        const h = await start(input());
        await until(() => f.count('readSchedule') >= 1, 'the first schedule read');
        schedule.scheduledFor = new Date(begin + 1 * t.day).toISOString(); // the row changes, then the signal
        await h.signal('rescheduleSignal');
        await h.result();
        return h;
      }),
    );
    const end = await t.now();
    expect(end).toBeGreaterThanOrEqual(begin + 1 * t.day);
    expect(end).toBeLessThan(begin + 10 * t.day);
    expect(f.count('publishOnce')).toBe(1);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('a cancel that lands while the release is evaluated releases the claim; no attempt is opened', async () => {
    const begin = await t.now();
    const i = input();
    const f = fakes(
      { scheduledFor: new Date(begin).toISOString() },
      {
        onActivity: async (name) => {
          if (name === 'evaluateRelease')
            await t.env.client.workflow.getHandle(`publication:${i.publicationId}`).signal('cancelSignal');
        },
      },
    );
    const [core, provider] = [await coreWorker(f), await providerWorker(f)];
    await provider.runUntil(core.runUntil(async () => (await start(i)).result()));
    expect(f.calls).toContain('releaseClaimAndCancel');
    expect(f.calls).not.toContain('openAttempt');
    expect(f.calls).not.toContain('publishOnce');
  }, 300_000);

  describe('a worker lost after each activity: the next worker resumes from history, nothing runs twice', () => {
    const BOUNDARIES = ['readSchedule', 'claimForDispatch', 'evaluateRelease', 'openAttempt', 'publishOnce'];
    for (const boundary of BOUNDARIES)
      it(`after ${boundary}`, async () => {
        const begin = await t.now();
        let lost!: () => void;
        const workerLost = new Promise<void>((r) => (lost = r));
        const f = fakes(
          { scheduledFor: new Date(begin).toISOString() },
          { onActivity: (name, n) => (name === boundary && n === 1 ? lost() : undefined) },
        );
        const provider = await providerWorker(f);
        await provider.runUntil(async () => {
          const i = input();
          // The first core worker stops (gracefully, so the activity's result is recorded) at the boundary.
          const first = await coreWorker(f, { uncached: true });
          const h = await first.runUntil(async () => {
            const handle = await start(i);
            await workerLost;
            return handle;
          });
          // A second worker, with no cached state, picks the workflow up from its history.
          const second = await coreWorker(f, { uncached: true });
          await second.runUntil(h.result());
        });
        expect(f.calls.filter((c) => c !== 'readSchedule')).toEqual([
          'claimForDispatch',
          'evaluateRelease',
          'openAttempt',
          'publishOnce',
          'markPublished',
        ]);
        expect(f.count('readSchedule')).toBe(1);
      }, 300_000);
  });

  it('the recorded histories replay against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(2);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, 'publication-replay');
  }, 300_000);
});
