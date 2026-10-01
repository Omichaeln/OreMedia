/**
 * `pnpm db:roles:check` (R1-G, D-25): proves which MySQL user each deployed connection runs as and whether it holds
 * exactly the grants of the generated role. Reads DATABASE_URL (the application role, roles/app-role.sql) and,
 * when set, DATABASE_URL_RETENTION (roles/retention-role.sql). Read-only: it runs SELECT CURRENT_USER() and SHOW
 * GRANTS and nothing else. Prints one line per finding and no credential; exits 1 when any role fails.
 * Run it from an environment that can reach the database (a Railway shell on the api service, or locally with
 * the environment's variables), never against a URL copied into a chat.
 */
import mysql from 'mysql2/promise';
import { generateRetentionRoleSql, generateRoleSql } from '@oremedia/db/roles';
import { compareGrants, formatDiff, grantSetOf, userOf } from './compare';

async function heldGrants(url: string): Promise<{ user: string; grants: string[] }> {
  const conn = await mysql.createConnection(url);
  try {
    const [who] = await conn.query<Array<{ u: string }>>('SELECT CURRENT_USER() AS u');
    const [rows] = await conn.query<Array<Record<string, string>>>('SHOW GRANTS FOR CURRENT_USER()');
    return { user: who[0]?.u ?? '', grants: rows.map((r) => Object.values(r)[0] ?? '') };
  } finally {
    await conn.end();
  }
}

async function checkRole(
  role: 'application' | 'retention',
  url: string,
  expectedSql: (db: string, user: string) => string,
): Promise<string[]> {
  const { user: urlUser, database } = userOf(url);
  const held = await heldGrants(url);
  const account = held.user.split('@')[0] ?? urlUser;
  const expected = grantSetOf(expectedSql(database, account).split('\n'), database);
  const diff = compareGrants(expected, grantSetOf(held.grants, database));
  return [`${role}: connects as ${held.user} to ${database}`, ...formatDiff(role, account, diff)];
}

const appUrl = process.env['DATABASE_URL'];
if (!appUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const lines = await checkRole('application', appUrl, generateRoleSql);
const retentionUrl = process.env['DATABASE_URL_RETENTION'];
if (retentionUrl) lines.push(...(await checkRole('retention', retentionUrl, generateRetentionRoleSql)));
else
  lines.push(
    'SKIP retention: DATABASE_URL_RETENTION not set (the retention sweep runs on the application role)',
  );
for (const l of lines) console.log(l);
process.exit(lines.some((l) => l.startsWith('FAIL')) ? 1 : 0);
