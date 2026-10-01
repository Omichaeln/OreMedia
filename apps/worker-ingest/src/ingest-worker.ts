import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
import { ScheduleAlreadyRunning, ScheduleOverlapPolicy, type Client } from '@temporalio/client';
import {
  createCommentIngestionActivities,
  createDestinationReportActivities,
  createMetricCollectionActivities,
  createSeoAuditActivities,
} from '@oremedia/activities';
import {
  DESTINATION_REPORT_SWEEP_SCHEDULE_ID,
  DESTINATION_REPORT_SWEEP_WORKFLOW_TYPE,
  SEO_AUDIT_SWEEP_SCHEDULE_ID,
  SEO_AUDIT_SWEEP_WORKFLOW_TYPE,
  createDestinationRuntime,
} from '@oremedia/module-destinations';
import {
  INGEST_COMMENTS_TASK_QUEUE,
  INGEST_METRICS_TASK_QUEUE,
  createCommentIngestionRuntime,
  createMetricCollectionRuntime,
} from '@oremedia/module-measurement';
import { logger } from '@oremedia/observability';
import { connectionOptions, type TemporalConfig } from './temporal';

/**
 * Spec 4.4: worker-ingest hosts task queues `ingest-metrics` (metricCollectionWorkflowV1 and, ledger R2-1 part B,
 * destinationReportSweepWorkflowV1 with its per-destination children) and `ingest-comments`
 * (commentIngestionWorkflowV1); `listening` and `crm` arrive with Release 2. Both queues serve the same
 * pre-bundled workflow code (tsup.config.ts → dist/workflows.ingest.js), one Worker each so a slow comment pull
 * cannot hold back metric pulls and neither can starve publishing (its own process and queues).
 */
const here = dirname(fileURLToPath(import.meta.url));
const INGEST_BUNDLE = 'ingest';

function workflowsFor(production: boolean): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const codePath = join(here, `workflows.${INGEST_BUNDLE}.js`);
  if (existsSync(codePath)) return { workflowBundle: { codePath } };
  if (production)
    throw new Error(
      `workflow bundle ${codePath} is missing: build the worker (pnpm --filter @oremedia/worker-ingest build)`,
    );
  return {
    workflowsPath: createRequire(import.meta.url).resolve(`@oremedia/workflows/queues/${INGEST_BUNDLE}`),
  };
}

export interface IngestWorkersHandle {
  run(): Promise<void>;
  shutdown(): void;
  close(): Promise<void>;
}

export async function startIngestWorkers(
  cfg: TemporalConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IngestWorkersHandle> {
  const production = (env['NODE_ENV'] ?? 'development') === 'production';
  const connection = await NativeConnection.connect(await connectionOptions(cfg));
  const workflows = workflowsFor(production);
  const destinationRuntime = createDestinationRuntime();
  const metrics = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: INGEST_METRICS_TASK_QUEUE,
    ...workflows,
    activities: {
      ...createMetricCollectionActivities(createMetricCollectionRuntime()),
      ...createDestinationReportActivities(destinationRuntime.reports),
      ...createSeoAuditActivities(destinationRuntime.audit),
    },
    maxConcurrentActivityTaskExecutions: Number(env['INGEST_METRICS_CONCURRENCY'] ?? 8),
  });
  const comments = await Worker.create({
    connection,
    namespace: cfg.namespace,
    taskQueue: INGEST_COMMENTS_TASK_QUEUE,
    ...workflows,
    activities: createCommentIngestionActivities(createCommentIngestionRuntime()),
    maxConcurrentActivityTaskExecutions: Number(env['INGEST_COMMENTS_CONCURRENCY'] ?? 4),
  });
  logger().info(
    { status: `${INGEST_METRICS_TASK_QUEUE},${INGEST_COMMENTS_TASK_QUEUE}` },
    'worker-ingest polling task queues ingest-metrics and ingest-comments',
  );
  const workers = [metrics, comments];
  return {
    run: async () => {
      await Promise.all(workers.map((w) => w.run()));
    },
    // The SDK already drains on SIGTERM/SIGINT; shutdown() on a worker that is not RUNNING throws IllegalStateError.
    shutdown: () => workers.forEach((w) => w.getState() === 'RUNNING' && w.shutdown()),
    close: () => connection.close(),
  };
}

/** Daily at 04:00 UTC, after the token refresh (03:10) renewed the grants the reads use. */
export const DESTINATION_REPORT_SWEEP_CALENDAR = { hour: 4, minute: 0 } as const;

/**
 * Ledger R2-1 part B: destinationReportSweepWorkflowV1 once a day on `ingest-metrics` (one schedule per namespace,
 * joined if it exists; copied from worker-core's ensureDestinationTokenRefreshScheduled): every active GA4 and
 * Search Console destination reads its reports incrementally under the source-use policy.
 */
export async function ensureDestinationReportSweepScheduled(client: Client): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: DESTINATION_REPORT_SWEEP_SCHEDULE_ID,
      spec: { calendars: [{ ...DESTINATION_REPORT_SWEEP_CALENDAR }] },
      action: {
        type: 'startWorkflow',
        workflowType: DESTINATION_REPORT_SWEEP_WORKFLOW_TYPE,
        taskQueue: INGEST_METRICS_TASK_QUEUE,
        args: [{}],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 day' },
    });
    logger().info({ status: DESTINATION_REPORT_SWEEP_SCHEDULE_ID }, 'schedule created');
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) return; // one per namespace; joined
    throw err;
  }
}

/** Weekly, Mondays 05:00 UTC, after the report sweep (04:00) so the two never share the queue's capacity. */
export const SEO_AUDIT_SWEEP_CALENDAR = { dayOfWeek: 'MONDAY', hour: 5, minute: 0 } as const;

/**
 * Ledger R2-4: seoAuditSweepWorkflowV1 once a week on `ingest-metrics` (one schedule per namespace, joined if it
 * exists; as ensureDestinationReportSweepScheduled): every active website destination whose `cms.audit` policy
 * allows reads gets one bounded crawl, overlap skipped.
 */
export async function ensureSeoAuditSweepScheduled(client: Client): Promise<void> {
  try {
    await client.schedule.create({
      scheduleId: SEO_AUDIT_SWEEP_SCHEDULE_ID,
      spec: { calendars: [{ ...SEO_AUDIT_SWEEP_CALENDAR }] },
      action: {
        type: 'startWorkflow',
        workflowType: SEO_AUDIT_SWEEP_WORKFLOW_TYPE,
        taskQueue: INGEST_METRICS_TASK_QUEUE,
        args: [{}],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 day' },
    });
    logger().info({ status: SEO_AUDIT_SWEEP_SCHEDULE_ID }, 'schedule created');
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) return; // one per namespace; joined
    throw err;
  }
}
