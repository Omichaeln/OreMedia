import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NativeConnection,
  Worker,
  type NativeConnectionOptions,
  type WorkerOptions,
} from '@temporalio/worker';
import {
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  WorkflowNotFoundError,
  type Client,
} from '@temporalio/client';
import {
  createBrandChangeImpactActivities,
  createCommunityReplyControlActivities,
  createCommunityReplyProviderActivities,
  createConnectChoicePurgeActivities,
  createDestinationRefreshActivities,
  createPublicationSweepActivities,
  createPublishControlActivities,
  createPublishProviderActivities,
  createRemoteChangeControlActivities,
  createRemoteChangeProviderActivities,
  createRemoteChangeSweepActivities,
  createTokenRefreshActivities,
} from '@oremedia/activities';
import {
  CONNECT_CHOICE_PURGE_SCHEDULE_ID,
  CONNECT_CHOICE_PURGE_WORKFLOW_TYPE,
  CORE_TASK_QUEUE,
  PUBLICATION_SWEEPER_WORKFLOW_ID,
  PUBLICATION_SWEEPER_WORKFLOW_TYPE,
  REMOTE_CHANGE_SWEEP_SCHEDULE_ID,
  REMOTE_CHANGE_SWEEP_WORKFLOW_TYPE,
  configureCredentialBroker,
  createKmsFromEnv,
  createPublishingRuntime,
  publishTaskQueue,
  type WorkflowProbe,
} from '@oremedia/module-publishing';
import { createCommunityReplyRuntime } from '@oremedia/module-community';
import {
  DESTINATION_TOKEN_REFRESH_SCHEDULE_ID,
  DESTINATION_TOKEN_REFRESH_WORKFLOW_TYPE,
  createDestinationRuntime,
} from '@oremedia/module-destinations';
import { logger } from '@oremedia/observability';
import { providerRegistry } from '@oremedia/providers';
import { createBrandChangeImpactRuntime } from './brand-change-runtime';
import { intelligenceActivities } from './intelligence-worker';
import { operationsActivities } from './operations-worker';
import type { TemporalConfig } from './temporal';

/**
 * Spec 4.4: worker-core hosts task queue `core` (publicationWorkflowV1, its reconcile and signal relay, the remote
 * edit and delete workflows, the sweeper, tokenRefreshWorkflowV1, brandChangeImpactWorkflowV1 and
 * communityReplyWorkflowV1) and one activity-only `publish-<providerKey>` queue per registered provider (publishing,
 * remote edits and deletes, and comment replies),
 * so a slow or rate-limited platform cannot starve the others. This is the only process (with worker-ingest)
 * whose KMS may decrypt: the credential broker is composed here with a decrypting key (spec 14.7). Workflow code
 * is pre-bundled at build time (tsup.config.ts → dist/workflows.core.js), as the agents queue is.
 */
const here = dirname(fileURLToPath(import.meta.url));

function workflowsFor(
  queue: string,
  production: boolean,
): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const codePath = join(here, `workflows.${queue}.js`);
  if (existsSync(codePath)) return { workflowBundle: { codePath } };
  if (production)
    throw new Error(
      `workflow bundle ${codePath} is missing: build the worker (pnpm --filter @oremedia/worker-core build)`,
    );
  return { workflowsPath: createRequire(import.meta.url).resolve(`@oremedia/workflows/queues/${queue}`) };
}

async function connectionOptions(cfg: TemporalConfig): Promise<NativeConnectionOptions> {
  const options: NativeConnectionOptions = { address: cfg.address };
  if (cfg.tlsCertPath && cfg.tlsKeyPath)
    options.tls = {
      clientCertPair: { crt: await readFile(cfg.tlsCertPath), key: await readFile(cfg.tlsKeyPath) },
    };
  else if (cfg.apiKey || cfg.tls) options.tls = true;
  if (cfg.apiKey) options.apiKey = cfg.apiKey;
  return options;
}

