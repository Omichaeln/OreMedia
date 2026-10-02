import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { passwordSetupTokens } from '@oremedia/db/schema/access';
import {
  channelConnections,
  credentialRefs,
  publicationRemoteChanges,
  publications,
  remoteEvidence,
} from '@oremedia/db/schema/publishing';
import { planItems } from '@oremedia/db/schema/content';
import {
  brandDestinations,
  destinationReportRows,
  pendingDestinationGrants,
  seoAuditPages,
  seoAuditRuns,
  sourceUsePolicies,
  seoFindingWork,
} from '@oremedia/db/schema/destinations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  FixtureProviderAdapter,
  configurePublishingProviders,
  publicationService,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';
import { seedTwoTenants, snapshotColumns, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4 for migration 0011 (edit and delete of published posts): on a database populated at the previous
 * head (0010), with publications in every state and release evidence of every kind, the migration adds
 * `publication_remote_changes` (empty) and appends `removed` to publications.state and `remote_edit` /
 * `remote_deletion` to remote_evidence.kind. Every existing row and value is unchanged, and a publication published
 * before the migration can be deleted remotely afterwards.
 */
const PREVIOUS_HEAD = '0010_pending_channel_grants';
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = {
  credentialRef: 'cr',
  channelConnection: 'cc',
  publication: 'pub',
  contentPackage: 'cp',
  contentRevision: 'crv',
  channelVariant: 'cv',
  releaseApproval: 'ra',
  remoteEvidence: 're',
} as const;
const newId = (kind: keyof typeof PREFIX) =>
  `${PREFIX[kind]}_${Array.from({ length: 26 }, () => ULID_ALPHABET[Math.floor(Math.random() * 32)]).join('')}`;
const hashCanonical = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const NEW_TABLES: MySqlTable[] = [publicationRemoteChanges];
/** Added by later migrations (0013: migration-0013-roll-forward.integration.test.ts). */
const LATER_TABLES: MySqlTable[] = [
  passwordSetupTokens,
  planItems,
  brandDestinations,
  sourceUsePolicies,
  pendingDestinationGrants,
  destinationReportRows,
  seoAuditRuns,
  seoAuditPages,
  seoFindingWork,
];
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t) && !LATER_TABLES.includes(t));
const STATES_BEFORE = [
  'scheduled',
  'dispatching',
  'processing',
  'published',
  'failed',
  'outcome_unknown',
  'retry_eligible',
  'cancelled',
  'held',
] as const;
const EVIDENCE_BEFORE = [
  'accepted_response',
  'status_poll',
  'reconciliation',
  'human_confirmation',
  'metrics_readback',
] as const;

