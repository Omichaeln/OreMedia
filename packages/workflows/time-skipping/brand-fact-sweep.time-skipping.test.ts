import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type { BrandFactSweepActivitiesV1, BrandFactSweepBrandInputV1 } from '@oremedia/contracts/fact-sweep';
import { CORE_WORKFLOWS, createTestEnvironment, type TestEnvironment } from './environment';

/**
 * brandFactSweepWorkflowV1 (BSC-3) on a real Temporal server, as the `brand-fact-sweep` schedule starts it (no
 * args): the due brands are listed once and each is swept as the platform job at the run's clock; a brand whose
 * sweep keeps failing never blocks the others; the histories replay against the bundled code. Activities are
 * recording fakes; the orchestration is the deployed code.
 */
const QUEUE = 'core-time-skipping-fact-sweep';

let t: TestEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  t = await createTestEnvironment();
  bundle = await bundleWorkflowCode({ workflowsPath: CORE_WORKFLOWS });
}, 300_000);
afterAll(async () => {
  await t?.env.teardown();
});

let seq = 0;
const start = () =>
  t.env.client.workflow.start('brandFactSweepWorkflowV1', {
    taskQueue: QUEUE,
    workflowId: `brand-fact-sweep-ts-${++seq}`,
    args: [{}],
  });
type History = Awaited<ReturnType<Awaited<ReturnType<typeof start>>['fetchHistory']>>;
const histories: History[] = [];

describe('brandFactSweepWorkflowV1 on a Temporal server (time-skipping in CI)', () => {
  it('lists the due brands once and sweeps each as the platform job at the run clock; a failing brand is counted, not fatal', async () => {
    const swept: BrandFactSweepBrandInputV1[] = [];
    const acts: BrandFactSweepActivitiesV1 = {
      listBrandFactSweepTargets: async () => [
        { tenantId: 'ten_a', brandId: 'brd_1' },
        { tenantId: 'ten_b', brandId: 'brd_broken' },
        { tenantId: 'ten_b', brandId: 'brd_2' },
      ],
      sweepBrandFacts: async (i) => {
        swept.push(i);
        if (i.brandId === 'brd_broken') throw new Error('database unavailable');
        return { expired: 1, reviewDue: 2, keyed: 0 };
      },
    };
    const worker = await Worker.create({
      connection: t.env.nativeConnection,
      taskQueue: QUEUE,
      workflowBundle: bundle,
      activities: acts,
    });
    const handle = await worker.runUntil(async () => {
      const h = await start();
      expect(await h.result()).toEqual({ brands: 3, expired: 2, reviewDue: 4, keyed: 0, failed: 1 });
      return h;
    });
    expect(swept.filter((s) => s.brandId === 'brd_broken')).toHaveLength(3); // the activity's three attempts
    expect(new Set(swept.map((s) => s.now)).size).toBe(1);
    expect(
      swept.every((s) => s.actor.kind === 'platform_operator' && s.actor.id === 'brand-fact-sweep'),
    ).toBe(true);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('the recorded history replays against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(1);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, 'brand-fact-sweep-replay');
  }, 300_000);
});