export interface PublishingWorkersHandle {
  run(): Promise<void>;
  shutdown(): void;
  close(): Promise<void>;
}

export async function startPublishingWorkers(
  cfg: TemporalConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublishingWorkersHandle> {
  const production = (env['NODE_ENV'] ?? 'development') === 'production';
  configureCredentialBroker({ kms: createKmsFromEnv({ decrypt: true }, env) }); // loud without a key
  const runtime = createPublishingRuntime();
  const replies = createCommunityReplyRuntime();
  const connection = await NativeConnection.connect(await connectionOptions(cfg));
  const core = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: CORE_TASK_QUEUE,
    ...workflowsFor(CORE_TASK_QUEUE, production),
    activities: {
      ...createPublishControlActivities(runtime.control),
      // publicationRemoteEditWorkflowV1 / publicationRemoteDeleteWorkflowV1 record their outcome here
      ...createRemoteChangeControlActivities(runtime.remoteChangeControl),
      ...createRemoteChangeSweepActivities(runtime.remoteChangeSweep),
      ...createTokenRefreshActivities(runtime.tokenRefresh),
      ...createPublicationSweepActivities(runtime.sweep),
      ...createConnectChoicePurgeActivities(runtime.connectChoicePurge),
      // destinationTokenRefreshWorkflowV1 (ledger R2-1): the daily refresh of brand destinations' source grants
      ...createDestinationRefreshActivities(createDestinationRuntime().refresh),
      // brand.version_published / brand.fact_revoked → brandChangeImpactWorkflowV1 (spec 8.2)
      ...createBrandChangeImpactActivities(createBrandChangeImpactRuntime()),
      // brandAnalystWorkflowV1 / brandAnalystSweepWorkflowV1 / baselineComparisonWorkflowV1 (spec 16.3, 16.8)
      ...intelligenceActivities(),
      // deletionRequestWorkflowV1 / retentionSweepWorkflowV1 (spec 17.5)
      ...operationsActivities(),
      // communityReplyWorkflowV1 (comment inbox): the route and the recorded outcome
      ...createCommunityReplyControlActivities(replies),
    },
    maxConcurrentActivityTaskExecutions: Number(env['CORE_CONCURRENCY'] ?? 16),
  });
  // One activity-only worker per certified provider; the per-queue cap is the fairness bound (spec 17.4).
  const providers = providerRegistry.list().filter((p) => p.certified);
  const publishWorkers = await Promise.all(
    providers.map((p) =>
      Worker.create({
        connection,
        namespace: cfg.namespace,
        taskQueue: publishTaskQueue(p.key),
        activities: {
          ...createPublishProviderActivities(runtime.provider),
          ...createRemoteChangeProviderActivities(runtime.remoteChangeProvider),
          // A comment reply is sent where the channel's credentials open, beside publishOnce.
          ...createCommunityReplyProviderActivities(replies),
        },
        maxConcurrentActivityTaskExecutions: Number(env['PUBLISH_CONCURRENCY'] ?? 4),
      }),
    ),
  );
  logger().info(
    { status: providers.map((p) => p.key).join(',') || 'none' },
    'worker-core polling task queue core and publish-<provider> queues',
  );
  const workers = [core, ...publishWorkers];
  return {
    run: async () => {
      await Promise.all(workers.map((w) => w.run()));
    },
    // The SDK already drains on SIGTERM/SIGINT; shutdown() on a worker that is not RUNNING throws IllegalStateError.
    shutdown: () => workers.forEach((w) => w.getState() === 'RUNNING' && w.shutdown()),
    close: () => connection.close(),
  };
}

/** The always-on sweeper: one execution per namespace, joined if it already runs (USE_EXISTING). */
export async function ensureSweeperRunning(client: Client): Promise<void> {
  await client.workflow.start(PUBLICATION_SWEEPER_WORKFLOW_TYPE, {
    taskQueue: CORE_TASK_QUEUE,
    workflowId: PUBLICATION_SWEEPER_WORKFLOW_ID,
    args: [{}],
    workflowIdConflictPolicy: 'USE_EXISTING',
    workflowIdReusePolicy: 'ALLOW_DUPLICATE',
  });
}