describe('migration 0011 rolls forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let before = '';
  const publicationIds = new Map<string, string>();
  let connectionId = '';

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
    const { tenantId, brandIds, ownerUserId } = tenantA;
    const credentialRefId = newId('credentialRef');
    connectionId = newId('channelConnection');
    await tdb.db.insert(credentialRefs).values({
      id: credentialRefId,
      tenantId,
      kmsKeyId: 'fixture-kms-key',
      wrappedDataKey: 'Zml4dHVyZQ==',
      ciphertext: 'Zml4dHVyZQ==',
      iv: 'Zml4dHVyZQ==',
      authTag: 'Zml4dHVyZQ==',
      aad: `${tenantId}:${connectionId}`,
    });
    // Raw sql: health and health_checked_at (0022) are not there at this head.
    await tdb.db.execute(
      sql`insert into ${channelConnections} (id, tenant_id, brand_id, provider_key, remote_account_id, display_name, credential_ref_id, granted_scopes, missing_scopes, status, token_expires_at, capability_version, created_at, updated_at) values (${connectionId}, ${tenantId}, ${brandIds[0]}, 'fixture_provider', 'acct_roll_forward_0011', 'Roll-forward channel', ${credentialRefId}, '["w_post"]', '[]', 'active', null, 1, ${new Date()}, ${new Date()})`,
    );
    for (const state of STATES_BEFORE) {
      const id = newId('publication');
      publicationIds.set(state, id);
      // Raw sql names only the columns that exist at 0010 (destination_id arrives with 0018).
      const remotePostId = state === 'published' ? 'post_rf_1' : null;
      const remoteUrl = state === 'published' ? 'https://fixture.example/p/1' : null;
      await tdb.db.execute(
        sql`insert into ${publications} (id, tenant_id, brand_id, content_package_id, content_revision_id, channel_variant_id, channel_connection_id, occurrence_key, authority, approval_id, mandate_id, scheduled_for, state, remote_post_id, remote_url, scheduled_by_kind, scheduled_by_id, created_at, updated_at) values (${id}, ${tenantId}, ${brandIds[0]}, ${newId('contentPackage')}, ${newId('contentRevision')}, ${newId('channelVariant')}, ${connectionId}, ${`roll-forward-0011:${state}`}, 'approval', ${newId('releaseApproval')}, null, ${new Date('2026-09-01T10:00:00.000Z')}, ${state}, ${remotePostId}, ${remoteUrl}, 'user', ${ownerUserId}, ${new Date()}, ${new Date()})`,
      );
    }
    for (const kind of EVIDENCE_BEFORE) {
      const payload = { kind, remotePostId: 'post_rf_1' };
      await tdb.db.insert(remoteEvidence).values({
        id: newId('remoteEvidence'),
        tenantId,
        publicationId: publicationIds.get('published')!,
        kind,
        remotePostId: 'post_rf_1',
        payload,
        payloadHash: hashCanonical(payload),
        capturedAt: new Date('2026-09-01T10:00:01.000Z'),
      });
    }
    await expect(tdb.db.select().from(publicationRemoteChanges)).rejects.toThrow(); // not there at 0010
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('adds the change table (empty) and the new enum values; every existing row and value is unchanged', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    expect(await tdb.db.select().from(publicationRemoteChanges)).toEqual([]);
    const states = await tdb.db
      .select({ state: publications.state })
      .from(publications)
      .where(eq(publications.channelConnectionId, connectionId));
    expect(states.map((s) => s.state).sort()).toEqual([...STATES_BEFORE].sort());
    // The appended values are writable now.
    const cancelled = publicationIds.get('cancelled')!;
    await tdb.db.update(publications).set({ state: 'removed' }).where(eq(publications.id, cancelled));
    expect((await tdb.db.select().from(publications).where(eq(publications.id, cancelled)))[0]?.state).toBe(
      'removed',
    );
    await tdb.db.update(publications).set({ state: 'cancelled' }).where(eq(publications.id, cancelled));
    const payload = { changeId: 'prc_rf', outcome: 'done' };
    await tdb.db.insert(remoteEvidence).values({
      id: newId('remoteEvidence'),
      tenantId: tenantA.tenantId,
      publicationId: publicationIds.get('published')!,
      kind: 'remote_deletion',
      payload,
      payloadHash: hashCanonical(payload),
      capturedAt: new Date(),
    });
  });

  it('a post published before the migration can be deleted remotely after it', async () => {
    const registry = new ProviderRegistry().register(new FixtureProviderAdapter());
    configurePublishingProviders({ registry });
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
    const publicationId = publicationIds.get('published')!;
    const res = await runInTenant(
      {
        tenantId: tenantA.tenantId,
        actor: { kind: 'user', id: owner.id },
        brandIds: 'all',
        correlationId: 'corr_roll_forward_0011',
      },
      () =>
        withTransaction((tx) =>
          publicationService.deleteRemote(owner, { publicationId, reason: 'roll-forward check' }, tx),
        ),
    );
    expect(res).toMatchObject({ accepted: true, remotePostId: 'post_rf_1' });
    const changes = await tdb.db.select().from(publicationRemoteChanges);
    expect(changes).toEqual([
      expect.objectContaining({ id: res.changeId, publicationId, kind: 'delete', state: 'requested' }),
    ]);
    configurePublishingProviders({});
  });
});
