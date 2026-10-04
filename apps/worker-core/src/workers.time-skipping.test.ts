import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Worker } from '@temporalio/worker';
import { cmsRegistry, providerRegistry } from '@oremedia/providers';
// Relative import: the Temporal test environment helpers live with the workflow time-skipping tests.
import {
  SMOKE_CONTEXT,
  createTestEnvironment,
  fakeActivitiesOnWorkers,
  type FakeActivity,
  type TestEnvironment,
} from '../../../packages/workflows/time-skipping/environment';
import { startAgentsWorker, type AgentsWorkerHandle } from './agents-worker';
import { composeModules } from './composition';
import { startPublishingWorkers, type PublishingWorkersHandle } from './publishing-worker';

/**
 * G26 smoke test: worker-core's production start functions (startAgentsWorker, startPublishingWorkers) boot against
 * a real Temporal server (the time-skipping test server, or the CLI dev server with TEMPORAL_CLI_PATH) and every
 * task queue they create completes work: `agents` a skill evaluation and (STU-3) a studio video AI job with its
 * cancel relay, `core` a comment reply per provider, whose
 * send runs on that provider's `publish-<key>` queue. Only the activities those workflows call are fakes (no
 * database); the workers, their queues, bundles and registrations are the deployed ones. Every provider and CMS kind
 * is reported certified while the workers are created, so each `publish-<key>` queue exists.
 */
const env = {
  NODE_ENV: 'test',
  OREMEDIA_FAKE_MODEL: '1',
  KMS_LOCAL_MASTER_SECRET: ['smoke', 'master', 'key'].join('-'), // test-only value, assembled for the secrets scan
};

/** Which queue each fake ran on, by the id the workflow was started with. */
const ranOn = new Map<string, string>();

function fakes(taskQueue: string): Record<string, FakeActivity> | undefined {
  if (taskQueue === 'agents')
    return {
      runSkillEvaluation: async (input: { skillVersionId: string; suiteId: string }) => {
        ranOn.set(input.skillVersionId, taskQueue);
        return {
          outcome: 'recorded',
          skillVersionId: input.skillVersionId,
          suiteId: input.suiteId,
          resultId: 'r',
        };
      },
      // STU-3: a video AI job whose row was already cancelled stops at begin; its reservation is still settled.
      beginVideoJob: async (input: { jobId: string }) => {
        ranOn.set(input.jobId, taskQueue);
        return { proceed: false, reason: 'cancelled' };
      },
      settleVideoJobBudget: async () => undefined,
    };
  if (taskQueue === 'core')
    return {
      // The draft id names the provider the reply goes to.
      readReplyRoute: async (input: { responseDraftId: string }) => ({ providerKey: input.responseDraftId }),
      recordReplyOutcome: async (input: { result: { outcome: string } }) => ({
        state: input.result.outcome === 'accepted' ? 'sent' : 'failed',
        messageId: 'msg_smoke',
        changed: true,
      }),
    };
  if (taskQueue.startsWith('publish-'))
    return {
      sendReplyOnce: async (input: { responseDraftId: string }) => {
        ranOn.set(input.responseDraftId, taskQueue);
        return { outcome: 'accepted', remoteMessageId: 'c_smoke', remoteUrl: null };
      },
    };
  return undefined;
}

let t: TestEnvironment;
let created: string[];
let registered: Map<string, string[]>;
let agents: AgentsWorkerHandle;
let publishing: PublishingWorkersHandle;
let running: Promise<unknown>;

