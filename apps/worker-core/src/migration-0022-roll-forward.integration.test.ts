import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { studioGenerationJobs } from '@oremedia/db/schema/creative';
import { auditEvents } from '@oremedia/db/schema/operations';
import { channelConnections } from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { channelHealth, channelService } from '@oremedia/module-publishing';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0022 (RA-01 channel health): on a database populated at the previous head (0021)
 * the migration adds `health` (default `unknown`) and `health_checked_at` (null) to
 * channel_connections; every existing row is unchanged and reads as never checked. On the migrated data the
 * connection seeded before the migration lists with its health, the ingest-side writer records a health change
 * under the row lock with its audit event, and a value outside the enum is refused. Additive and roll-forward safe:
 * the two columns are in LATER_COLUMNS (seed.ts), so the earlier suites keep seeding without them.
 */
const PREVIOUS_HEAD = '0021_report_quality_finding_work';
/** Added by later migrations (0025). */
const LATER_TABLES: MySqlTable[] = [studioGenerationJobs];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLES.includes(t));

describe('migration 0022 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';

  async function snapshot(): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const columns = getTableColumns(table) as Record<string, MySqlColumn>;
      const order = Object.values(columns).find((c) => c.name === 'id') ?? Object.values(columns)[0]!;
      // health and health_checked_at are in LATER_COLUMNS (seed.ts).
      out[getTableName(table)] = await tdb.db.select(snapshotColumns(table)).from(table).orderBy(asc(order));
    }
    return JSON.stringify(out);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsUpTo: PREVIOUS_HEAD });
    ({ tenantA } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(channelConnections)).rejects.toThrow(); // health not there at 0021
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the two columns, unknown and null on every existing row, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const rows = await tdb.db.select().from(channelConnections);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.health === 'unknown' && c.healthCheckedAt === null)).toBe(true);
    const connectionId = tenantA.ids['publishingChannelConnectionId'] as string;
    await expect(
      tdb.db.execute(sql`update ${channelConnections} set health = 'fine' where id = ${connectionId}`),
    ).rejects.toMatchObject({ cause: { code: 'WARN_DATA_TRUNCATED' } });
  });

  it('the connection seeded before the migration lists with its health; the ingest writer records a change with its audit event', async () => {
    const connectionId = tenantA.ids['publishingChannelConnectionId'] as string;
    const ctx = {
      tenantId: tenantA.tenantId,
      actor: { kind: 'user' as const, id: tenantA.ownerUserId },
      brandIds: 'all' as const,
      correlationId: 'corr_roll_forward_0022',
    };
    const owner: ResolvedActor = {
      kind: 'user',
      id: tenantA.ownerUserId,
      tenantId: tenantA.tenantId,
      membershipId: tenantA.ownerMembershipId,
      membershipStatus: 'active',
      role: 'owner',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    const listed = await runInTenant(ctx, () => channelService.list(owner, { brandId: tenantA.brandIds[0] }));
    expect(listed.find((c) => c.id === connectionId)).toMatchObject({
      health: 'unknown',
      healthCheckedAt: null,
    });
    await runInTenant(ctx, () => channelHealth.record(connectionId, 'token_expired'));
    const after = (
      await tdb.db.select().from(channelConnections).where(eq(channelConnections.id, connectionId))
    )[0]!;
    expect(after.health).toBe('token_expired');
    expect(after.healthCheckedAt).not.toBeNull();
    const audit = (
      await tdb.db.select().from(auditEvents).where(eq(auditEvents.action, 'channel.health'))
    ).find((e) => e.resourceId === connectionId);
    expect(audit).toMatchObject({
      decision: 'denied',
      metadata: { fromState: 'unknown', toState: 'token_expired', channelConnectionId: connectionId },
    });
    // The same health again within the hour re-stamps nothing and audits nothing (pulls run per post).
    await runInTenant(ctx, () => channelHealth.record(connectionId, 'token_expired'));
    expect(
      (await tdb.db.select().from(auditEvents).where(eq(auditEvents.action, 'channel.health'))).filter(
        (e) => e.resourceId === connectionId,
      ),
    ).toHaveLength(1);
  });
});
