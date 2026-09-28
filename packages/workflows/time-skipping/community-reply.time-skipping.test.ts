import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type {
  CommunityReplyControlActivitiesV1,
  CommunityReplyProviderActivitiesV1,
  CommunityReplyWorkflowInputV1,
  ReplySendResultV1,
} from '@oremedia/contracts/community';
import { CORE_WORKFLOWS, createTestEnvironment, type TestEnvironment } from './environment';

/**
 * communityReplyWorkflowV1 on a real Temporal server: the reply is sent once on the provider's queue and recorded
 * on core; a failure proven before the send boundary waits out its backoff on a durable timer and is tried again;
 * a core worker lost after the send resumes from history without sending again; the histories replay.
 * Activities are recording fakes; the orchestration is the deployed code.
 */
const QUEUE = 'core-time-skipping-reply';
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

const accepted: ReplySendResultV1 = { outcome: 'accepted', remoteMessageId: 'c_9', remoteUrl: null };

function fakes(sends: ReplySendResultV1[], hooks: { onActivity?: (name: string) => void } = {}) {
  const calls: string[] = [];
  let sent = 0;
  const record =
    <I, R>(name: string, fn: (i: I) => R) =>
    async (i: I): Promise<Awaited<R>> => {
      calls.push(name);
      hooks.onActivity?.(name);
      return fn(i) as Awaited<R>;
    };
  const control: CommunityReplyControlActivitiesV1 = {
    readReplyRoute: record('readReplyRoute', () => ({ providerKey: PROVIDER })),
    recordReplyOutcome: record('recordReplyOutcome', (i: { result: ReplySendResultV1 }) => ({
      state: i.result.outcome === 'accepted' ? ('sent' as const) : ('failed' as const),
      messageId: i.result.outcome === 'accepted' ? 'msg_out' : null,
      changed: true,
    })),
  };
  const provider: CommunityReplyProviderActivitiesV1 = {
    sendReplyOnce: record('sendReplyOnce', () => sends[Math.min(sent++, sends.length - 1)]!),
  };
  return { control, provider, calls, count: (n: string) => calls.filter((c) => c === n).length };
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
const input = (): CommunityReplyWorkflowInputV1 => ({
  tenantId: 'ten_ts',
  actor: { kind: 'user', id: 'usr_ts' },
  correlationId: `corr_reply_${++seq}`,
  responseDraftId: `rdft_ts_${seq}`,
});
const start = (i: CommunityReplyWorkflowInputV1) =>
  t.env.client.workflow.start('communityReplyWorkflowV1', {
    taskQueue: QUEUE,
    workflowId: `reply:${i.responseDraftId}`,
    args: [i],
  });
type History = Awaited<ReturnType<Awaited<ReturnType<typeof start>>['fetchHistory']>>;
const histories: History[] = [];

describe('communityReplyWorkflowV1 on a Temporal server (time-skipping in CI)', () => {
  it('sends the reply once on publish-<provider> and records it on core', async () => {
    const f = fakes([accepted]);
    const [core, provider] = [await coreWorker(f), await providerWorker(f)];
    const handle = await provider.runUntil(
      core.runUntil(async () => {
        const h = await start(input());
        expect(await h.result()).toEqual({ state: 'sent', messageId: 'msg_out', changed: true });
        return h;
      }),
    );
    expect(f.calls).toEqual(['readReplyRoute', 'sendReplyOnce', 'recordReplyOutcome']);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('a pre-send failure waits out its backoff on a durable timer, then the reply is sent', async () => {
    const begin = await t.now();
    const f = fakes([
      { outcome: 'retryable_error', code: 'pre_send', message: 'rate limit wait exceeded', retryAfterMs: 0 },
      accepted,
    ]);
    const [core, provider] = [await coreWorker(f), await providerWorker(f)];
    const handle = await provider.runUntil(
      core.runUntil(async () => {
        const h = await start(input());
        await h.result();
        return h;
      }),
    );
    expect(f.count('sendReplyOnce')).toBe(2);
    expect(f.count('recordReplyOutcome')).toBe(1);
    // The first backoff is 30 s of workflow time (scaled with the environment's day when not time-skipping).
    expect(await t.now()).toBeGreaterThanOrEqual(begin + Math.min(30_000, (t.day / 86_400_000) * 30_000));
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('a core worker lost right after the send resumes from history and never sends again', async () => {
    let lost!: () => void;
    const workerLost = new Promise<void>((r) => (lost = r));
    const f = fakes([accepted], { onActivity: (name) => (name === 'sendReplyOnce' ? lost() : undefined) });
    const provider = await providerWorker(f);
    await provider.runUntil(async () => {
      const i = input();
      const first = await coreWorker(f, { uncached: true });
      const h = await first.runUntil(async () => {
        const handle = await start(i);
        await workerLost;
        return handle;
      });
      const second = await coreWorker(f, { uncached: true });
      await second.runUntil(h.result());
    });
    expect(f.count('sendReplyOnce')).toBe(1);
    expect(f.count('recordReplyOutcome')).toBe(1);
  }, 300_000);

  it('the recorded histories replay against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(2);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, 'community-reply-replay');
  }, 300_000);
});
