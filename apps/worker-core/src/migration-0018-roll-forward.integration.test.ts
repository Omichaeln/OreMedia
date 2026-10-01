import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import * as schema from '@oremedia/db/schema';
import { channelVariants } from '@oremedia/db/schema/content';
import { brandDestinations } from '@oremedia/db/schema/destinations';
import { publicationRemoteChanges, publications, remoteEvidence } from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Ledger 1.g4 for migration 0018 (R2-3 destination targets): on a database populated at the previous head (0017)
 * the migration makes `channel_connection_id` nullable on channel_variants and publications, adds `destination_id`
 * beside it (FK to brand_destinations, unique per revision, indexed), the `unpublish` remote change and the
 * read-back, validation and revert evidence kinds. Every existing row is unchanged (its destination_id reads
 * null); on the migrated data a variant and a publication can target a destination of the same brand, a second
 * variant for the same revision and destination is refused, and the new evidence kind is accepted.
 */
const PREVIOUS_HEAD = '0017_destination_report_rows';
const TABLES = (Object.values(schema) as unknown[]).filter((v): v is MySqlTable => v instanceof MySqlTable);

describe('migration 0018 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';

  async function snapshot(): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const columns = getTableColumns(table) as Record<string, MySqlColumn>;
      const order = Object.values(columns).find((c) => c.name === 'id') ?? Object.values(columns)[0]!;
      // destination_id is in LATER_COLUMNS (seed.ts), so the snapshot names only what exists at 0017.
      out[getTableName(table)] = await tdb.db.select(snapshotColumns(table)).from(table).orderBy(asc(order));
    }
    return JSON.stringify(out);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsUpTo: PREVIOUS_HEAD });
    ({ tenantA } = await seedTwoTenants(tdb.db));
    await expect(tdb.db.select().from(channelVariants)).rejects.toThrow(); // destination_id not there at 0017
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the columns, null on every existing row, and leaves every existing row unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const variants = await tdb.db.select().from(channelVariants);
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.every((v) => v.destinationId === null && v.channelConnectionId !== null)).toBe(true);
    const pubs = await tdb.db.select().from(publications);
    expect(pubs.length).toBeGreaterThan(0);
    expect(pubs.every((p) => p.destinationId === null && p.channelConnectionId !== null)).toBe(true);
  });

  it('a variant and a publication target a destination of the brand; the same target twice is refused; the new evidence kind is accepted', async () => {
    const brandId = tenantA.brandIds[0];
    const destinationId = tenantA.ids['destinationId'] as string;
    const destination = (
      await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, destinationId))
    )[0]!;
    expect(destination.brandId).toBe(brandId);
    const seeded = (
      await tdb.db.select().from(channelVariants).where(eq(channelVariants.tenantId, tenantA.tenantId))
    )[0]!;
    const variantId = newId('cv');
    await tdb.db.insert(channelVariants).values({
      id: variantId,
      tenantId: tenantA.tenantId,
      brandId,
      contentRevisionId: seeded.contentRevisionId,
      channelConnectionId: null,
      destinationId,
      text: 'Why ore and tar last',
      altTexts: [],
      settings: { publishMode: 'draft' },
      exportIds: [],
      capabilityVersion: 1,
      validation: { ok: true, issues: [] },
    });
    await expect(
      tdb.db.insert(channelVariants).values({
        id: newId('cv'),
        tenantId: tenantA.tenantId,
        brandId,
        contentRevisionId: seeded.contentRevisionId,
        channelConnectionId: null,
        destinationId,
        text: 'again',
        altTexts: [],
        settings: {},
        exportIds: [],
        capabilityVersion: 1,
        validation: { ok: true, issues: [] },
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } }); // uq_variant_destination
    const publicationId = newId('pub');
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
      scheduledFor: new Date(Date.now() + 3600_000),
      state: 'scheduled',
      claimant: `pub:${publicationId}`,
      scheduledByKind: 'user',
      scheduledById: tenantA.ownerUserId,
    });
    // A destination of another tenant (or none) cannot be referenced: fk_publication_destination.
    await expect(
      tdb.db.insert(publications).values({
        id: newId('pub'),
        tenantId: tenantA.tenantId,
        brandId,
        contentPackageId: 'pkg_x',
        contentRevisionId: seeded.contentRevisionId,
        channelVariantId: variantId,
        channelConnectionId: null,
        destinationId: newId('dst'),
        occurrenceKey: `${seeded.contentRevisionId}:nowhere:once`,
        authority: 'approval',
        approvalId: null,
        mandateId: null,
        scheduledFor: new Date(),
        state: 'scheduled',
        claimant: 'pub:x',
        scheduledByKind: 'user',
        scheduledById: tenantA.ownerUserId,
      }),
    ).rejects.toMatchObject({ cause: { code: 'ER_NO_REFERENCED_ROW_2' } });
    const payload = { remoteId: '42', contentHash: 'a'.repeat(64) };
    await tdb.db.insert(remoteEvidence).values({
      id: newId('ev'),
      tenantId: tenantA.tenantId,
      publicationId,
      attemptId: null,
      kind: 'remote_readback',
      remotePostId: '42',
      remoteUrl: 'https://acme.example/?p=42',
      payload,
      payloadHash: sha256(payload),
      capturedAt: new Date(),
    });
    await tdb.db.insert(publicationRemoteChanges).values({
      id: newId('prc'),
      tenantId: tenantA.tenantId,
      brandId,
      publicationId,
      kind: 'unpublish',
      state: 'requested',
      reason: 'wrong date',
      requestedByKind: 'user',
      requestedById: tenantA.ownerUserId,
      requestedAt: new Date(),
    });
    const rows = await tdb.db.select().from(publications).where(eq(publications.id, publicationId));
    expect(rows[0]).toMatchObject({ channelConnectionId: null, destinationId });
  });
});
