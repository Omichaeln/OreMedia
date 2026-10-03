import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type { SeoAuditActivitiesV1, SeoAuditInputV1 } from '@oremedia/contracts/seo-audit';
import { createTestEnvironment, type TestEnvironment } from './environment';

/**
 * The SEO audit workflows on a real Temporal server with the bundle worker-ingest serves. v1 built its activity set
 * by spreading two activity proxies, which have no own keys, so every v1 run failed at its first activity; unit
 * tests of runSeoAudit (with a plain fake object) could not see it. This test runs the deployed wiring: v1 is shown
 * to fail that way, v2 completes a crawl, and the histories replay against the bundled code.
 */
const QUEUE = 'ingest-time-skipping-seo-audit';
const INGEST_WORKFLOWS = fileURLToPath(new URL('../src/queues/ingest.ts', import.meta.url));

let t: TestEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  t = await createTestEnvironment();
  bundle = await bundleWorkflowCode({ workflowsPath: INGEST_WORKFLOWS });
}, 300_000);
afterAll(async () => {
  await t?.env.teardown();
});

const input: SeoAuditInputV1 = {
  tenantId: 'ten_a',
  actor: { kind: 'platform_operator', id: 'seo-audit-sweep' },
  correlationId: 'seo-audit-ts',
  destinationId: 'dst_site',
  now: '2026-10-05T05:00:00.000Z',
  trigger: 'scheduled',
};

const fakes = (crawled: string[]): SeoAuditActivitiesV1 => ({
  planSeoAudit: async () => ({
    outcome: 'planned',
    runId: 'run_1',
    origin: 'https://example.com',
    seeds: ['https://example.com/'],
    limitsHit: [],
  }),
  crawlSeoAuditPage: async (i) => {
    crawled.push(i.url);
    return {
      outcome: 'crawled',
      status: 200,
      links: i.url === 'https://example.com/' ? ['https://example.com/about'] : [],
    };
  },
  finishSeoAudit: async () => ({ outcome: 'completed', pages: crawled.length }),
  pruneSeoAudits: async () => ({ deleted: 0 }),
});

let seq = 0;
type History = Awaited<
  ReturnType<Awaited<ReturnType<TestEnvironment['env']['client']['workflow']['start']>>['fetchHistory']>
>;
const histories: History[] = [];

describe('seoAuditWorkflowV1/V2 on a Temporal server', () => {
  it('v1 fails at its first activity: the spread of activity proxies is empty (the defect v2 fixes)', async () => {
    const crawled: string[] = [];
    const worker = await Worker.create({
      connection: t.env.nativeConnection,
      taskQueue: QUEUE,
      workflowBundle: bundle,
      activities: fakes(crawled),
    });
    await worker.runUntil(async () => {
      const h = await t.env.client.workflow.start('seoAuditWorkflowV1', {
        taskQueue: QUEUE,
        workflowId: `seo-audit-ts-${++seq}`,
        args: [input],
        workflowTaskTimeout: '5s',
        workflowExecutionTimeout: '30s',
      });
      await expect(h.result()).rejects.toThrow();
    });
    expect(crawled).toEqual([]);
  }, 300_000);

  it('v2 plans, crawls the seeds and their links, finishes and prunes', async () => {
    const crawled: string[] = [];
    const worker = await Worker.create({
      connection: t.env.nativeConnection,
      taskQueue: QUEUE,
      workflowBundle: bundle,
      activities: fakes(crawled),
    });
    const handle = await worker.runUntil(async () => {
      const h = await t.env.client.workflow.start('seoAuditWorkflowV2', {
        taskQueue: QUEUE,
        workflowId: `seo-audit-ts-${++seq}`,
        args: [input],
      });
      expect(await h.result()).toMatchObject({
        outcome: 'completed',
        runId: 'run_1',
        crawled: 2,
        failed: 0,
        pruned: 0,
      });
      return h;
    });
    expect(crawled).toEqual(['https://example.com/', 'https://example.com/about']);
    histories.push(await handle.fetchHistory());
  }, 300_000);

  it('the v2 sweep starts v2 children with the weekly id', async () => {
    const crawled: string[] = [];
    const worker = await Worker.create({
      connection: t.env.nativeConnection,
      taskQueue: QUEUE,
      workflowBundle: bundle,
      activities: {
        ...fakes(crawled),
        listSeoAuditTargets: async () => [{ tenantId: 'ten_a', destinationId: 'dst_site' }],
      },
    });
    await worker.runUntil(async () => {
      const h = await t.env.client.workflow.start('seoAuditSweepWorkflowV2', {
        taskQueue: QUEUE,
        workflowId: `seo-audit-sweep-ts-${++seq}`,
        args: [{ now: input.now, correlationId: 'sweep-ts' }],
      });
      expect(await h.result()).toMatchObject({ targets: 1, started: 1, failed: 0 });
      const child = t.env.client.workflow.getHandle('seo-audit:dst_site:2026-W41');
      expect(await child.result()).toMatchObject({ outcome: 'completed', crawled: 2 });
      expect((await child.describe()).type).toBe('seoAuditWorkflowV2');
    });
  }, 300_000);

  it('the recorded v2 history replays against the current workflow code without non-determinism', async () => {
    expect(histories.length).toBe(1);
    for (const history of histories)
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, 'seo-audit-v2-replay');
  }, 300_000);
});
