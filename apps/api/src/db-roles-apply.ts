/**
 * Database-role entrypoint (R1-G, D-25): applies the generated application role (and, when a password is given,
 * the retention role) to the database DATABASE_URL names, then proves the result with the same comparison as
 * `pnpm db:roles:check`. Runs inside the environment as the `db-roles` service (deploy runbook §1 step 5;
 * Railway's MySQL is reachable only on the private network), connected as the MySQL admin; the application
 * services then connect as the role users. Re-run after a migration that adds tables: `applyRoleSql` waits for the
 * tables the role names before it grants, so a push that carries a migration and this service's redeploy together
 * never leaves a table without its grant.
 *
 * Inputs: DATABASE_URL (the admin connection), DB_APP_USER (default `oremedia_app`) with DB_APP_PASSWORD, and
 * optionally DB_RETENTION_USER (default `oremedia_retention`) with DB_RETENTION_PASSWORD. Prints no password and no
 * URL. Exits 1 when a role fails its check, 2 when it cannot run.
 */
import { startTelemetry, stopTelemetry } from '@oremedia/observability';
import { applyRoleSql, generateRetentionRoleSql, generateRoleSql } from '@oremedia/db/roles';

const log = startTelemetry({ service: 'oremedia-api-db-roles-apply' });

/** A variable still carrying an unexpanded `${{ … }}` reference would become the literal password: refuse. */
function resolved(name: string, value: string | undefined): string | undefined {
  if (value !== undefined && /\$\{\{/.test(value))
    throw new Error(`${name} holds an unresolved reference; set it to a generated value`);
  return value;
}

try {
  const adminUrl = process.env['DATABASE_URL'];
  if (!adminUrl) throw new Error('DATABASE_URL is required');
  const appUser = resolved('DB_APP_USER', process.env['DB_APP_USER']) ?? 'oremedia_app';
  const appPassword = resolved('DB_APP_PASSWORD', process.env['DB_APP_PASSWORD']);
  if (!appPassword) throw new Error('DB_APP_PASSWORD is required');
  const retentionUser =
    resolved('DB_RETENTION_USER', process.env['DB_RETENTION_USER']) ?? 'oremedia_retention';
  const retentionPassword = resolved('DB_RETENTION_PASSWORD', process.env['DB_RETENTION_PASSWORD']);

  const lines = await applyRoleSql(adminUrl, 'application', appUser, appPassword, generateRoleSql);
  if (retentionPassword)
    lines.push(
      ...(await applyRoleSql(
        adminUrl,
        'retention',
        retentionUser,
        retentionPassword,
        generateRetentionRoleSql,
      )),
    );
  else lines.push('SKIP retention: DB_RETENTION_PASSWORD not set; the retention role is not applied');
  const failed = lines.some((l) => l.startsWith('FAIL'));
  for (const line of lines) {
    if (failed) log.error({ line }, 'db roles');
    else log.info({ line }, 'db roles');
  }
  process.exitCode = failed ? 1 : 0;
} catch (err) {
  // The message only: a malformed URL's TypeError carries the URL in `input`, which is never printed.
  log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'db roles apply failed');
  process.exitCode = 2;
} finally {
  await stopTelemetry();
}
