import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import * as schema from '@oremedia/db/schema';
import { passwordSetupTokens } from '@oremedia/db/schema/access';
import { conversations, messages, responseDrafts } from '@oremedia/db/schema/community';
import { channelConnections, credentialRefs } from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0012 (comment replies): on a database populated at the previous head (0011), with
 * conversations, ingested comments and a response draft, the migration only adds messages.parent_remote_message_id,
 * the reply columns of response_drafts and the new draft states. Existing comments keep a null parent (top level),
 * the existing draft keeps its state and null reply columns, every other value is unchanged; and a draft can move
 * through the new states afterwards.
 */
const PREVIOUS_HEAD = '0011_remote_post_changes';
/** Added by later migrations (0013: migration-0013-roll-forward.integration.test.ts). */
const LATER_TABLES: MySqlTable[] = [passwordSetupTokens];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !LATER_TABLES.includes(t));

describe('migration 0012 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';
  // Fixed prefixed ids in the ULID shape (this app does not depend on the domain package).
  const conversationId = 'conv_01K0012R0LLF0RWARD0000000A';
  const messageIds = ['msg_01K0012R0LLF0RWARD0000000B', 'msg_01K0012R0LLF0RWARD0000000C'];
  const draftId = 'rdft_01K0012R0LLF0RWARD000000D';

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
    const tenantId = tenantA.tenantId;
    const brandId = tenantA.brandIds[0]!;
    const credentialRefId = 'cr_01K0012R0LLF0RWARD0000000E';
    const connectionId = 'cc_01K0012R0LLF0RWARD0000000F';
    // Written with sql``: at 0011 the community tables lack the columns the current schema objects name.
    await tdb.db.insert(credentialRefs).values({
      id: credentialRefId,
      tenantId,
      kmsKeyId: 'fixture-kms-key',
      wrappedDataKey: 'fixture-wrapped-key',
      ciphertext: 'fixture-ciphertext',
      iv: 'fixture-iv',
      authTag: 'fixture-authtag',
      aad: `${tenantId}:${connectionId}`,
    });
    await tdb.db.insert(channelConnections).values({
      id: connectionId,
      tenantId,
      brandId,
      providerKey: 'linkedin_page',
      remoteAccountId: 'urn:li:organization:1',
      displayName: 'Acme',
      credentialRefId,
      grantedScopes: [],
      status: 'active',
      capabilityVersion: 1,
    });
    await tdb.db.execute(
      sql`insert into ${conversations} (id, tenant_id, brand_id, channel_connection_id, remote_thread_id, state, last_message_at, created_at, updated_at, version) values (${conversationId}, ${tenantId}, ${brandId}, ${connectionId}, 'urn:li:share:1', 'open', ${new Date('2026-09-20T10:00:00.000Z')}, ${new Date()}, ${new Date()}, 0)`,
    );
    for (const [i, id] of messageIds.entries())
      await tdb.db.execute(
        sql`insert into ${messages} (id, tenant_id, brand_id, conversation_id, remote_message_id, direction, author_hash, author_handle, text, remote_created_at, created_at) values (${id}, ${tenantId}, ${brandId}, ${conversationId}, ${`urn:li:comment:(urn:li:share:1,${i})`}, 'inbound', ${'a'.repeat(64)}, ${`@p${i}`}, ${`comment ${i}`}, ${new Date('2026-09-20T10:00:00.000Z')}, ${new Date()})`,
      );
    await tdb.db.execute(
      sql`insert into ${responseDrafts} (id, tenant_id, brand_id, conversation_id, author_kind, author_id, text, fact_refs, state, created_at, updated_at, version) values (${draftId}, ${tenantId}, ${brandId}, ${conversationId}, 'agent', 'sp_1', 'Proposed answer', '[]', 'draft', ${new Date()}, ${new Date()}, 0)`,
    );
    await expect(tdb.db.select({ c: messages.parentRemoteMessageId }).from(messages)).rejects.toThrow(); // not at 0011
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the columns and states; existing comments are top level, the draft keeps its state, nothing else moves', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const rows = await tdb.db
      .select({ id: messages.id, parent: messages.parentRemoteMessageId })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.parent === null)).toBe(true);
    const [draft] = await tdb.db.select().from(responseDrafts).where(eq(responseDrafts.id, draftId));
    expect(draft).toMatchObject({
      state: 'draft',
      replyToMessageId: null,
      sentAt: null,
      outboundMessageId: null,
      failureCode: null,
      failureDetail: null,
    });
  });

  it('a migrated draft can take the new states and reply columns', async () => {
    for (const state of ['queued', 'sending', 'outcome_unknown'] as const)
      await tdb.db.update(responseDrafts).set({ state }).where(eq(responseDrafts.id, draftId));
    await tdb.db
      .update(responseDrafts)
      .set({
        state: 'failed',
        replyToMessageId: messageIds[0]!,
        failureCode: 'comment_blocked',
        sentAt: new Date(),
      })
      .where(eq(responseDrafts.id, draftId));
    const [draft] = await tdb.db.select().from(responseDrafts).where(eq(responseDrafts.id, draftId));
    expect(draft).toMatchObject({
      state: 'failed',
      replyToMessageId: messageIds[0],
      failureCode: 'comment_blocked',
    });
  });
});
