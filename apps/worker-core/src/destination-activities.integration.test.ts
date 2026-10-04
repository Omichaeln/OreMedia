import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { brandDestinations } from '@oremedia/db/schema/destinations';
import { auditEvents } from '@oremedia/db/schema/operations';
import { credentialRefs } from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  DESTINATION_REFRESH_ACTOR,
  DESTINATION_REVOKE_ACTOR,
  createDestinationRefreshActivities,
  createDestinationRevokeActivities,
  createDestinationVerifyActivities,
} from '@oremedia/activities';
import {
  FixtureCmsAdapter,
  FixtureSourceAdapter,
  configureDestinationCms,
  configureDestinationSources,
  configureSourceActivation,
  createDestinationRuntime,
  destinationService,
} from '@oremedia/module-destinations';
import { LocalKms, configureCredentialBroker, registerProviderClients } from '@oremedia/module-publishing';
import { CmsRegistry, SourceRegistry } from '@oremedia/providers';

/**
 * Ledger G21: the destination activity hosts of worker-core that had no integration test (the daily token refresh
 * R2-1, the secret verification R2-3, the remote revoke RA-01), each built from the production factory over the
 * real destinations runtime (one runtime per process, as publishing-worker.ts composes it), against MySQL with the
 * fixture source and the fixture website. For every host: the tenant context it establishes (the platform job, or
 * the connecting person re-resolved now), a foreign tenant or destination refused non-retryably before any
 * credential is opened, the outcome written (health, credential rows, audit), and a replayed call that causes no
 * second effect.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

const refusal = async (p: Promise<unknown>) => {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { name?: string; type?: string; nonRetryable?: boolean } | null;
  expect(err?.name).toBe('ApplicationFailure');
  return { type: err?.type, nonRetryable: err?.nonRetryable };
};

describe('destination activity hosts (worker-core) against MySQL and the fixture source and website (ledger G21)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const tenantB = newId('ten');
  const brandA = newId('brd');
  const brandB = newId('brd');
  const userA = newId('usr');
  const userB = newId('usr');
  const membershipA = newId('mem');
  const membershipB = newId('mem');
  const source = new FixtureSourceAdapter('ga4_property');
  const cms = new FixtureCmsAdapter();
  /** One runtime per worker process: the per-destination locks live as long as the worker does. */
  const runtime = createDestinationRuntime();
  let propertyB = '';

  const owner = (tenantId: string, userId: string): ResolvedActor => ({
    kind: 'user',
    id: userId,
    tenantId,
    membershipId: tenantId === tenantA ? membershipA : membershipB,
    membershipStatus: 'active',
    role: 'owner',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  });
  const ctx = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    brandIds: 'all',
    correlationId: 'corr_dest_acts',
  });
  const run = <T>(tenantId: string, userId: string, fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx(tenantId, userId), () => withTransaction(fn));
  const destinationRow = async (id: string) =>
    (await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, id)))[0]!;
  const credentialRow = async (id: string) =>
    (await tdb.db.select().from(credentialRefs).where(eq(credentialRefs.id, id)))[0]!;
  const auditsOf = (tenantId: string, action: string, resourceId: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantId),
          eq(auditEvents.action, action),
          eq(auditEvents.resourceId, resourceId),
        ),
      );
  /** A GA4 property connected through the real connect flow: the grant sealed by the broker. */
  const connectProperty = async (tenantId: string, userId: string, brandId: string, externalId: string) => {
    source.targets = [{ externalId, displayName: externalId }];
    const actor = owner(tenantId, userId);
    const started = await run(tenantId, userId, (tx) =>
      destinationService.connect.start(
        actor,
        { brandId, kind: 'ga4_property', redirectUri: 'https://app.example/connect/callback' },
        tx,
      ),
    );
    const choice = await run(tenantId, userId, (tx) =>
      destinationService.connect.complete(actor, { state: started.state, code: 'good' }, tx),
    );
    return (
      await run(tenantId, userId, (tx) =>
        destinationService.connect.select(actor, { pendingId: choice.pendingId, externalId }, tx),
      )
    ).id;
  };
  const connectSite = async (tenantId: string, userId: string, brandId: string, siteUrl: string) =>
    (
      await run(tenantId, userId, (tx) =>
        destinationService.connect.withSecret(
          owner(tenantId, userId),
          { brandId, kind: 'cms_site', siteUrl, username: 'ore-editor', secret: 'abcd efgh ijkl mnop' },
          tx,
        ),
      )
    ).id;
  const disconnect = async (tenantId: string, userId: string, brandId: string, destinationId: string) => {
    const row = await destinationRow(destinationId);
    return run(tenantId, userId, (tx) =>
      destinationService.disconnect(
        owner(tenantId, userId),
        { brandId, destinationId, expectedVersion: row.version },
        tx,
      ),
    );
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'dest-acts-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'dest-acts-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values([
      { id: userA, email: `dest-acts-${userA.slice(-6).toLowerCase()}@example.test`, name: 'A' },
      { id: userB, email: `dest-acts-${userB.slice(-6).toLowerCase()}@example.test`, name: 'B' },
    ]);
    await tdb.db.insert(memberships).values([
      { id: membershipA, tenantId: tenantA, userId: userA, role: 'owner', status: 'active', allBrands: true },
      { id: membershipB, tenantId: tenantB, userId: userB, role: 'owner', status: 'active', allBrands: true },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configureCredentialBroker({ kms: new LocalKms('dest-acts-master-secret-0123456789abcdef') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    configureDestinationSources({ registry: new SourceRegistry().register(source) });
    configureDestinationCms({ registry: new CmsRegistry().register(cms) });
    configureSourceActivation(null); // every source enabled
    propertyB = await connectProperty(tenantB, userB, brandB, 'properties/B1');
  });
  afterAll(async () => {
    await tdb?.drop();
  });
  beforeEach(() => {
    source.refreshBehaviour = { kind: 'refresh' };
    source.revokeBehaviour = { outcome: 'revoked' };
    cms.verifyBehaviour = { kind: 'ok', canPublish: true };
  });

  describe('createDestinationRefreshActivities (destinationTokenRefreshWorkflowV1, R2-1)', () => {
    const acts = createDestinationRefreshActivities(runtime.refresh);
    const refreshInput = (tenantId: string, destinationId: string) => ({
      tenantId,
      destinationId,
      actor: DESTINATION_REFRESH_ACTOR,
      correlationId: 'corr_dest_refresh',
    });

    it('the due listing is platform-level: references of every tenant, nothing written; a replay lists the same', async () => {
      const propertyA = await connectProperty(tenantA, userA, brandA, 'properties/A-due');
      const input = { correlationId: 'corr_dest_refresh', now: new Date().toISOString(), withinHours: 24 };
      const before = await tdb.db.select().from(brandDestinations);
      const due = await acts.listDueDestinationRefreshes(input);
      expect(due).toEqual(
        expect.arrayContaining([
          { tenantId: tenantA, destinationId: propertyA },
          { tenantId: tenantB, destinationId: propertyB },
        ]),
      );
      expect(due.every((d) => Object.keys(d).sort().join() === 'destinationId,tenantId')).toBe(true);
      expect(await acts.listDueDestinationRefreshes(input)).toEqual(due);
      expect(await tdb.db.select().from(brandDestinations)).toEqual(before);
    });

    it('rotates the credential in the destination tenant as the platform job and audits; a replay inside the lock refreshes nothing', async () => {
      const propertyA = await connectProperty(tenantA, userA, brandA, 'properties/A-refresh');
      const firstRef = (await destinationRow(propertyA)).credentialRefId!;
      const refreshes = source.refreshCalls.length;
      const result = await acts.refreshDestinationCredential(refreshInput(tenantA, propertyA));
      expect(result.ok).toBe(true);
      expect(source.refreshCalls.length).toBe(refreshes + 1);
      const after = await destinationRow(propertyA);
      expect(after.credentialRefId).not.toBe(firstRef);
      expect(after.health).toBe('healthy');
      expect((await credentialRow(firstRef)).destroyedAt).toBeInstanceOf(Date);
      expect((await credentialRow(after.credentialRefId!)).aad).toBe(`${tenantA}:${propertyA}`);
      const audits = await auditsOf(tenantA, 'destination.token_refresh', propertyA);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorKind: DESTINATION_REFRESH_ACTOR.kind,
        actorId: DESTINATION_REFRESH_ACTOR.id,
        decision: 'allowed',
      });
      // Temporal retries the activity (or the schedule overlaps): the per-destination lock answers, nothing rotates.
      expect(await acts.refreshDestinationCredential(refreshInput(tenantA, propertyA))).toEqual({
        ok: false,
        reason: 'locked',
      });
      expect(source.refreshCalls.length).toBe(refreshes + 1);
      expect(await destinationRow(propertyA)).toEqual(after);
      expect(await auditsOf(tenantA, 'destination.token_refresh', propertyA)).toHaveLength(1);
    });

    it("another tenant's destination is refused before its credential is opened; nothing changes", async () => {
      const before = await destinationRow(propertyB);
      const refreshes = source.refreshCalls.length;
      expect(await refusal(acts.refreshDestinationCredential(refreshInput(tenantA, propertyB)))).toEqual({
        type: 'PolicyDenied',
        nonRetryable: true,
      });
      expect(source.refreshCalls.length).toBe(refreshes);
      expect(await destinationRow(propertyB)).toEqual(before);
      expect(await auditsOf(tenantA, 'destination.token_refresh', propertyB)).toEqual([]);
    });
  });

  describe('createDestinationVerifyActivities (destinationVerifyWorkflowV1, R2-3)', () => {
    const acts = createDestinationVerifyActivities(runtime.verify);
    const verifyInput = (tenantId: string, userId: string, destinationId: string) => ({
      tenantId,
      destinationId,
      actor: { kind: 'user' as const, id: userId },
      correlationId: 'corr_dest_verify',
    });

    it('verifies the sealed secret as the connecting person in the destination tenant and records the health; a replay inside the lock verifies nothing', async () => {
      const site = await connectSite(tenantA, userA, brandA, 'https://verify.acme.example');
      expect((await destinationRow(site)).health).toBe('unknown');
      cms.calls.length = 0;
      expect(await acts.verifyDestinationCredential(verifyInput(tenantA, userA, site))).toEqual({
        ok: true,
        health: 'healthy',
      });
      expect(cms.calls).toEqual([
        {
          op: 'verify',
          secret: 'abcd efgh ijkl mnop',
          username: 'ore-editor',
          siteUrl: 'https://verify.acme.example',
        },
      ]);
      const after = await destinationRow(site);
      expect(after.health).toBe('healthy');
      const audits = await auditsOf(tenantA, 'destination.verify', site);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorKind: 'user', actorId: userA, decision: 'allowed' });
      // The activity retried, or the registered event delivered twice: the lock answers, the site is not asked again.
      expect(await acts.verifyDestinationCredential(verifyInput(tenantA, userA, site))).toEqual({
        ok: false,
        reason: 'locked',
      });
      expect(cms.calls).toHaveLength(1);
      expect(await destinationRow(site)).toEqual(after);
      expect(await auditsOf(tenantA, 'destination.verify', site)).toHaveLength(1);
    });

    it('a foreign tenant, a foreign destination or an actor who is no member now is refused before the secret is opened', async () => {
      const site = await connectSite(tenantA, userA, brandA, 'https://isolated.acme.example');
      const siteB = await connectSite(tenantB, userB, brandB, 'https://isolated-b.acme.example');
      const before = await destinationRow(site);
      const beforeB = await destinationRow(siteB);
      cms.calls.length = 0;
      for (const bad of [
        verifyInput(tenantB, userB, site), // tenant B naming tenant A's site
        verifyInput(tenantA, userA, siteB), // tenant A naming tenant B's site
        verifyInput(tenantB, userA, site), // tenant A's owner is no member of tenant B
        verifyInput(tenantA, newId('usr'), site), // a person whose membership is gone
      ])
        expect(await refusal(acts.verifyDestinationCredential(bad))).toEqual({
          type: 'PolicyDenied',
          nonRetryable: true,
        });
      expect(cms.calls).toEqual([]);
      expect(await destinationRow(site)).toEqual(before);
      expect(await destinationRow(siteB)).toEqual(beforeB);
    });
  });

  describe('createDestinationRevokeActivities (destinationRevokeWorkflowV1, RA-01)', () => {
    const acts = createDestinationRevokeActivities(runtime.revoke);
    const revokeInput = (tenantId: string, destinationId: string) => ({
      tenantId,
      destinationId,
      // The disconnecting person: the host replaces it with the platform job, whose grants are never loaded.
      actor: { kind: 'user' as const, id: newId('usr') },
      correlationId: 'corr_dest_revoke',
    });

    it('revokes at the vendor as the platform job, destroys the credential and audits; a replay revokes nothing again', async () => {
      const propertyA = await connectProperty(tenantA, userA, brandA, 'properties/A-revoke');
      await disconnect(tenantA, userA, brandA, propertyA);
      const credentialRefId = (await destinationRow(propertyA)).credentialRefId!;
      const revokes = source.revokeCalls.length;
      expect(await acts.revokeDestinationAccess(revokeInput(tenantA, propertyA))).toEqual({
        outcome: 'revoked',
      });
      expect(source.revokeCalls.length).toBe(revokes + 1);
      expect((await credentialRow(credentialRefId)).destroyedAt).toBeInstanceOf(Date);
      const after = await destinationRow(propertyA);
      expect(after).toMatchObject({ status: 'disconnected', credentialRefId: null });
      const audits = await auditsOf(tenantA, 'destination.remote_revoke', propertyA);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorKind: DESTINATION_REVOKE_ACTOR.kind,
        actorId: DESTINATION_REVOKE_ACTOR.id,
        decision: 'allowed',
        metadata: { remoteRevoke: 'revoked', kind: 'ga4_property' },
      });
      // The activity retried or the event replayed: nothing left to revoke, nothing opened or recorded.
      expect(await acts.revokeDestinationAccess(revokeInput(tenantA, propertyA))).toEqual({
        outcome: 'already_destroyed',
      });
      expect(source.revokeCalls.length).toBe(revokes + 1);
      expect(await destinationRow(propertyA)).toEqual(after);
      expect(await auditsOf(tenantA, 'destination.remote_revoke', propertyA)).toHaveLength(1);
    });

    it("another tenant's disconnected destination is refused before its credential is opened; nothing changes", async () => {
      const property = await connectProperty(tenantB, userB, brandB, 'properties/B-revoke');
      await disconnect(tenantB, userB, brandB, property);
      const before = await destinationRow(property);
      const revokes = source.revokeCalls.length;
      expect(await refusal(acts.revokeDestinationAccess(revokeInput(tenantA, property)))).toEqual({
        type: 'PolicyDenied',
        nonRetryable: true,
      });
      expect(source.revokeCalls.length).toBe(revokes);
      expect(await destinationRow(property)).toEqual(before);
      expect((await credentialRow(before.credentialRefId!)).destroyedAt).toBeNull();
    });
  });
});
