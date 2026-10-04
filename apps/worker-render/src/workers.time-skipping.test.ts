import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Worker } from '@temporalio/worker';
import { MemoryStorageProvider, configureStorage } from '@oremedia/module-assets';
import type * as Assets from '@oremedia/module-assets';
// Relative import: the Temporal test environment helpers live with the workflow time-skipping tests.
import {
  SMOKE_CONTEXT,
  createTestEnvironment,
  fakeActivitiesOnWorkers,
  type FakeActivity,
  type TestEnvironment,
} from '../../../packages/workflows/time-skipping/environment';
import { startRenderWorkers, type RenderWorkersHandle } from './render-worker';

/**
 * G26 smoke test: worker-render's production start function (startRenderWorkers) boots against a real Temporal
 * server (the time-skipping test server, or the CLI dev server with TEMPORAL_CLI_PATH) and each task queue it creates
 * completes a workflow: `render` a render job with no targets, `media` an image upload and `video` a video upload,
 * both refused at the size check. Only the activities those workflows call are fakes (no database, object store,
 * Chromium or ffmpeg); the workers, their queues, bundles and registrations are the deployed ones. ffmpeg/ffprobe
 * are reported present so the `video` queue is created wherever the test runs (production refuses to start without).
 */
vi.mock('@oremedia/module-assets', async (importOriginal) => ({
  ...(await importOriginal<typeof Assets>()),
  mediaToolsAvailable: async () => true,
}));

/** Which queue ran the first activity, by the job or intent id. */
const ranOn = new Map<string, string>();

/** An upload over the size cap: begun, refused at verification, finalised as rejected. */
const refusedUpload = (taskQueue: string, finalise: string): Record<string, FakeActivity> => ({
  beginIngest: async (input: { intentId: string }) => {
    ranOn.set(input.intentId, taskQueue);
    return { storageKey: `uploads/${input.intentId}` };
  },
  verifyUpload: async () => ({ ok: false, reason: 'exceeds_cap' }),
  [finalise]: async () => undefined,
});

function fakes(taskQueue: string): Record<string, FakeActivity> | undefined {
  if (taskQueue === 'render')
    return {
      beginRender: async (input: { renderJobId: string }) => {
        ranOn.set(input.renderJobId, taskQueue);
        return { revisionId: 'rev', documentId: 'doc', brandId: 'brd' };
      },
      resolveRenderInputs: async () => ({
        ok: true,
        targets: [],
        brandVersionId: 'bv',
        fonts: [],
        assets: [],
        rendererVersion: 'smoke',
        manifest: {},
      }),
      completeRender: async () => ({ exportIds: [] }),
    };
  if (taskQueue === 'media') return refusedUpload(taskQueue, 'finaliseUpload');
  if (taskQueue === 'video') return refusedUpload(taskQueue, 'finaliseMediaUpload');
  return undefined;
}

let t: TestEnvironment;
let created: string[];
let render: RenderWorkersHandle;
let running: Promise<void>;

beforeAll(async () => {
  t = await createTestEnvironment();
  configureStorage(new MemoryStorageProvider());
  const workers = fakeActivitiesOnWorkers(Worker, fakes);
  render = await startRenderWorkers({
    NODE_ENV: 'test',
    TEMPORAL_ADDRESS: t.env.address,
    TEMPORAL_NAMESPACE: t.env.namespace ?? 'default',
  });
  workers.restore();
  created = workers.queues;
  running = render.run();
}, 300_000);

afterAll(async () => {
  render?.shutdown();
  await running;
  await render?.close();
  await t?.env.teardown();
});

describe('worker-render on a real Temporal server (G26)', () => {
  it('creates the render, media and video queues', () => {
    expect(created).toEqual(['render', 'media', 'video']);
    expect(render.queues).toEqual(created);
  });

  it('render: a render job completes', async () => {
    const result = await t.env.client.workflow.execute('renderJobWorkflowV1', {
      taskQueue: 'render',
      workflowId: 'smoke-render-job',
      args: [{ ...SMOKE_CONTEXT, renderJobId: 'rj_smoke' }],
    });
    expect(result).toEqual({ outcome: 'ready', exportIds: [] });
    expect(ranOn.get('rj_smoke')).toBe('render');
  });

  it.each([
    ['media', 'assetIngestWorkflowV1'],
    ['video', 'videoIngestWorkflowV1'],
  ])('%s: %s completes', async (taskQueue, workflowType) => {
    const intentId = `int_${taskQueue}`;
    const result = await t.env.client.workflow.execute(workflowType, {
      taskQueue,
      workflowId: `smoke-${workflowType}`,
      args: [{ ...SMOKE_CONTEXT, intentId, brandId: 'brd' }],
    });
    expect(result).toEqual({ outcome: 'rejected', reason: 'exceeds_cap' });
    expect(ranOn.get(intentId)).toBe(taskQueue);
  });

  it('shuts down cleanly', async () => {
    render.shutdown();
    await expect(running).resolves.toBeUndefined();
  });
});
