/**
 * `pnpm db:roles:check` (R1-G, D-25): proves which MySQL user each deployed connection runs as and whether it holds
 * exactly the grants of the generated role. Reads DATABASE_URL (the application role, roles/app-role.sql) and,
 * when set, DATABASE_URL_RETENTION (roles/retention-role.sql). Read-only: `readHeldGrants` runs SELECT
 * CURRENT_USER() and SHOW GRANTS (roles expanded) and nothing else. Prints one line per finding and no credential;
 * exits 1 when any role fails, 2 when it cannot run.
 * Run it where the repository and the environment's variables meet: locally through the Railway CLI
 * (`railway run pnpm db:roles:check` with the environment and api service linked), never against a URL copied
 * into a chat. The deployed images carry no tooling, so it does not run from a service shell; inside an environment
 * the api image's `db-roles-apply` entrypoint applies the roles and runs this same comparison.
 */
import {
  compareGrants,
  formatDiff,
  generateRetentionRoleSql,
  generateRoleSql,
  grantSetOf,
  readHeldGrants,
  userOf,
} from '@oremedia/db/roles';

async function checkRole(
  role: 'application' | 'retention',
  url: string,
  expectedSql: (db: string, user: string) => string,
): Promise<string[]> {
  const { user: urlUser, database } = userOf(url);
  const held = await readHeldGrants(url);
  const account = held.user.split('@')[0] ?? urlUser;
  const expected = grantSetOf(expectedSql(database, account).split('\n'), database);
  const diff = compareGrants(expected, grantSetOf(held.grants, database));
  return [`${role}: connects as ${held.user} to ${database}`, ...formatDiff(role, account, diff)];
}

// Every failure prints the error's message only (a malformed URL's TypeError carries the URL in `input`; it is
// never printed), as smoke-prod.ts does.
try {
  const appUrl = process.env['DATABASE_URL'];
  if (!appUrl) throw new Error('DATABASE_URL is required');
  const lines = await checkRole('application', appUrl, generateRoleSql);
  const retentionUrl = process.env['DATABASE_URL_RETENTION'];
  if (retentionUrl) lines.push(...(await checkRole('retention', retentionUrl, generateRetentionRoleSql)));
  else
    lines.push(
      'SKIP retention: DATABASE_URL_RETENTION not set (the retention sweep runs on the application role)',
    );
  for (const l of lines) console.log(l);
  process.exit(lines.some((l) => l.startsWith('FAIL')) ? 1 : 0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
