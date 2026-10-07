import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { MySqlColumn } from 'drizzle-orm/mysql-core';
import {
  DELETION_ROLE_DELETES,
  INSERT_ONLY_TABLES,
  configureDatabase,
  configureRoleDatabase,
  tenantScopedTables,
  type Db,
} from '@oremedia/db';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { createRoleUser, createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createDeletionActivities } from '@oremedia/activities';
import { MemoryStorageProvider, configureStorage } from '@oremedia/module-assets';
import { createOperationsRuntime, deletionHandlers, outboxRouteFor } from '@oremedia/module-operations';
import type { DeletionWorkflowInputV1 } from '@oremedia/contracts/operations';
import { runDeletionRequest } from '@oremedia/workflows/deletion-request.workflow.v1';
import { callPath, fillEmptyTables, seedTwoTenants } from '../../../tooling/test-fixtures/src/seed';
import { composeModules } from './composition';
import { RETAINED_ON_DELETION } from './deletion-handlers';
import { operationsActivities } from './operations-worker';

/**
 * Ledger 7.16 end to end: worker-core's database connection is the application role (roles/app-role.sql) and the
 * deletion connection (DATABASE_URL_DELETION) is the deletion role (roles/deletion-role.sql). A tenant deletion's
 * handler steps as worker-core registers them (operationsActivities) remove every row of the tenant, the
 * insert-only ones included, except the retained evidence; the same activities on the application role are refused
 * by the engine at the first insert-only table and remove nothing there, so the separate role is what makes
 * deletion work while the application role keeps no DELETE on evidence. (Every row of tenant B staying byte for
 * byte is deletion.integration.test.ts; here its row counts are compared.)
 */
type Counts = Record<string, number>;

describe('tenant deletion on the deletion role (ledger 7.16)', () => {
  let tdb: TestDatabase;
  const tenantIds = { a: '', b: '' };
  const roles: Array<{ drop(): Promise<void> }> = [];
  let deletionUrl = '';
  let input: DeletionWorkflowInputV1;
  let requestId = '';
  let beforeA: Counts;
  let beforeB: Counts;

  let appDb: Db;

  /** Rows per tenant-scoped table, read on the application role's connection (it reads every table). */
  const countsOf = async (tenantId: string): Promise<Counts> => {
    const counts: Counts = {};
    for (const table of tenantScopedTables()) {
      const tenantCol = (Object.values(getTableColumns(table)) as MySqlColumn[]).find(
        (c) => c.name === 'tenant_id',
      )!;
      const [row] = await appDb
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .where(eq(tenantCol, tenantId));
      counts[getTableName(table)] = Number(row?.n ?? 0);
    }
    return counts;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const { tenantA, tenantB } = await seedTwoTenants(tdb.db);
    tenantIds.a = tenantA.tenantId;
    tenantIds.b = tenantB.tenantId;
    composeModules(); // the worker's composition root: routes and every deletion handler
    configureStorage(new MemoryStorageProvider());
    for (const t of [tenantA, tenantB]) await fillEmptyTables(tdb.db, t);
    // The owner's tenant request routes deletionRequestWorkflowV1 (the api, as deletion.integration.test.ts drives it).
    const res = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'operations.deletion.request',
      { subjectType: 'tenant', subjectId: tenantA.tenantId, reason: 'contract ended' },
    );
    if (res.error) throw new Error(`deletion request refused: ${res.error.code}`);
    requestId = (res.data as { deletionRequestId: string }).deletionRequestId;
    const [evt] = await tdb.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, tenantA.tenantId),
          eq(outboxEvents.eventType, 'operations.deletion_requested'),
        ),
      );
    input = outboxRouteFor(evt!.eventType)!({ ...evt!, payload: evt!.payload })!
      .args[0] as DeletionWorkflowInputV1;
    const app = await createRoleUser(tdb, 'app');
    const deletion = await createRoleUser(tdb, 'deletion');
    roles.push(app, deletion);
    deletionUrl = deletion.url;
    // worker.ts: DATABASE_URL is the application role, DATABASE_URL_DELETION the deletion role.
    appDb = configureDatabase({ url: app.url, connectionLimit: 2 });
    beforeA = await countsOf(tenantIds.a);
    beforeB = await countsOf(tenantIds.b);
  });
  afterAll(async () => {
    for (const r of roles) await r.drop();
    await tdb?.drop();
  });

  it('the role deletes exactly the insert-only tables the handlers purge, and tenant A has rows in each', () => {
    const purged = tenantScopedTables()
      .map((t) => getTableName(t))
      .filter((n) => INSERT_ONLY_TABLES.includes(n) && !RETAINED_ON_DELETION[n])
      .sort();
    expect([...DELETION_ROLE_DELETES].sort()).toEqual(purged);
    expect(input.deletionRequestId).toBe(requestId);
    expect(DELETION_ROLE_DELETES.filter((n) => !beforeA[n])).toEqual([]);
  });

  it('control: on the application role a handler step is refused by the engine and no insert-only row goes', async () => {
    const onAppRole = createDeletionActivities(createOperationsRuntime().deletion);
    const refused = await runDeletionRequest(onAppRole, input).then(
      () => null,
      (err: unknown) => err as Error & { cause?: { code?: string } },
    );
    // The first insert-only table on the way (agents: agent_steps) is refused; the step's transaction rolls back.
    expect(refused?.message).toMatch(/delete from `agent_steps`/);
    expect(refused?.cause).toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR' });
    const after = await countsOf(tenantIds.a);
    for (const n of DELETION_ROLE_DELETES) expect(after[n], n).toBe(beforeA[n]);
  });

  it('worker-core runs the steps on the deletion connection: every row of A goes but the evidence, B is untouched', async () => {
    configureRoleDatabase('deletion', { url: deletionUrl, connectionLimit: 2 });
    const out = await runDeletionRequest(operationsActivities(), input);
    expect(out.state).toBe('blocked'); // waiting for the operator-only stores
    // Every database step is done, the ones with insert-only tables included; the rest wait for an operator.
    expect(out.steps.filter((s) => s.status !== 'done' && s.status !== 'operator_action_required')).toEqual(
      [],
    );
    expect(out.steps.filter((s) => s.status === 'done').map((s) => s.handler)).toEqual(
      expect.arrayContaining([
        'agents',
        'review',
        'measurement',
        'experiments',
        'creative',
        'skills',
        'billing',
      ]),
    );

    const after = await countsOf(tenantIds.a);
    const left = Object.entries(after)
      .filter(([, n]) => n > 0)
      .map(([k]) => k)
      .sort();
    expect(left).toEqual(Object.keys(RETAINED_ON_DELETION).sort());
    expect(await countsOf(tenantIds.b)).toEqual(beforeB);
    const steps = await appDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.resourceId, requestId), eq(auditEvents.action, 'deletion.step')));
    expect(steps).toHaveLength(deletionHandlers().length);
  });
});
