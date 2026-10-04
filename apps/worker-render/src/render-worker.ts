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
  createBrandSourceExtractActivities,
  createRenderJobActivities,
  createVideoExportActivities,
  createVideoIngestActivities,
  createVideoRenderActivities,
} from '@oremedia/activities';
import { createBrandAssistRuntime } from '@oremedia/module-brand';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import { mediaToolsAvailable, storage } from '@oremedia/module-assets';
import { logger } from '@oremedia/observability';
import { createChromiumRenderer } from './chromium-renderer';
import { creativeRenderJobStore } from './creative-store';

/**
 * worker-render (spec 4.4, 11.5): the isolated worker pool for CPU/memory-heavy and untrusted-input work. Three
 * Temporal workers share one connection: task queue `render` (renderJobWorkflowV1: headless Chromium), task
 * queue `media` (assetIngestWorkflowV1: sniffing, scanning, sanitising and derivatives of uploads; BSC-4 document
 * text extraction for brand assist jobs) and, STU-2a, task queue `video` (videoIngestWorkflowV1, the video export
 * store and STU-2b's videoRenderJobWorkflowV1 timeline renders: ffprobe/ffmpeg jobs that run for minutes, with
 * their own concurrency, VIDEO_CONCURRENCY, so they never starve still renders or image ingest). No credential
 * broker access; egress is restricted to the object store at the network layer. Workflow code is pre-bundled at build time (tsup.config.ts → dist/workflows.<queue>.js)
 * because production images carry no sources. The process (database, object store, health) is worker.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** The pre-built bundle next to this file; outside production the queue entry is bundled at start instead. */
function workflowsFor(
  queue: 'render' | 'media' | 'video',
  production: boolean,
): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const codePath = join(here, `workflows.${queue}.js`);
  if (existsSync(codePath)) return { workflowBundle: { codePath } };
  if (production)
    throw new Error(
      `workflow bundle ${codePath} is missing: build the worker (pnpm --filter @oremedia/worker-render build)`,
    );
  return { workflowsPath: createRequire(import.meta.url).resolve(`@oremedia/workflows/queues/${queue}`) };
}

/** Temporal Cloud: mTLS client certificate files or an API key; self-hosted: plain address (Appendix A). */
async function connectionOptions(env: NodeJS.ProcessEnv): Promise<NativeConnectionOptions> {
  const options: NativeConnectionOptions = { address: env['TEMPORAL_ADDRESS'] as string };
  const certPath = env['TEMPORAL_TLS_CERT_REF'];
  const keyPath = env['TEMPORAL_TLS_KEY_REF'];
  if (certPath && keyPath)
    options.tls = { clientCertPair: { crt: await readFile(certPath), key: await readFile(keyPath) } };
  else if (env['TEMPORAL_TLS'] === '1') options.tls = true;
  const apiKey = env['TEMPORAL_API_KEY'];
  if (apiKey) options.apiKey = apiKey;
  return options;
}

export interface RenderWorkersHandle {
  /** The task queues this process polls (`video` only where ffmpeg/ffprobe are present). */
  queues: string[];
  run(): Promise<void>;
  shutdown(): void;
  close(): Promise<void>;
}

/** Starts the render, media and video workers on one connection; the object store must be configured first. */
export async function startRenderWorkers(env: NodeJS.ProcessEnv = process.env): Promise<RenderWorkersHandle> {
  const production = (env['NODE_ENV'] ?? 'development') === 'production';
  const namespace = env['TEMPORAL_NAMESPACE'] ?? 'default';
  const connection = await NativeConnection.connect(await connectionOptions(env));
  const renderer = createChromiumRenderer({
    ...(env['OREMEDIA_CHROMIUM_PATH'] ? { executablePath: env['OREMEDIA_CHROMIUM_PATH'] } : {}),
    ...(env['RENDER_TIMEOUT_MS'] ? { timeoutMs: Number(env['RENDER_TIMEOUT_MS']) } : {}),
  });

  const renderWorker = await Worker.create({
    connection,
    namespace,
    taskQueue: 'render',
    ...workflowsFor('render', production),
    activities: createRenderJobActivities({
      store: creativeRenderJobStore(),
      renderer,
      rendererVersion: RENDERER_VERSION,
      storage: storage(),
    }),
    // Each render holds a browser context and a decoded page: bounded per container (spec 11.5 per-job limits).
    maxConcurrentActivityTaskExecutions: Number(env['RENDER_CONCURRENCY'] ?? 2),
  });
  const mediaWorker = await Worker.create({
    connection,
    namespace,
    taskQueue: 'media',
    ...workflowsFor('media', production),
    activities: {
      ...createAssetIngestActivities({ storage: storage() }),
      // BSC-4: the text of documents supplied to brand assist jobs, read with the other untrusted-input parsers.
      ...createBrandSourceExtractActivities(
        createBrandAssistRuntime({
          objects: {
            head: (key) => storage().headObject(key),
            get: (key, range) => storage().getObject(key, range),
            delete: (key) => storage().deleteObject(key),
          },
        }),
      ),
    },
    maxConcurrentActivityTaskExecutions: Number(env['MEDIA_CONCURRENCY'] ?? 4),
  });
  // Each video job holds a source of up to 1 GiB on temp disk and runs one ffmpeg at a time (two decoder threads).
  // The render image carries ffmpeg/ffprobe: in production a container without them refuses to start (a broken
  // image must fail its deploy, not leave video uploads waiting). Elsewhere `video` is simply not polled, and the log
  // says so.
  const mediaTools = await mediaToolsAvailable();
  if (!mediaTools && production)
    throw new Error('ffmpeg/ffprobe not found in the image: refusing to start (task queue video)');
  const videoWorker = mediaTools
    ? await Worker.create({
        connection,
        namespace,
        taskQueue: 'video',
        ...workflowsFor('video', production),
        activities: {
          ...createVideoIngestActivities({
            storage: storage(),
            ...(env['MEDIA_TMP_MAX_BYTES'] ? { tmpMaxBytes: Number(env['MEDIA_TMP_MAX_BYTES']) } : {}),
            ...(env['MEDIA_PROXY_TIMEOUT_MS']
              ? { proxyTimeoutMs: Number(env['MEDIA_PROXY_TIMEOUT_MS']) }
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
            ...(env['MEDIA_TMP_MAX_BYTES'] ? { tmpMaxBytes: Number(env['MEDIA_TMP_MAX_BYTES']) } : {}),
            encoder: { threads: Number(env['VIDEO_FFMPEG_THREADS'] ?? 2) },
          }),
        },
        maxConcurrentActivityTaskExecutions: Number(env['VIDEO_CONCURRENCY'] ?? 1),
      })
    : null;
  if (!videoWorker)
    logger().error({ queue: 'video' }, 'ffmpeg/ffprobe not found: task queue video is not polled');
  const queues = ['render', 'media', ...(videoWorker ? ['video'] : [])];
  logger().info(
    { status: RENDERER_VERSION, queue: queues.join(',') },
    `worker-render polling task queues ${queues.join(', ')}`,
  );
  const workers = [renderWorker, mediaWorker, ...(videoWorker ? [videoWorker] : [])];
  return {
    queues,
    run: async () => {
      await Promise.all(workers.map((w) => w.run()));
    },
    // The SDK already drains on SIGTERM/SIGINT; shutdown() on a worker that is not RUNNING throws IllegalStateError.
    shutdown: () => workers.forEach((w) => w.getState() === 'RUNNING' && w.shutdown()),
    close: async () => {
      await renderer.close();
      await connection.close();
    },
  };
}
