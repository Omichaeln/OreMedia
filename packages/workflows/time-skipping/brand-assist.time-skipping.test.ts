import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type {
  BrandAssistActivitiesV1,
  BrandAssistInputV1,
  BrandSourceCaptureActivitiesV1,
  BrandSourceExtractActivitiesV1,
} from '@oremedia/contracts/brand-assist';
import { createTestEnvironment, type TestEnvironment } from './environment';

/**
 * brandAssistWorkflowV1 (BSC-4) on a real Temporal server with the three workers it spans: control and model calls
 * on the workflow's own queue, website capture on `ingest-metrics`, document extraction on `media`. A capture that
 * keeps failing is recorded after its retries and the job goes on; a model call that fails once succeeds on Temporal's
 * retry; a cancel relayed by brandAssistSignalRelayV1 stops the next section and the job is still closed; the
 * histories replay against the bundled code. Activities are recording fakes; the orchestration is the deployed code.
 */
const QUEUE = 'agents-time-skipping-brand-assist';
const AGENTS_WORKFLOWS = fileURLToPath(new URL('../src/queues/agents.ts', import.meta.url));

let t: TestEnvironment;
let bundle: WorkflowBundleWithSourceMap;
beforeAll(async () => {
  t = await createTestEnvironment();
  bundle = await bundleWorkflowCode({ workflowsPath: AGENTS_WORKFLOWS });
}, 300_000);
afterAll(async () => {
  await t?.env.teardown();
});

const input = (jobId: string): BrandAssistInputV1 => ({
  tenantId: 'ten_a',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: `c_${jobId}`,
  brandId: 'brd_1',
  jobId,
});
type History = Awaited<ReturnType<Awaited<ReturnType<typeof t.env.client.workflow.start>>['fetchHistory']>>;
const histories: History[] = [];

function fakes(calls: string[], opts: { slowSection?: string } = {}) {
  const attempts = new Map<string, number>();
  const attempt = (key: string) => {
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    return n;
  };
  const control: BrandAssistActivitiesV1 = {
    beginBrandAssist: async (i) => {
      calls.push('begin');
      return {
        outcome: 'run',
        reason: null,
        urlSourceIds: i.jobId === 'baj_cancel' ? [] : ['s_bad', 's_good'],
        documentSourceIds: i.jobId === 'baj_cancel' ? [] : ['s_doc'],
        sections: ['voice', 'facts'],
      };
    },
    markBrandAssistStage: async (i) => void calls.push(`stage:${i.stage}`),
    recordBrandSourceFailure: async (i) => void calls.push(`source-failed:${i.sourceId}`),
    prepareBrandAssistProposals: async () => {
      calls.push('prepare');
      return { outcome: 'run', reason: null, sections: ['voice', 'facts'] };
    },
    proposeBrandAssistSection: async (i) => {
      const n = attempt(`propose:${i.section}`);
      calls.push(`propose:${i.section}:${n}`);
      if (i.section === opts.slowSection) await new Promise((r) => setTimeout(r, 1500));
      if (i.section === 'voice' && n === 1 && !opts.slowSection) throw new Error('provider 503');
      return { section: i.section, outcome: 'ready', suggestions: 1, reason: null };
    },
    recordBrandAssistSectionFailure: async (i) => void calls.push(`section-failed:${i.section}`),
    finishBrandAssist: async (i) => {
      calls.push(`finish:${i.cancelled}`);
      return { state: i.cancelled ? 'cancelled' : 'ready', suggestions: 2 };
    },
  };
  const capture: BrandSourceCaptureActivitiesV1 = {
    captureBrandSourceUrl: async (i) => {
      calls.push(`capture:${i.sourceId}:${attempt(`capture:${i.sourceId}`)}`);
      if (i.sourceId === 's_bad') throw new Error('crashed');
      return { sourceId: i.sourceId, status: 'captured', reason: null };
    },
  };
  const extract: BrandSourceExtractActivitiesV1 = {
    extractBrandSourceDocument: async (i) => {
      calls.push(`extract:${i.sourceId}`);
      return { sourceId: i.sourceId, status: 'captured', reason: null };
    },
  };
  return { control, capture, extract };
}

async function workers(f: ReturnType<typeof fakes>) {
  return Promise.all([
    Worker.create({
      connection: t.env.nativeConnection,
      taskQueue: QUEUE,
      workflowBundle: bundle,
      activities: f.control,
    }),
    Worker.create({ connection: t.env.nativeConnection, taskQueue: 'ingest-metrics', activities: f.capture }),
    Worker.create({ connection: t.env.nativeConnection, taskQueue: 'media', activities: f.extract }),
  ]);
}
const runAll = <T>(ws: Worker[], fn: () => Promise<T>): Promise<T> => {
  const [first, ...rest] = ws;
  return rest.reduce<() => Promise<T>>(
    (inner, w) => () => w.runUntil(inner),
    () => first!.runUntil(fn),
  )();
};

describe('brandAssistWorkflowV1 on a Temporal server (time-skipping in CI)', () => {
  it('spans the three queues; a failing capture is recorded after its retries; a model call is retried', async () => {
    const calls: string[] = [];
    const ws = await workers(fakes(calls));
    const handle = await runAll(ws, async () => {
      const h = await t.env.client.workflow.start('brandAssistWorkflowV1', {
        taskQueue: QUEUE,
        workflowId: 'brand-assist:baj_run',
        args: [input('baj_run')],
      });
      expect(await h.result()).toEqual({ state: 'ready', suggestions: 2 });
      return h;
    });
    expect(calls).toEqual([
      'begin',
      'capture:s_bad:1',
      'capture:s_bad:2',
      'source-failed:s_bad',
      'capture:s_good:1',
      'stage:extracting',
      'extract:s_doc',
      'prepare',
      'propose:voice:1',
      'propose:voice:2',
      'propose:facts:1',
      'finish:false',
    ]);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('a cancel relayed while a section runs stops the next one; the job is closed as cancelled', async () => {
    const calls: string[] = [];
    const ws = await workers(fakes(calls, { slowSection: 'voice' }));
    const handle = await runAll(ws, async () => {
      const h = await t.env.client.workflow.start('brandAssistWorkflowV1', {
        taskQueue: QUEUE,
        workflowId: 'brand-assist:baj_cancel',
        args: [input('baj_cancel')],
      });
      while (!calls.includes('propose:voice:1')) await new Promise((r) => setTimeout(r, 50));
      const relay = await t.env.client.workflow.start('brandAssistSignalRelayV1', {
        taskQueue: QUEUE,
        workflowId: 'brand-assist:baj_cancel:signal:evt_1',
        args: [{ workflowId: 'brand-assist:baj_cancel', signal: 'cancelBrandAssist' }],
      });
      await relay.result();
      expect(await h.result()).toEqual({ state: 'cancelled', suggestions: 2 });
      return h;
    });
    expect(calls).toEqual(['begin', 'prepare', 'propose:voice:1', 'finish:true']);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('the recorded histories replay against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(2);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, 'brand-assist-replay');
  }, 300_000);
});
