import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { createRoleUser, createTestDatabase, type TestDatabase } from './testing';
import { generateDeletionRoleSql } from './roles';
import { DELETION_ROLE_DELETES, INSERT_ONLY_TABLES } from './global-tables';

/**
 * Ledger 7.16 (spec 17.5, 6.1): the deletion role (roles/deletion-role.sql) is the application role plus DELETE on
 * the insert-only tables a tenant or brand deletion removes, and nothing else: audit and release evidence stay
 * undeletable, no insert-only row can be updated, and no DDL. Checked by the engine, with the generated grant SQL
 * applied to a real user (createRoleUser, both database modes). The application role's refusal is
 * immutability.integration.test.ts; the deletion workflow running on this role end to end is worker-core's
 * deletion-role.integration.test.ts.
 */
const DENIED = { code: 'ER_TABLEACCESS_DENIED_ERROR' };

describe('deletion database role', () => {
  let tdb: TestDatabase;
  let role: Awaited<ReturnType<typeof createRoleUser>>;
  let deletion: mysql.Connection;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    role = await createRoleUser(tdb, 'deletion');
    deletion = await mysql.createConnection(role.url);
    const admin = await mysql.createConnection(tdb.url);
    await admin.query(
      `INSERT INTO audit_events (id, tenant_id, actor_kind, actor_id, action, resource_type, resource_id, decision, correlation_id, created_at) VALUES ('aud_d1', 'ten_1', 'user', 'usr_1', 'x', 't', 'r', 'allowed', 'c', NOW(3))`,
    );
    await admin.end();
  });
  afterAll(async () => {
    await deletion?.end();
    await role?.drop();
    await tdb?.drop();
  });

  it('the list deletes only insert-only tables, and never audit, release or sign-in evidence', () => {
    expect(DELETION_ROLE_DELETES.every((t) => INSERT_ONLY_TABLES.includes(t))).toBe(true);
    for (const evidence of ['audit_events', 'remote_evidence', 'auth_events'])
      expect(DELETION_ROLE_DELETES).not.toContain(evidence);
    expect(() => generateDeletionRoleSql('db', 'u')).not.toThrow();
  });

  it('the deletion role deletes what a deletion removes and nothing else', async () => {
    for (const t of DELETION_ROLE_DELETES) await deletion.query(`DELETE FROM \`${t}\` WHERE 1 = 0`);
    // The application role's other privileges are there: mutable rows are read, written and removed.
    await deletion.query(`DELETE FROM tenants WHERE id = 'ten_x'`);
    await deletion.query(`UPDATE users SET name = name WHERE id = 'usr_x'`);
    await deletion.query(
      `INSERT INTO audit_events (id, tenant_id, actor_kind, actor_id, action, resource_type, resource_id, decision, correlation_id, created_at) VALUES ('aud_d2', 'ten_1', 'user', 'usr_1', 'deletion.step', 'deletion_request', 'r', 'allowed', 'c', NOW(3))`,
    );
    // Evidence stays out of reach, and no insert-only row can be changed.
    await expect(deletion.query(`DELETE FROM audit_events WHERE id = 'aud_d1'`)).rejects.toMatchObject(
      DENIED,
    );
    for (const t of ['audit_events', 'remote_evidence', 'auth_events'])
      await expect(deletion.query(`DELETE FROM \`${t}\` WHERE 1 = 0`), t).rejects.toMatchObject(DENIED);
    for (const t of INSERT_ONLY_TABLES)
      await expect(deletion.query(`UPDATE \`${t}\` SET id = id WHERE 1 = 0`), t).rejects.toMatchObject(
        DENIED,
      );
    await expect(deletion.query(`SELECT * FROM __drizzle_migrations`)).rejects.toMatchObject(DENIED);
    await expect(deletion.query(`DROP TABLE creative_revisions`)).rejects.toMatchObject(DENIED);
  });
});
