import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import * as schema from '@oremedia/db/schema';
import { ARTICLE_TEXT_MAX_CHARS } from '@oremedia/contracts/content';
import { channelVariants } from '@oremedia/db/schema/content';
import { brandDestinations, seoFindingWork } from '@oremedia/db/schema/destinations';
import { publicationRemoteChanges, publications } from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/**
 * Ledger 1.g4 for migration 0020 (RA-02, RA-03, RA-04 article lifecycle): on a database populated at the previous
 * head (0019) the migration widens `channel_variants.text` and `publication_remote_changes.text` to MEDIUMTEXT and
 * adds `remote_status`, `remote_verification` and `remote_verified_at` to publications, null on every existing row
 * (no destination publication exists before the WordPress adapter is certified, so nothing is backfilled). Every
 * existing row is unchanged; on the migrated data a destination variant and a remote edit hold an article at the
 * one text cap (RA-03), a destination publication records what the website holds and whether it was proven, and
 * a value outside either enum is refused.
 */
const PREVIOUS_HEAD = '0019_seo_audit';
/** Added by migration 0021 (RA-11); absent at both heads this suite compares. */
const LATER_TABLES: MySqlTable[] = [seoFindingWork];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLES.includes(t));

describe('migration 0020 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';

  async function snapshot(): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const columns = getTableColumns(table) as Record<string, MySqlColumn>;
      const order = Object.values(columns).find((c) => c.name === 'id') ?? Object.values(columns)[0]!;
      // remote_status, remote_verification and remote_verified_at are in LATER_COLUMNS (seed.ts).
      out[getTableName(table)] = await tdb.db.select(snapshotColumns(table)).from(table).orderBy(asc(order));
    }
    return JSON.stringify(out);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsUpTo: PREVIOUS_HEAD });
    ({ tenantA } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(publications)).rejects.toThrow(); // remote_status not there at 0019
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the columns, null on every existing row, widens the two text columns and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const pubs = await tdb.db.select().from(publications);
    expect(pubs.length).toBeGreaterThan(0);
    expect(
      pubs.every(
        (p) => p.remoteStatus === null && p.remoteVerification === null && p.remoteVerifiedAt === null,
      ),
    ).toBe(true);
    const types = await tdb.db.execute(
      sql`select table_name as t, column_name as c, data_type as d from information_schema.columns where table_schema = database() and ((table_name = 'channel_variants' and column_name = 'text') or (table_name = 'publication_remote_changes' and column_name = 'text'))`,
    );
    const rows = (types as unknown as [Array<{ t: string; c: string; d: string }>])[0];
    expect(rows.map((r) => `${r.t}.${r.c}:${r.d}`).sort()).toEqual([
      'channel_variants.text:mediumtext',
      'publication_remote_changes.text:mediumtext',
    ]);
  });

  it('a destination variant and a remote edit hold an article at the text cap; a publication records the remote status and its proof', async () => {
    const brandId = tenantA.brandIds[0];
    const destinationId = tenantA.ids['destinationId'] as string;
    const destination = (
      await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, destinationId))
    )[0]!;
    expect(destination.brandId).toBe(brandId);
    const seeded = (
      await tdb.db.select().from(channelVariants).where(eq(channelVariants.tenantId, tenantA.tenantId))
    )[0]!;
    const text = 'x'.repeat(ARTICLE_TEXT_MAX_CHARS);
    const variantId = newId('cv');
    await tdb.db.insert(channelVariants).values({
      id: variantId,
      tenantId: tenantA.tenantId,
      brandId,
      contentRevisionId: seeded.contentRevisionId,
      channelConnectionId: null,
      destinationId,
      text,
      altTexts: [],
      settings: { publishMode: 'publish' },
      exportIds: [],
      capabilityVersion: 1,
      validation: { ok: true, issues: [] },
    });
    const stored = (await tdb.db.select().from(channelVariants).where(eq(channelVariants.id, variantId)))[0]!;
    expect(stored.text).toHaveLength(ARTICLE_TEXT_MAX_CHARS); // MEDIUMTEXT: not truncated at 64 KiB
    const publicationId = newId('pub');
    const at = new Date('2026-10-05T05:00:00.000Z');
    await tdb.db.insert(publications).values({
      id: publicationId,
      tenantId: tenantA.tenantId,
      brandId,
      contentPackageId: seeded.contentRevisionId.replace(/^pr_/, 'pkg_'),
      contentRevisionId: seeded.contentRevisionId,
      channelVariantId: variantId,
      channelConnectionId: null,
      destinationId,
      occurrenceKey: `${seeded.contentRevisionId}:${destinationId}:once`,
      authority: 'approval',
      approvalId: null,
      mandateId: null,
      scheduledFor: at,
      state: 'published',
      remotePostId: '42',
      remoteUrl: 'https://site.example/why-ore-and-tar/',
      remoteStatus: 'live',
      remoteVerification: 'verified',
      remoteVerifiedAt: at,
      claimant: `pub:${publicationId}`,
      scheduledByKind: 'user',
      scheduledById: tenantA.ownerUserId,
    });
    const pub = (await tdb.db.select().from(publications).where(eq(publications.id, publicationId)))[0]!;
    expect(pub).toMatchObject({ remoteStatus: 'live', remoteVerification: 'verified', remoteVerifiedAt: at });
    for (const bad of [{ remoteStatus: 'published' }, { remoteVerification: 'ok' }])
      await expect(
        tdb.db.execute(
          sql`update ${publications} set ${sql.raw(Object.keys(bad)[0] === 'remoteStatus' ? 'remote_status' : 'remote_verification')} = ${Object.values(bad)[0]} where id = ${publicationId}`,
        ),
      ).rejects.toMatchObject({ cause: { code: 'WARN_DATA_TRUNCATED' } });
    const changeId = newId('prc');
    await tdb.db.insert(publicationRemoteChanges).values({
      id: changeId,
      tenantId: tenantA.tenantId,
      brandId,
      publicationId,
      kind: 'edit',
      state: 'requested',
      text,
      textHash: 'a'.repeat(64),
      reason: null,
      requestedByKind: 'user',
      requestedById: tenantA.ownerUserId,
      requestedAt: at,
    });
    const change = (
      await tdb.db.select().from(publicationRemoteChanges).where(eq(publicationRemoteChanges.id, changeId))
    )[0]!;
    expect(change.text).toHaveLength(ARTICLE_TEXT_MAX_CHARS);
  });
});
