import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type { StudioGenerationActivitiesV1, StudioGenerationInputV1 } from '@oremedia/contracts/generation';
import { AGENTS_WORKFLOWS, createTestEnvironment, type TestEnvironment } from './environment';

/**
 * studioGenerationWorkflowV1 (STU-1b) on a real Temporal server, as the outbox starts it: begin, reserve, one model
 * call retried on a provider failure, save, settle; a cancel relayed by studioGenerationSignalRelayV1 while the model
 * call runs stops the attempt before anything is saved; the histories replay against the bundled code. Activities
 * are recording fakes; the orchestration is the deployed code.
 */
const QUEUE = 'agents-time-skipping-generation';

let t: TestEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  t = await createTestEnvironment();
  bundle = await bundleWorkflowCode({ workflowsPath: AGENTS_WORKFLOWS });
}, 300_000);
afterAll(async () => {
  await t?.env.teardown();
});

let seq = 0;
const inputFor = (): StudioGenerationInputV1 => ({
  tenantId: 'ten_ts',
  actor: { kind: 'user', id: 'usr_ts' },
  correlationId: `corr_ts_${++seq}`,
  jobId: `sgj_ts_${seq}`,
  attempt: 1,
});
const workflowId = (i: StudioGenerationInputV1) => `studio-gen:${i.jobId}:${i.attempt}`;
const start = (i: StudioGenerationInputV1) =>
  t.env.client.workflow.start('studioGenerationWorkflowV1', {
    taskQueue: QUEUE,
    workflowId: workflowId(i),
    args: [i],
  });
type History = Awaited<ReturnType<Awaited<ReturnType<typeof start>>['fetchHistory']>>;
const histories: History[] = [];

function recording(overrides: Partial<StudioGenerationActivitiesV1> = {}) {
  const calls: string[] = [];
  const acts: StudioGenerationActivitiesV1 = {
    beginGeneration: async () => (calls.push('begin'), { proceed: true }),
    reserveGenerationBudget: async () => (calls.push('reserve'), { proceed: true }),
    callGenerationModel: async () => (calls.push('model'), { proceed: true }),
    saveGeneration: async (i) => (calls.push('save'), { jobId: i.jobId, state: 'completed' }),
    failGeneration: async (i) => (calls.push(`fail:${i.code}`), { jobId: i.jobId, state: 'failed' }),
    settleGenerationBudget: async () => {
      calls.push('settle');
    },
    ...overrides,
  };
  return { acts, calls };
}

describe('studioGenerationWorkflowV1 on a Temporal server (time-skipping in CI)', () => {
  it('reserves before the model call, retries the model call after a provider failure, saves and settles', async () => {
    let modelAttempts = 0;
    const r = recording();
    r.acts.callGenerationModel = async () => {
      r.calls.push('model');
      modelAttempts += 1;
      if (modelAttempts === 1) throw new Error('provider unavailable');
      return { proceed: true };
    };
    const worker = await Worker.create({
      connection: t.env.nativeConnection,
      taskQueue: QUEUE,
      workflowBundle: bundle,
      activities: r.acts,
    });
    const i = inputFor();
    const handle = await worker.runUntil(async () => {
      const h = await start(i);
      expect(await h.result()).toEqual({ jobId: i.jobId, state: 'completed' });
      return h;
    });
    expect(r.calls).toEqual(['begin', 'reserve', 'model', 'model', 'save', 'settle']);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('a relayed cancel while the model call runs stops the attempt before the save; the reservation is settled', async () => {
    const r = recording();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    r.acts.callGenerationModel = async () => {
      r.calls.push('model');
      await gate;
      return { proceed: true };
    };
    const worker = await Worker.create({
      connection: t.env.nativeConnection,
      taskQueue: QUEUE,
      workflowBundle: bundle,
      activities: r.acts,
    });
    const i = inputFor();
    const handle = await worker.runUntil(async () => {
      const h = await start(i);
      while (!r.calls.includes('model')) await new Promise((res) => setTimeout(res, 50));
      const relay = await t.env.client.workflow.start('studioGenerationSignalRelayV1', {
        taskQueue: QUEUE,
        workflowId: `${workflowId(i)}:signal:1`,
        args: [{ workflowId: workflowId(i), signal: 'cancel' }],
      });
      await relay.result();
      release();
      expect(await h.result()).toEqual({ jobId: i.jobId, state: 'stopped' });
      return h;
    });
    expect(r.calls).toEqual(['begin', 'reserve', 'model', 'settle']);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('a budget refusal fails the job without a model call', async () => {
    const r = recording();
    const { ApplicationFailure } = await import('@temporalio/common');
    r.acts.reserveGenerationBudget = async () => {
      r.calls.push('reserve');
      throw ApplicationFailure.nonRetryable('budget exhausted: brand_day', 'BudgetExhausted');
    };
    const worker = await Worker.create({
      connection: t.env.nativeConnection,
      taskQueue: QUEUE,
      workflowBundle: bundle,
      activities: r.acts,
    });
    const i = inputFor();
    const handle = await worker.runUntil(async () => {
      const h = await start(i);
      expect(await h.result()).toEqual({ jobId: i.jobId, state: 'failed' });
      return h;
    });
    expect(r.calls).toEqual(['begin', 'reserve', 'fail:budget_exhausted', 'settle']);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('the recorded histories replay against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(3);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, 'studio-generation-replay');
  }, 300_000);
});