/** Spec 14.7: every 15 minutes, expired account choices are shredded and deleted (it always applies). */
export const CONNECT_CHOICE_PURGE_INTERVAL = '15 minutes';

/** The connect-choice purge schedule: created once per namespace, joined when it already exists. */
export async function ensureConnectChoicePurgeScheduleRunning(client: Client): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: CONNECT_CHOICE_PURGE_SCHEDULE_ID,
      spec: { intervals: [{ every: CONNECT_CHOICE_PURGE_INTERVAL }] },
      action: {
        type: 'startWorkflow',
        workflowType: CONNECT_CHOICE_PURGE_WORKFLOW_TYPE,
        taskQueue: CORE_TASK_QUEUE,
        args: [{}],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour' },
    });
    logger().info({ status: CONNECT_CHOICE_PURGE_SCHEDULE_ID }, 'schedule created');
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) return; // one per namespace; joined
    throw err;
  }
}

/** Daily at 03:10 UTC, after the retention sweep and outside the top-of-hour publishing burst. */
export const DESTINATION_TOKEN_REFRESH_CALENDAR = { hour: 3, minute: 10 } as const;

/**
 * Ledger R2-1: destinationTokenRefreshWorkflowV1 once a day (one schedule per namespace, joined if it exists): every
 * active destination whose source token expires within the next day is refreshed; a revoked grant leaves it
 * unreachable until a person connects it again.
 */
export async function ensureDestinationTokenRefreshScheduled(client: Client): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: DESTINATION_TOKEN_REFRESH_SCHEDULE_ID,
      spec: { calendars: [{ ...DESTINATION_TOKEN_REFRESH_CALENDAR }] },
      action: {
        type: 'startWorkflow',
        workflowType: DESTINATION_TOKEN_REFRESH_WORKFLOW_TYPE,
        taskQueue: CORE_TASK_QUEUE,
        args: [{}],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 day' },
    });
    logger().info({ status: DESTINATION_TOKEN_REFRESH_SCHEDULE_ID }, 'schedule created');
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) return; // one per namespace; joined
    throw err;
  }
}

/**
 * remoteChangeSweepWorkflowV1 every hour (one schedule per namespace, joined if it exists): a remote edit or delete
 * whose workflow was lost is closed after the stale threshold, so the post can be changed again.
 */
export async function ensureRemoteChangeSweepScheduled(client: Client): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: REMOTE_CHANGE_SWEEP_SCHEDULE_ID,
      spec: { intervals: [{ every: '1 hour' }] },
      action: {
        type: 'startWorkflow',
        workflowType: REMOTE_CHANGE_SWEEP_WORKFLOW_TYPE,
        taskQueue: CORE_TASK_QUEUE,
        args: [],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour' },
    });
    logger().info({ status: REMOTE_CHANGE_SWEEP_SCHEDULE_ID }, 'schedule created');
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) return; // one per namespace; joined
    throw err;
  }
}

/**
 * The sweeper's probe: is a workflow execution running right now? An unknown id is not running; any other failure
 * (Temporal unreachable, timeout) is treated as running, so an outage never makes the sweeper declare worker loss.
 */
export class TemporalWorkflowProbe implements WorkflowProbe {
  constructor(private readonly client: Pick<Client, 'workflow'>) {}
  async isRunning(workflowId: string): Promise<boolean> {
    try {
      const d = await this.client.workflow.getHandle(workflowId).describe();
      return d.status.name === 'RUNNING';
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return false;
      logger().warn(
        {
          workflowId,
          errorName: (err as Error)?.name,
          errorCode: (err as { code?: string | number })?.code,
        },
        'workflow probe failed; treating the workflow as running',
      );
      return true;
    }
  }
}
