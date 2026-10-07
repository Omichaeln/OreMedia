import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from './testing';
import {
  applyRoleSql,
  generateDeletionRoleSql,
  generateRetentionRoleSql,
  generateRoleSql,
  readHeldGrants,
} from './roles';

/**
 * R1-G (D-25): `applyRoleSql` (the api's db-roles-apply entrypoint) creates the role user, sets its password,
 * grants exactly the generated role and reports the same PASS/FAIL lines as `pnpm db:roles:check`; a re-run after
 * the grants changed converges; a role naming a table that does not exist waits and then refuses without touching
 * the user.
 */
describe('applyRoleSql', () => {
  let tdb: TestDatabase;
  let adminUrl: string;
  const users: string[] = [];
  const userName = (): string => {
    const u = `oremedia_apply_${randomBytes(4).toString('hex')}`;
    users.push(u);
    return u;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const u = new URL(tdb.adminUrl);
    u.pathname = `/${tdb.name}`;
    adminUrl = u.toString();
  });
  afterAll(async () => {
    const admin = await mysql.createConnection(tdb.adminUrl);
    for (const u of users) await admin.query(`DROP USER IF EXISTS '${u}'@'%'`);
    await admin.end();
    await tdb?.drop();
  });

  it('creates the application user with exactly the generated grants and reports PASS', async () => {
    const user = userName();
    const password = randomBytes(12).toString('hex');
    const lines = await applyRoleSql(adminUrl, 'application', user, password, generateRoleSql, 0);
    expect(lines[0]).toBe(`application: applied to ${user}@% on ${tdb.name}`);
    expect(lines).toContain(`PASS application: ${user} holds exactly the generated grants`);
    expect(lines.join('\n')).not.toContain(password);

    const asRole = new URL(adminUrl);
    asRole.username = user;
    asRole.password = password;
    const held = await readHeldGrants(asRole.toString());
    expect(held.user).toBe(`${user}@%`);
    expect(held.grants.some((g) => /ALL PRIVILEGES/i.test(g))).toBe(false);
  });

  it('applies the deletion role with exactly its generated grants', async () => {
    const user = userName();
    const lines = await applyRoleSql(adminUrl, 'deletion', user, 'a-password', generateDeletionRoleSql, 0);
    expect(lines).toContain(`PASS deletion: ${user} holds exactly the generated grants`);
  });

  it('re-running converges after a grant drifted and rotates the password', async () => {
    const user = userName();
    await applyRoleSql(adminUrl, 'retention', user, 'first-password', generateRetentionRoleSql, 0);
    const admin = await mysql.createConnection(tdb.adminUrl);
    await admin.query(`GRANT UPDATE ON \`${tdb.name}\`.\`audit_events\` TO '${user}'@'%'`);
    await admin.end();

    const lines = await applyRoleSql(
      adminUrl,
      'retention',
      user,
      'second-password',
      generateRetentionRoleSql,
      0,
    );
    expect(lines).toContain(`PASS retention: ${user} holds exactly the generated grants`);
    const stale = new URL(adminUrl);
    stale.username = user;
    stale.password = 'first-password';
    await expect(mysql.createConnection(stale.toString())).rejects.toMatchObject({
      code: 'ER_ACCESS_DENIED_ERROR',
    });
  });

  it('refuses when a table the role names does not exist, without creating the user', async () => {
    const user = userName();
    const missing = (db: string, u: string): string =>
      `GRANT SELECT ON \`${db}\`.\`not_a_table\` TO '${u}'@'%';\n`;
    await expect(applyRoleSql(adminUrl, 'application', user, 'pw', missing, 0)).rejects.toThrow(
      'application: tables the role names do not exist yet: not_a_table',
    );
    const admin = await mysql.createConnection(tdb.adminUrl);
    const [rows] = await admin.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM mysql.user WHERE user = ?',
      [user],
    );
    await admin.end();
    expect(Number(rows[0]?.['n'])).toBe(0);
  });
});
