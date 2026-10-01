/**
 * Pre-deploy migration entrypoint (Railway `preDeployCommand`): applies versioned migrations, then exits.
 * Migrations need DDL, which the application role (D-25, roles/app-role.sql) does not hold, so they run on
 * DATABASE_URL_MIGRATE (the admin connection, set on the api service for this step only) when it is set and on
 * DATABASE_URL otherwise (development, and an environment that still runs as root).
 */
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { closeDatabase, runMigrations } from '@oremedia/db';

const log = startTelemetry({ service: 'oremedia-api-migrate' });
const url = process.env['DATABASE_URL_MIGRATE'] ?? process.env['DATABASE_URL'];
if (!url) {
  log.error({}, 'DATABASE_URL is required');
  process.exit(2);
}
try {
  await runMigrations(url);
  log.info({}, 'migrations applied');
} catch (err) {
  log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'migration failed');
  process.exitCode = 1;
} finally {
  await closeDatabase();
  await stopTelemetry();
}