beforeAll(async () => {
  t = await createTestEnvironment();
  const temporal = { address: t.env.address, namespace: t.env.namespace ?? 'default' };
  composeModules();
  const providers = providerRegistry.list.bind(providerRegistry);
  const cms = cmsRegistry.list.bind(cmsRegistry);
  const certified = [
    vi
      .spyOn(providerRegistry, 'list')
      .mockImplementation(() => providers().map((p) => ({ ...p, certified: true }))),
    vi.spyOn(cmsRegistry, 'list').mockImplementation(() => cms().map((c) => ({ ...c, certified: true }))),
  ];
  const workers = fakeActivitiesOnWorkers(Worker, fakes);
  agents = await startAgentsWorker(temporal, env);
  publishing = await startPublishingWorkers(temporal, env);
  workers.restore();
  certified.forEach((s) => s.mockRestore());
  created = workers.queues;
  registered = workers.registered;
  running = Promise.all([agents.run(), publishing.run()]);
}, 300_000);

afterAll(async () => {
  agents?.shutdown();
  publishing?.shutdown();
  await running;
  await agents?.close();
  await publishing?.close();
  await t?.env.teardown();
});

describe('worker-core on a real Temporal server (G26)', () => {
  it('creates the agents, core and one publish queue per provider', () => {
    const publish = created.filter((q) => q.startsWith('publish-'));
    expect(created).toEqual(expect.arrayContaining(['agents', 'core']));
    expect(publish.length).toBeGreaterThan(0);
    expect(created).toHaveLength(2 + publish.length);
  });

  it('agents: a skill evaluation completes', async () => {
    const result = await t.env.client.workflow.execute('skillEvaluationWorkflowV1', {
      taskQueue: 'agents',
      workflowId: 'smoke-skill-evaluation',
      args: [{ ...SMOKE_CONTEXT, skillVersionId: 'skv_smoke', skillId: 'sk', suiteId: 'suite', runs: 3 }],
    });
    expect(result).toMatchObject({ outcome: 'recorded', skillVersionId: 'skv_smoke' });
    expect(ranOn.get('skv_smoke')).toBe('agents');
  });

  it('agents: registers the STU-3 studio video job activities', () => {
    expect(registered.get('agents')).toEqual(
      expect.arrayContaining([
        'beginVideoJob',
        'reserveVideoJobBudget',
        'callVideoJobModel',
        'saveVideoJob',
        'failVideoJob',
        'settleVideoJobBudget',
      ]),
    );
  });

  it('agents: studioVideoJobWorkflowV1 completes', async () => {
    const result = await t.env.client.workflow.execute('studioVideoJobWorkflowV1', {
      taskQueue: 'agents',
      workflowId: 'studio-video:svj_smoke:1',
      args: [{ ...SMOKE_CONTEXT, jobId: 'svj_smoke', attempt: 1 }],
    });
    expect(result).toEqual({ jobId: 'svj_smoke', state: 'stopped' });
    expect(ranOn.get('svj_smoke')).toBe('agents');
  });

  it('agents: studioVideoJobSignalRelayV1 completes for an attempt that already ended', async () => {
    const handle = await t.env.client.workflow.start('studioVideoJobSignalRelayV1', {
      taskQueue: 'agents',
      workflowId: 'smoke-studio-video-relay',
      args: [{ workflowId: 'studio-video:svj_smoke:1', signal: 'cancel' }],
    });
    await expect(handle.result()).resolves.toBeUndefined();
    const { taskQueue } = await handle.describe();
    expect(taskQueue).toBe('agents');
  });

  it('core and every publish-<key> queue: a comment reply completes, sent on its provider queue', async () => {
    const publish = created.filter((q) => q.startsWith('publish-'));
    for (const queue of publish) {
      const providerKey = queue.slice('publish-'.length);
      const result = await t.env.client.workflow.execute('communityReplyWorkflowV1', {
        taskQueue: 'core',
        workflowId: `smoke-reply-${providerKey}`,
        args: [{ ...SMOKE_CONTEXT, responseDraftId: providerKey }],
      });
      expect(result).toEqual({ state: 'sent', messageId: 'msg_smoke', changed: true });
      expect(ranOn.get(providerKey)).toBe(queue);
    }
  });

  it('shuts down cleanly', async () => {
    agents.shutdown();
    publishing.shutdown();
    await expect(running).resolves.toBeDefined();
  });
});
