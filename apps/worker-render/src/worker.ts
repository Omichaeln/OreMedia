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
  createAssetIngestActivities,
  createRenderJobActivities,
  createVideoExportActivities,
  createVideoIngestActivities,
  createVideoRenderActivities,
} from '@oremedia/activities';
import { closeDatabase, configureDatabase } from '@oremedia/db';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import {
  configureStorage,
  createStorageFromEnv,
  mediaToolsAvailable,
  storage,
  sweepStaleTempDirs,
  uploadsCapability,
} from '@oremedia/module-assets';
import { Runtime } from '@temporalio/worker';
import {
  reportConfiguration,
  sdkLogger,
  startHealthServer,
  startTelemetry,
  stopTelemetry,
} from '@oremedia/observability';
import { createChromiumRenderer } from './chromium-renderer';
import { creativeRenderJobStore } from './creative-store';

/**
 * worker-render (spec 4.4, 11.5): the isolated worker pool for CPU/memory-heavy and untrusted-input work. Three
 * Temporal workers share one connection: task queue `render` (renderJobWorkflowV1: headless Chromium), task
 * queue `media` (assetIngestWorkflowV1: sniffing, scanning, sanitising and derivatives of uploads) and, STU-2a, task
 * queue `video` (videoIngestWorkflowV1 and the video export store: ffprobe/ffmpeg jobs that run for minutes, with
 * their own concurrency, VIDEO_CONCURRENCY, so they never starve still renders or image ingest). No credential
 * broker access; egress is restricted to the object store at the network layer. Workflow code is pre-bundled at
 * build time (tsup.config.ts → dist/workflows.<queue>.js) because production images carry no sources. The process
 * entry is main.ts, which checks the configuration before this module (and its dependencies) load.
 */
const log = startTelemetry({ service: 'oremedia-worker-render', version: process.env['OREMEDIA_VERSION'] });
// Temporal's own logs through the service logger (stdout, their real level), before any connection or worker.
Runtime.install({ logger: sdkLogger(log.child('temporal')) });
// main.ts already refused to start without these; the checks stay here so this module is safe to run directly.
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  log.error({}, 'DATABASE_URL is required');
  process.exit(2);
}
const temporalAddress = process.env['TEMPORAL_ADDRESS'];
if (!temporalAddress) {
  log.error({}, 'TEMPORAL_ADDRESS is required');
  process.exit(2);
}
// One line naming each degraded capability and the settings it lacks (names only), before the store is configured
// (which still refuses a production start without buckets and endpoint); OREMEDIA_CONFIG_STRICT=1 refuses any gap.
const config = reportConfiguration(log, [uploadsCapability]);
if (config.refuse) process.exit(2);
configureDatabase({ url: databaseUrl, connectionLimit: Number(process.env['DATABASE_POOL'] ?? 4) });
configureStorage(createStorageFromEnv());

const here = dirname(fileURLToPath(import.meta.url));
const production = (process.env['NODE_ENV'] ?? 'development') === 'production';

/** The pre-built bundle next to this file; outside production the queue entry is bundled at start instead. */
function workflowsFor(
  queue: 'render' | 'media' | 'video',
): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const codePath = join(here, `workflows.${queue}.js`);
  if (existsSync(codePath)) return { workflowBundle: { codePath } };
  if (production) {
    log.error(
      { codePath },
      'workflow bundle missing: build the worker (pnpm --filter @oremedia/worker-render build)',
    );
    process.exit(2);
  }
  return { workflowsPath: createRequire(import.meta.url).resolve(`@oremedia/workflows/queues/${queue}`) };
}

/** Temporal Cloud: mTLS client certificate files or an API key; self-hosted: plain address (Appendix A). */
async function connectionOptions(): Promise<NativeConnectionOptions> {
  const options: NativeConnectionOptions = { address: temporalAddress as string };
  const certPath = process.env['TEMPORAL_TLS_CERT_REF'];
  const keyPath = process.env['TEMPORAL_TLS_KEY_REF'];
  if (certPath && keyPath)
    options.tls = { clientCertPair: { crt: await readFile(certPath), key: await readFile(keyPath) } };
  else if (process.env['TEMPORAL_TLS'] === '1') options.tls = true;
  const apiKey = process.env['TEMPORAL_API_KEY'];
  if (apiKey) options.apiKey = apiKey;
  return options;
}

