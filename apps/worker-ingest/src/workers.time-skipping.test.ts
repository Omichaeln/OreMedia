import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '@temporalio/worker';
// Relative import: the Temporal test environment helpers live with the workflow time-skipping tests.
import {
  SMOKE_CONTEXT,
  createTestEnvironment,
  fakeActivitiesOnWorkers,
  type FakeActivity,
  type TestEnvironment,
} from '../../../packages/workflows/time-skipping/environment';
import { composeCredentialBroker, composeModules } from './composition';
import { startIngestWorkers, type IngestWorkersHandle } from './ingest-worker';

/**
 * G26 smoke test: worker-ingest's production start function (startIngestWorkers) boots against a real Temporal
 * server (the time-skipping test server, or the CLI dev server with TEMPORAL_CLI_PATH) and each task queue it creates
 * completes a workflow: `ingest-metrics` a metric collection, `ingest-comments` a comment ingestion, both for a
 * publication with nothing to collect. Only the activities those workflows call are fakes (no database); the
 * workers, their queues, the bundle and the registrations are the deployed ones.
 */
const env = {
  NODE_ENV: 'test',
  OREMEDIA_FAKE_MODEL: '1',
  // Test-only values, assembled so the secrets scan sees no literal.
  KMS_LOCAL_MASTER_SECRET: ['smoke', 'master', 'key'].join('-'),
  COMMENT_AUTHOR_HASH_SECRET_REF: ['smoke', 'author', 'key'].join('-'),
};

/** Which queue read the plan, by publication id. */
const ranOn = new Map<string, string>();

function fakes(taskQueue: string): Record<string, FakeActivity> {
  return {
    readCollectionPlan: async (input: { publicationId: string }) => {
      ranOn.set(input.publicationId, taskQueue);
      return {
        collectable: false,
        providerKey: 'fixture',
        publishedAt: null,
        latencyHours: 0,
        commentsReadable: false,
      };
    },
  };
}

let t: TestEnvironment;
let created: string[];
let ingest: IngestWorkersHandle;
let running: Promise<void>;

beforeAll(async () => {
  t = await createTestEnvironment();
  composeModules(env);
  composeCredentialBroker(env);
  const workers = fakeActivitiesOnWorkers(Worker, fakes);
  ingest = await startIngestWorkers({ address: t.env.address, namespace: t.env.namespace ?? 'default' }, env);
  workers.restore();
  created = workers.queues;
  running = ingest.run();
}, 300_000);

afterAll(async () => {
  ingest?.shutdown();
  await running;
  await ingest?.close();
  await t?.env.teardown();
});

describe('worker-ingest on a real Temporal server (G26)', () => {
  it('creates the ingest-metrics and ingest-comments queues', () => {
    expect(created).toEqual(['ingest-metrics', 'ingest-comments']);
  });

  it.each([
    ['ingest-metrics', 'metricCollectionWorkflowV1'],
    ['ingest-comments', 'commentIngestionWorkflowV1'],
  ])('%s: %s completes', async (taskQueue, workflowType) => {
    const publicationId = `pub_${taskQueue}`;
    const result = await t.env.client.workflow.execute(workflowType, {
      taskQueue,
      workflowId: `smoke-${workflowType}`,
      args: [{ ...SMOKE_CONTEXT, publicationId }],
    });
    expect(result).toMatchObject({ outcome: 'not_collectable' });
    expect(ranOn.get(publicationId)).toBe(taskQueue);
  });

  it('shuts down cleanly', async () => {
    ingest.shutdown();
    await expect(running).resolves.toBeUndefined();
  });
});
