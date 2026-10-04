import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { assetVersions, uploadIntents } from '@oremedia/db/schema/assets';
import { renderJobs, renderedExports } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { assetService } from '@oremedia/module-assets';
import { creativeService } from '@oremedia/module-creative';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0026 (STU-2a video media): on a database populated at the previous head (0025) the
 * migration adds nullable asset_versions.media_info, upload_intents.rejection_detail, render_jobs.progress and the
 * video columns of rendered_exports, and appends `cancelled` to render_jobs.state; every existing row is unchanged and
 * reads null. On the migrated data the seeded version reads with no media info, the seeded intent's status has no
 * detail, and the seeded pending render job can be cancelled. The columns are in LATER_COLUMNS (seed.ts).
 */
const PREVIOUS_HEAD = '0025_studio_generation';
const TABLES = (Object.values(schema) as unknown[]).filter((v): v is MySqlTable => v instanceof MySqlTable);

describe('migration 0026 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';

  async function snapshot(): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const columns = getTableColumns(table) as Record<string, MySqlColumn>;
      const order = Object.values(columns).find((c) => c.name === 'id') ?? Object.values(columns)[0]!;
      out[getTableName(table)] = await tdb.db.select(snapshotColumns(table)).from(table).orderBy(asc(order));
    }
    return JSON.stringify(out);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsUpTo: PREVIOUS_HEAD });
    ({ tenantA } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(assetVersions)).rejects.toThrow(); // media_info not there yet
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the nullable columns, null on every existing row, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect((await tdb.db.select().from(assetVersions)).every((v) => v.mediaInfo === null)).toBe(true);
    expect((await tdb.db.select().from(uploadIntents)).every((i) => i.rejectionDetail === null)).toBe(true);
    const jobs = await tdb.db.select().from(renderJobs);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.progress === null)).toBe(true);
    expect(
      (await tdb.db.select().from(renderedExports)).every(
        (e) => e.durationMs === null && e.fps === null && e.posterStorageKey === null,
      ),
    ).toBe(true);
    await expect(
      tdb.db.execute(sql`update ${renderJobs} set state = 'paused' where id = ${jobs[0]!.id}`),
    ).rejects.toMatchObject({ cause: { code: 'WARN_DATA_TRUNCATED' } });
  });

  it('the seeded rows work with the new code: upload status, and a pending render job is cancelled', async () => {
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
    const ctx = {
      tenantId: tenantA.tenantId,
      actor: { kind: 'user' as const, id: tenantA.ownerUserId },
      brandIds: 'all' as const,
      correlationId: 'corr_roll_forward_0026',
    };
    const intentId = tenantA.ids['uploadIntentId'] as string;
    expect(await runInTenant(ctx, () => assetService.uploadStatus(owner, { intentId }))).toMatchObject({
      state: 'issued',
      rejectionDetail: null,
      kind: 'photo',
    });
    const renderJobId = tenantA.ids['renderJobId'] as string;
    expect(
      await runInTenant(ctx, () =>
        withTransaction((tx) => creativeService.renders.cancel(owner, { renderJobId }, tx)),
      ),
    ).toMatchObject({ state: 'cancelled' });
    const [job] = await tdb.db.select().from(renderJobs).where(eq(renderJobs.id, renderJobId));
    expect(job?.state).toBe('cancelled');
  });
});