const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default';
const connection = await NativeConnection.connect(await connectionOptions());
const renderer = createChromiumRenderer({
  ...(process.env['OREMEDIA_CHROMIUM_PATH'] ? { executablePath: process.env['OREMEDIA_CHROMIUM_PATH'] } : {}),
  ...(process.env['RENDER_TIMEOUT_MS'] ? { timeoutMs: Number(process.env['RENDER_TIMEOUT_MS']) } : {}),
});

const renderWorker = await Worker.create({
  connection,
  namespace,
  taskQueue: 'render',
  ...workflowsFor('render'),
  activities: createRenderJobActivities({
    store: creativeRenderJobStore(),
    renderer,
    rendererVersion: RENDERER_VERSION,
    storage: storage(),
  }),
  // Each render holds a browser context and a decoded page: bounded per container (spec 11.5 per-job limits).
  maxConcurrentActivityTaskExecutions: Number(process.env['RENDER_CONCURRENCY'] ?? 2),
});
const mediaWorker = await Worker.create({
  connection,
  namespace,
  taskQueue: 'media',
  ...workflowsFor('media'),
  activities: createAssetIngestActivities({ storage: storage() }),
  maxConcurrentActivityTaskExecutions: Number(process.env['MEDIA_CONCURRENCY'] ?? 4),
});
// Media jobs work in private temp directories (MEDIA_TMP_DIR); a container killed mid-job leaves them behind.
const swept = await sweepStaleTempDirs({ olderThanMs: 6 * 3_600_000 });
if (swept > 0) log.info({ count: swept }, 'removed stale media temp directories');
// Each video job holds a source of up to 1 GiB on temp disk and runs one ffmpeg at a time (two decoder threads).
// The render image carries ffmpeg/ffprobe: in production a container without them refuses to start (a broken image
// must fail its deploy, not leave video uploads waiting). Elsewhere `video` is simply not polled, and the log says so.
const mediaTools = await mediaToolsAvailable();
if (!mediaTools && production) {
  log.error(
    { queue: 'video' },
    'ffmpeg/ffprobe not found in the image: refusing to start (task queue video)',
  );
  process.exit(2);
}
const videoWorker = mediaTools
  ? await Worker.create({
      connection,
      namespace,
      taskQueue: 'video',
      ...workflowsFor('video'),
      activities: {
        ...createVideoIngestActivities({
          storage: storage(),
          ...(process.env['MEDIA_TMP_MAX_BYTES']
            ? { tmpMaxBytes: Number(process.env['MEDIA_TMP_MAX_BYTES']) }
            : {}),
          ...(process.env['MEDIA_PROXY_TIMEOUT_MS']
            ? { proxyTimeoutMs: Number(process.env['MEDIA_PROXY_TIMEOUT_MS']) }
            : {}),
        }),
        ...createVideoExportActivities({ storage: storage() }),
        // STU-2b: timeline renders (videoRenderJobWorkflowV1): overlays through the same Chromium renderer as
        // stills, composition and encoding with ffmpeg (VIDEO_FFMPEG_THREADS threads, default 2).
        ...createVideoRenderActivities({
          store: creativeRenderJobStore(),
          overlays: renderer,
          rendererVersion: RENDERER_VERSION,
          storage: storage(),
          ...(process.env['MEDIA_TMP_MAX_BYTES']
            ? { tmpMaxBytes: Number(process.env['MEDIA_TMP_MAX_BYTES']) }
            : {}),
          encoder: { threads: Number(process.env['VIDEO_FFMPEG_THREADS'] ?? 2) },
        }),
      },
      maxConcurrentActivityTaskExecutions: Number(process.env['VIDEO_CONCURRENCY'] ?? 1),
    })
  : null;
if (!videoWorker) log.error({ queue: 'video' }, 'ffmpeg/ffprobe not found: task queue video is not polled');
const polled = ['render', 'media', ...(videoWorker ? ['video'] : [])];
log.info(
  { status: RENDERER_VERSION, queue: polled.join(',') },
  `worker-render polling task queues ${polled.join(', ')}`,
);
// Answer the platform health check only now that both workers were created (a failed start throws above).
const health = await startHealthServer(undefined, config.degraded);

const shutdown = () => {
  log.info({}, 'worker-render shutting down');
  // The SDK already drains on SIGTERM/SIGINT; shutdown() on a worker that is not RUNNING throws IllegalStateError.
  for (const w of [renderWorker, mediaWorker, videoWorker]) if (w && w.getState() === 'RUNNING') w.shutdown();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  await Promise.all([renderWorker.run(), mediaWorker.run(), ...(videoWorker ? [videoWorker.run()] : [])]);
} finally {
  await health.close();
  await renderer.close();
  await connection.close();
  await closeDatabase();
  await stopTelemetry();
}
