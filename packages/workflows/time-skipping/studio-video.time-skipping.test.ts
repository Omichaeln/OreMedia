import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type {
  StudioVideoJobActivitiesV1,
  StudioVideoJobInputV1,
  VideoJobStepOutcomeV1,
} from '@oremedia/contracts/video-ai';
import { AGENTS_WORKFLOWS, createTestEnvironment, type TestEnvironment } from './environment';

/**
 * studioVideoJobWorkflowV1 (STU-3) on a real Temporal server: the steps run on task queue `agents` in order; a model
 * call that fails transiently is retried after its backoff and the job saves once; a budget refusal is not retried
 * and fails the job; the `cancelVideoJob` signal relayed by studioVideoJobSignalRelayV1 stops the attempt between
 * steps without saving; the reservation is settled on every path; histories replay.
 */
const QUEUE = 'studio-video-time-skipping';
const GO: VideoJobStepOutcomeV1 = { proceed: true };

let t: TestEnvironment;
let bundle: WorkflowBundleWithSourceMap;
beforeAll(async () => {
  t = await createTestEnvironment();
  bundle = await bundleWorkflowCode({ workflowsPath: AGENTS_WORKFLOWS });
}, 300_000);
afterAll(async () => {
  await t?.env.teardown();
});

function fakes(mode: 'ok' | 'transient' | 'budget' | 'slow_model') {
  const calls: string[] = [];
  let modelAttempts = 0;
  let release: (() => void) | null = null;
  const acts: StudioVideoJobActivitiesV1 = {
    beginVideoJob: async () => (calls.push('begin'), GO),
    reserveVideoJobBudget: async () => {
      calls.push('reserve');
      if (mode === 'budget') throw ApplicationFailure.nonRetryable('brand_day', 'BudgetExhausted');
      return GO;
    },
    callVideoJobModel: async () => {
      calls.push('model');
      if (mode === 'transient' && modelAttempts++ === 0) throw new Error('provider unavailable');
      if (mode === 'slow_model') await new Promise<void>((r) => (release = r));
      return GO;
    },
    saveVideoJob: async (i) => (calls.push('save'), { jobId: i.jobId, state: 'completed' }),
    failVideoJob: async (i) => (calls.push(`fail:${i.code}`), { jobId: i.jobId, state: 'failed' }),
    settleVideoJobBudget: async () => {
      calls.push('settle');
    },
  };
  return {
    acts,
    calls,
    count: (n: string) => calls.filter((c) => c === n).length,
    finishModel: () => (release as (() => void) | null)?.(),
  };
}

let seq = 0;
const input = (): StudioVideoJobInputV1 => ({
  tenantId: 'ten_ts',
  actor: { kind: 'user', id: 'usr_ts' },
  correlationId: `corr_sv_${++seq}`,
  jobId: `svj_${seq}`,
  attempt: 1,
});
const histories: unknown[] = [];

async function run(f: ReturnType<typeof fakes>, during?: (workflowId: string) => Promise<void>) {
  const worker = await Worker.create({
    connection: t.env.nativeConnection,
    taskQueue: QUEUE,
    workflowBundle: bundle,
    activities: f.acts,
  });
  return worker.runUntil(async () => {
    const i = input();
    const workflowId = `studio-video:${i.jobId}:${i.attempt}`;
    const h = await t.env.client.workflow.start('studioVideoJobWorkflowV1', {
      taskQueue: QUEUE,
      workflowId,
      args: [i],
    });
    if (during) await during(workflowId);
    return { result: await h.result().catch((e: unknown) => e), history: await h.fetchHistory() };
  });
}

describe('studioVideoJobWorkflowV1 on a Temporal server (time-skipping in CI)', () => {
  it('runs begin, reserve, model, save and settle in order', async () => {
    const f = fakes('ok');
    const { result, history } = await run(f);
    expect(result).toMatchObject({ state: 'completed' });
    expect(f.calls).toEqual(['begin', 'reserve', 'model', 'save', 'settle']);
    histories.push(history);
  }, 300_000);

  it('retries a transient model failure after its backoff and saves once', async () => {
    const begin = await t.now();
    const f = fakes('transient');
    const { result, history } = await run(f);
    expect(result).toMatchObject({ state: 'completed' });
    expect(f.count('model')).toBe(2);
    expect(f.count('save')).toBe(1);
    expect(await t.now()).toBeGreaterThanOrEqual(begin + Math.min(5_000, (t.day / 86_400_000) * 5_000));
    histories.push(history);
  }, 300_000);

  it('a budget refusal is not retried: the job fails as budget_exhausted and the reservation is settled', async () => {
    const f = fakes('budget');
    const { result, history } = await run(f);
    expect(result).toMatchObject({ state: 'failed' });
    expect(f.count('reserve')).toBe(1);
    expect(f.calls).toEqual(['begin', 'reserve', 'fail:budget_exhausted', 'settle']);
    histories.push(history);
  }, 300_000);

  it('a cancel relayed while the model runs stops the attempt before saving', async () => {
    const f = fakes('slow_model');
    const { result, history } = await run(f, async (workflowId) => {
      while (f.count('model') === 0) await new Promise((r) => setTimeout(r, 50));
      await t.env.client.workflow.execute('studioVideoJobSignalRelayV1', {
        taskQueue: QUEUE,
        workflowId: `${workflowId}:signal:evt_1`,
        args: [{ workflowId, signal: 'cancel' }],
      });
      f.finishModel();
    });
    expect(result).toMatchObject({ state: 'stopped' });
    expect(f.count('save')).toBe(0);
    expect(f.count('settle')).toBe(1);
    histories.push(history);
  }, 300_000);

  it('the recorded histories replay against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(4);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history as never, 'studio-video-replay');
  }, 300_000);
});
