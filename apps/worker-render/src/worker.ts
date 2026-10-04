import { Runtime } from '@temporalio/worker';
import { closeDatabase, configureDatabase } from '@oremedia/db';
import {
  configureStorage,
  createStorageFromEnv,
  sweepStaleTempDirs,
  uploadsCapability,
} from '@oremedia/module-assets';
import {
  reportConfiguration,
  sdkLogger,
  startHealthServer,
  startTelemetry,
  stopTelemetry,
} from '@oremedia/observability';
import { composeModules } from './composition';
import { startRenderWorkers } from './render-worker';

/**
 * worker-render process (spec 4.4, 11.5): telemetry, the database, the object store and the health check around the
 * render, media and video workers (render-worker.ts). The process entry is main.ts, which checks the configuration
 * before this module (and its dependencies) load.
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
// Architecture §4.4: provider I/O refuses a demo company; unwired, it would refuse every company in production.
composeModules();

// Media jobs work in private temp directories (MEDIA_TMP_DIR); a container killed mid-job leaves them behind.
const swept = await sweepStaleTempDirs({ olderThanMs: 6 * 3_600_000 });
if (swept > 0) log.info({ count: swept }, 'removed stale media temp directories');
let renderWorkers;
try {
  renderWorkers = await startRenderWorkers();
} catch (err) {
  log.error(
    { errorMessage: err instanceof Error ? err.message : String(err) },
    'render workers could not start',
  );
  process.exit(2);
}
// Answer the platform health check only now that the workers were created (a failed start exited above).
const health = await startHealthServer(undefined, config.degraded);

const shutdown = () => {
  log.info({}, 'worker-render shutting down');
  renderWorkers.shutdown();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  await renderWorkers.run();
} finally {
  await health.close();
  await renderWorkers.close();
  await closeDatabase();
  await stopTelemetry();
}
