import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import {
  CapabilityUnsupportedError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { DestinationKind } from '@oremedia/contracts/destinations';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import {
  brandDestinations,
  pendingDestinationGrants,
  sourceUsePolicies,
} from '@oremedia/db/schema/destinations';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { credentialRefs } from '@oremedia/db/schema/publishing';
import { newId } from '@oremedia/domain/ids';
import {
  LocalKms,
  configureCredentialBroker,
  credentialBroker,
  registerProviderClients,
} from '@oremedia/module-publishing';
import { CmsRegistry, SourceRegistry, textFingerprint } from '@oremedia/providers';
import type { ChannelVariantForPublishing } from '@oremedia/contracts/publishing';
import type { ArticleDocumentV1 } from '@oremedia/contracts/content';
import { renderArticleHtml } from '@oremedia/contracts/article';
import { destinationArticles, effectivePublishMode } from './articles';
import { configureDestinationCms } from './cms';
import { configureSourceAvailability } from './hooks';
import { createDestinationRuntime } from './runtime';
import { destinationService, sourceUsePolicyService } from './service';
import { configureDestinationSources } from './sources';
import { FixtureCmsAdapter, fixtureArticleHash } from './testing/fixture-cms';
import { FixtureSourceAdapter, fixtureSourceCapability } from './testing/fixture-source';

/**
 * Brand destinations and source-use policy against MySQL 8: a destination registered with its owner, listed and
 * read under its brand; a remote identity registered once per tenant; health and disconnection under the row
 * version; a policy limited to the kind's capabilities, versioned on every change, asked before a use. Cross-tenant
 * and cross-brand: NOT_FOUND. Agents never decide.
 */
const USER = 'usr_destinations_test';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_destinations',
});
const member = (tenantId: string, role: MembershipRole): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_destinations_test',
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const agent = (tenantId: string): ResolvedActor => ({
  kind: 'service_principal',
  id: 'sp_destinations_test',
  tenantId,
  status: 'active',
  maxAutonomy: 'create',
  grants: [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'source_use.manage', brandIds: 'all' },
    { action: 'destination.connect', brandIds: 'all' },
  ],
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const REFRESH_ACTOR = { kind: 'platform_operator' as const, id: 'destination-token-refresh' };
const asPlatformJob = <T>(tenantId: string, fn: () => Promise<T>) =>
  runInTenant({ tenantId, actor: REFRESH_ACTOR, brandIds: 'all', correlationId: 'corr_refresh' }, fn);

describe('destinations module against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');
  const owner = () => member(tenantA, 'owner');
  let propertyId = '';

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'destinations-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'destinations-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values({ id: USER, email: 'destinations-test@example.test', name: 'Dest' });
    await tdb.db.insert(memberships).values({
      id: 'mem_destinations_test',
      tenantId: tenantA,
      userId: USER,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('registers a destination owned by the person, lists it by kind and reads it under its brand', async () => {
    const registered = await run(tenantA, (tx) =>
      destinationService.register(
        member(tenantA, 'publisher'),
        {
          brandId: brandA,
          kind: 'ga4_property',
          externalId: 'properties/1001',
          displayName: 'Acme web',
          grantedScopes: ['analytics.readonly'],
        },
        tx,
      ),
    );
    propertyId = registered.id;
    expect(registered).toMatchObject({
      brandId: brandA,
      kind: 'ga4_property',
      ownerUserId: USER,
      grantedScopes: ['analytics.readonly'],
      health: 'unknown',
      healthCheckedAt: null,
      capabilityVersion: 1,
      status: 'active',
      version: 0,
    });
    await run(tenantA, (tx) =>
      destinationService.register(
        owner(),
        { brandId: brandA, kind: 'cms_site', externalId: 'https://acme.example', displayName: 'Acme site' },
        tx,
      ),
    );
    const all = await inTenant(tenantA, () =>
      destinationService.list(member(tenantA, 'analyst'), { brandId: brandA }),
    );
    expect(all.items.map((d) => d.kind)).toEqual(['cms_site', 'ga4_property']);
    const ga4 = await inTenant(tenantA, () =>
      destinationService.list(owner(), { brandId: brandA, kind: 'ga4_property' }),
    );
    expect(ga4.items.map((d) => d.id)).toEqual([propertyId]);
    const got = await inTenant(tenantA, () =>
      destinationService.get(owner(), { brandId: brandA, destinationId: propertyId }),
    );
    expect(got.displayName).toBe('Acme web');
    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'destination.register')));
    expect(audits).toHaveLength(2);
  });

  it('a remote identity is registered once per tenant: a conflict for its own brand, refused without a trace for another', async () => {
    await expect(
      run(tenantA, (tx) =>
        destinationService.register(
          owner(),
          { brandId: brandA, kind: 'ga4_property', externalId: 'properties/1001', displayName: 'Again' },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', resourceId: propertyId });
    const refused = await run(tenantA, (tx) =>
      destinationService.register(
        owner(),
        { brandId: brandA2, kind: 'ga4_property', externalId: 'properties/1001', displayName: 'Again' },
        tx,
      ),
    ).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ValidationFailedError);
    expect((refused as ValidationFailedError).details).toEqual([
      { path: 'externalId', issue: 'remote_identity_registered_to_another_brand' },
    ]);
    expect(JSON.stringify(refused)).not.toContain(propertyId); // neither the id nor the version of A1's row
    expect(JSON.stringify(refused)).not.toContain('version');
    const events = await tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, 'destination.registered')));
    expect(events).toHaveLength(2);
    // Another tenant may hold the same remote identity (uq_destination_remote is per tenant).
    await tdb.db.insert(memberships).values({
      id: 'mem_destinations_test_b',
      tenantId: tenantB,
      userId: USER,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    const other = await run(tenantB, (tx) =>
      destinationService.register(
        member(tenantB, 'owner'),
        { brandId: brandB, kind: 'ga4_property', externalId: 'properties/1001', displayName: 'B web' },
        tx,
      ),
    );
    expect(other.brandId).toBe(brandB);
  });

  it('a creator cannot register; an agent never can (destination.connect)', async () => {
    const input = {
      brandId: brandA,
      kind: 'discord_webhook' as const,
      externalId: 'hook-1',
      displayName: 'News',
    };
    await expect(
      run(tenantA, (tx) => destinationService.register(member(tenantA, 'creator'), input, tx)),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(
      run(tenantA, (tx) => destinationService.register(agent(tenantA), input, tx)),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('health moves under the row version; a stale version is a conflict', async () => {
    await expect(
      run(tenantA, (tx) =>
        destinationService.setHealth(
          owner(),
          { brandId: brandA, destinationId: propertyId, health: 'healthy', expectedVersion: 7 },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const checked = await run(tenantA, (tx) =>
      destinationService.setHealth(
        owner(),
        { brandId: brandA, destinationId: propertyId, health: 'degraded', expectedVersion: 0 },
        tx,
      ),
    );
    expect(checked.health).toBe('degraded');
    expect(checked.healthCheckedAt).not.toBeNull();
    expect(checked.version).toBe(1);
    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'destination.health')));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ brandId: brandA, fromState: 'unknown', toState: 'degraded' });
  });

  it('disconnects once; a second disconnection is refused', async () => {
    const site = await inTenant(tenantA, () =>
      destinationService.list(owner(), { brandId: brandA, kind: 'cms_site' }),
    );
    const id = site.items[0]?.id ?? '';
    const gone = await run(tenantA, (tx) =>
      destinationService.disconnect(owner(), { brandId: brandA, destinationId: id, expectedVersion: 0 }, tx),
    );
    expect(gone.status).toBe('disconnected');
    await expect(
      run(tenantA, (tx) =>
        destinationService.disconnect(
          owner(),
          { brandId: brandA, destinationId: id, expectedVersion: 1 },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'destination.disconnect')));
    expect(audits).toHaveLength(1);
    const events = await tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, 'destination.disconnected')));
    expect(events.map((e) => e.aggregateId)).toEqual([id]);
    // Still listed and readable, as disconnected; no longer health-checked.
    const listed = await inTenant(tenantA, () => destinationService.list(owner(), { brandId: brandA }));
    expect(listed.items.find((d) => d.id === id)?.status).toBe('disconnected');
    const got = await inTenant(tenantA, () =>
      destinationService.get(owner(), { brandId: brandA, destinationId: id }),
    );
    expect(got.status).toBe('disconnected');
    await expect(
      run(tenantA, (tx) =>
        destinationService.setHealth(
          owner(),
          { brandId: brandA, destinationId: id, health: 'healthy', expectedVersion: 1 },
          tx,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'destinationId', issue: 'disconnected' }],
    });
  });

  it('a source-use policy starts at version 1, then moves on only from the version named', async () => {
    const v1 = await run(tenantA, (tx) =>
      sourceUsePolicyService.set(
        owner(),
        {
          brandId: brandA,
          destinationKind: 'ga4_property',
          dataType: 'ga4.reports',
          allowedUses: ['read', 'retain', 'read'],
          retentionDays: 90,
          reviewDueAt: inDays(90),
        },
        tx,
      ),
    );
    expect(v1).toMatchObject({
      version: 1,
      allowedUses: ['read', 'retain'],
      retentionDays: 90,
      reviewedById: USER,
    });
    const stale = { allowedUses: ['read' as const], reviewDueAt: inDays(30) };
    await expect(
      run(tenantA, (tx) =>
        sourceUsePolicyService.set(
          owner(),
          { brandId: brandA, destinationKind: 'ga4_property', dataType: 'ga4.reports', ...stale },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictError); // no expectedVersion named
    await expect(
      run(tenantA, (tx) =>
        sourceUsePolicyService.set(
          owner(),
          {
            brandId: brandA,
            destinationKind: 'ga4_property',
            dataType: 'ga4.reports',
            ...stale,
            expectedVersion: 5,
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const v2 = await run(tenantA, (tx) =>
      sourceUsePolicyService.set(
        owner(),
        {
          brandId: brandA,
          destinationKind: 'ga4_property',
          dataType: 'ga4.reports',
          allowedUses: ['read'],
          retentionDays: 90, // meaningless without `retain`: dropped
          reviewDueAt: inDays(30),
          expectedVersion: 1,
        },
        tx,
      ),
    );
    expect(v2).toMatchObject({ id: v1.id, version: 2, allowedUses: ['read'], retentionDays: null });
    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'source_use.set')))
      .orderBy(asc(auditEvents.id));
    expect(audits.map((a) => a.metadata)).toEqual([
      expect.objectContaining({ dataType: 'ga4.reports', fromVersion: null, toVersion: 1 }),
      expect.objectContaining({ dataType: 'ga4.reports', fromVersion: 1, toVersion: 2 }),
    ]);
    const listed = await inTenant(tenantA, () =>
      sourceUsePolicyService.list(member(tenantA, 'analyst'), { brandId: brandA }),
    );
    expect(listed.items.map((p) => [p.dataType, p.version])).toEqual([['ga4.reports', 2]]);
  });

  it('uses are limited to the kind (a Business Profile location never writes); retain needs a period; the review is ahead', async () => {
    const base = { brandId: brandA, destinationKind: 'gbp_location' as const, dataType: 'gbp.reviews' };
    await expect(
      run(tenantA, (tx) =>
        sourceUsePolicyService.set(
          owner(),
          { ...base, allowedUses: ['read', 'write'], reviewDueAt: inDays(30) },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ details: [{ path: 'allowedUses' }] });
    await expect(
      run(tenantA, (tx) =>
        sourceUsePolicyService.set(
          owner(),
          {
            ...base,
            destinationKind: 'search_console_site',
            allowedUses: ['retain'],
            reviewDueAt: inDays(30),
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ details: [{ path: 'retentionDays' }] });
    await expect(
      run(tenantA, (tx) =>
        sourceUsePolicyService.set(owner(), { ...base, allowedUses: ['read'], reviewDueAt: inDays(-1) }, tx),
      ),
    ).rejects.toMatchObject({ details: [{ path: 'reviewDueAt' }] });
  });

  it('only an admin sets a policy; an agent never does (source_use.manage)', async () => {
    const input = {
      brandId: brandA,
      destinationKind: 'cms_site' as const,
      dataType: 'cms.articles',
      allowedUses: ['write' as const],
      reviewDueAt: inDays(30),
    };
    await expect(
      run(tenantA, (tx) => sourceUsePolicyService.set(member(tenantA, 'publisher'), input, tx)),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(
      run(tenantA, (tx) => sourceUsePolicyService.set(agent(tenantA), input, tx)),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    const set = await run(tenantA, (tx) => sourceUsePolicyService.set(member(tenantA, 'admin'), input, tx));
    expect(set.version).toBe(1);
  });

  it('check: no policy, allowed, not allowed, review overdue', async () => {
    const ask = (
      dataType: string,
      use: 'read' | 'retain' | 'write',
      destinationKind: DestinationKind = 'ga4_property',
    ) =>
      inTenant(tenantA, () =>
        sourceUsePolicyService.check(member(tenantA, 'analyst'), {
          brandId: brandA,
          destinationKind,
          dataType,
          use,
        }),
      );
    expect(await ask('ga4.events', 'read')).toEqual({ allowed: false, reason: 'no_policy', policy: null });
    expect(await ask('ga4.reports', 'read')).toMatchObject({ allowed: true, reason: 'allowed' });
    expect(await ask('ga4.reports', 'retain')).toMatchObject({ allowed: false, reason: 'not_allowed' });
    // A use the kind never offers is simply not allowed (the policy could never have listed it).
    await run(tenantA, (tx) =>
      sourceUsePolicyService.set(
        owner(),
        {
          brandId: brandA,
          destinationKind: 'gbp_location',
          dataType: 'gbp.reviews',
          allowedUses: ['read'],
          reviewDueAt: inDays(30),
        },
        tx,
      ),
    );
    expect(await ask('gbp.reviews', 'write', 'gbp_location')).toMatchObject({
      allowed: false,
      reason: 'not_allowed',
    });
    const now = new Date();
    await tdb.db.insert(sourceUsePolicies).values({
      id: newId('sourceUsePolicy'),
      tenantId: tenantA,
      brandId: brandA,
      destinationKind: 'ga4_property',
      dataType: 'ga4.landing_pages',
      allowedUses: ['read'],
      retentionDays: null,
      version: 3,
      reviewedAt: new Date(now.getTime() - 400 * 86_400_000),
      reviewDueAt: new Date(now.getTime() - 10 * 86_400_000),
      reviewedById: USER,
    });
    expect(await ask('ga4.landing_pages', 'read')).toMatchObject({
      allowed: false,
      reason: 'review_overdue',
      policy: { version: 3 },
    });
  });

  it('a member granted other brands only sees nothing of this one: NOT_FOUND on every read and on register', async () => {
    const restricted: ResolvedActor = {
      kind: 'user',
      id: USER,
      tenantId: tenantA,
      membershipId: 'mem_destinations_test',
      membershipStatus: 'active',
      role: 'admin',
      allBrands: false,
      brandGrants: [{ brandId: brandA2, roles: ['admin'] }],
      mfaEnrolled: false,
    };
    const restrictedCtx: TenantContext = { ...ctx(tenantA), brandIds: new Set([brandA2]) };
    const as = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(restrictedCtx, () => withTransaction(fn));
    await expect(as(() => destinationService.list(restricted, { brandId: brandA }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      as(() => destinationService.get(restricted, { brandId: brandA, destinationId: propertyId })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      as(() => sourceUsePolicyService.list(restricted, { brandId: brandA })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      as(() =>
        sourceUsePolicyService.check(restricted, {
          brandId: brandA,
          destinationKind: 'ga4_property',
          dataType: 'ga4.reports',
          use: 'read',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      as((tx) =>
        destinationService.register(
          restricted,
          { brandId: brandA, kind: 'discord_webhook', externalId: 'hook-9', displayName: 'Nope' },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('another tenant’s brand, and another brand’s destination, are NOT_FOUND on every read', async () => {
    await expect(
      inTenant(tenantA, () => destinationService.list(owner(), { brandId: brandB })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(tenantA, () =>
        destinationService.get(owner(), { brandId: brandA2, destinationId: propertyId }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(tenantB, () =>
        destinationService.get(member(tenantB, 'owner'), { brandId: brandB, destinationId: propertyId }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(tenantA, () => sourceUsePolicyService.list(owner(), { brandId: brandB })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inTenant(tenantA, () =>
        sourceUsePolicyService.check(owner(), {
          brandId: brandB,
          destinationKind: 'ga4_property',
          dataType: 'ga4.reports',
          use: 'read',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run(tenantA, (tx) =>
        destinationService.setHealth(
          owner(),
          { brandId: brandA2, destinationId: propertyId, health: 'healthy', expectedVersion: 1 },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('connect flow and token refresh (ledger R2-1 part A)', () => {
    const fixture = new FixtureSourceAdapter('ga4_property');
    const uncertified = new FixtureSourceAdapter(
      'search_console_site',
      fixtureSourceCapability('search_console_site', { certifiedAt: null }),
    );
    const registry = new SourceRegistry().register(fixture).register(uncertified);
    const runtime = createDestinationRuntime();
    const REDIRECT = 'https://app.example/connect/callback';
    /** Another person of the tenant (an admin): a flow is bound to the actor who started it, not to a role. */
    const otherPerson: ResolvedActor = {
      kind: 'user',
      id: 'usr_destinations_other',
      tenantId: tenantA,
      membershipId: 'mem_destinations_other',
      membershipStatus: 'active',
      role: 'admin',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    let pendingId = '';
    let connectedId = '';
    const start = (actor: ResolvedActor, brandId = brandA) =>
      run(tenantA, (tx) =>
        destinationService.connect.start(actor, { brandId, kind: 'ga4_property', redirectUri: REDIRECT }, tx),
      );
    const complete = (actor: ResolvedActor, state: string, code = 'good') =>
      run(tenantA, (tx) => destinationService.connect.complete(actor, { state, code }, tx));
    const select = (actor: ResolvedActor, id: string, externalId: string) =>
      run(tenantA, (tx) => destinationService.connect.select(actor, { pendingId: id, externalId }, tx));
    const pendingRows = () =>
      tdb.db.select().from(pendingDestinationGrants).where(eq(pendingDestinationGrants.tenantId, tenantA));
    const destinationRow = async (id: string) =>
      (await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, id)))[0]!;
    const credentialRow = async (id: string) =>
      (await tdb.db.select().from(credentialRefs).where(eq(credentialRefs.id, id)))[0]!;
    const auditsOf = (action: string) =>
      tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, action)));

    beforeAll(() => {
      configureDestinationSources({ registry });
      configureCredentialBroker({ kms: new LocalKms('destinations-test-master-secret-0123456789') });
      registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
      fixture.targets = [
        { externalId: 'properties/9001', displayName: 'Acme · Acme web' },
        { externalId: 'properties/9002', displayName: 'Acme · Acme app' },
        { externalId: 'properties/1001', displayName: 'Acme · Already registered' },
      ];
    });

    it('sources.list names each registered kind with its certification and whether it is enabled here', async () => {
      configureSourceAvailability((kind) => kind === 'ga4_property');
      const { items } = await destinationService.sources.list();
      expect(items).toEqual([
        {
          kind: 'ga4_property',
          label: 'Google Analytics 4 property',
          vendor: 'Fixture',
          certified: true,
          enabled: true,
          connect: 'oauth',
        },
        {
          kind: 'search_console_site',
          label: 'Search Console site',
          vendor: 'Fixture',
          certified: false,
          enabled: false,
          connect: 'oauth',
        },
        // R2-3: the CMS kind connects with a secret; registered but not certified and not enabled here.
        {
          kind: 'cms_site',
          label: 'Website CMS',
          vendor: 'WordPress',
          certified: false,
          enabled: false,
          connect: 'secret',
          credential: {
            label: 'Application password',
            hint: 'Created under the site user’s profile (Users → Profile → Application Passwords); the user needs the editor or administrator role.',
          },
        },
      ]);
    });

    it('start refuses an uncertified kind, a disabled kind, a kind without an adapter, a creator and an agent', async () => {
      configureSourceAvailability(() => true);
      const certifiedButDisabled = async () => {
        configureSourceAvailability((kind) => kind !== 'ga4_property');
        try {
          return await start(owner());
        } finally {
          configureSourceAvailability(() => true);
        }
      };
      await expect(certifiedButDisabled()).rejects.toMatchObject({
        code: 'CAPABILITY_UNSUPPORTED',
        details: [{ path: 'kind', issue: 'source_not_enabled:ga4_property' }],
      });
      const notCertified = await run(tenantA, (tx) =>
        destinationService.connect.start(
          owner(),
          { brandId: brandA, kind: 'search_console_site', redirectUri: REDIRECT },
          tx,
        ),
      ).catch((e: unknown) => e);
      expect(notCertified).toBeInstanceOf(CapabilityUnsupportedError);
      expect((notCertified as CapabilityUnsupportedError).details).toEqual([
        { path: 'kind', issue: 'provider_not_certified:search_console_site' },
      ]);
      await expect(
        run(tenantA, (tx) =>
          destinationService.connect.start(
            owner(),
            { brandId: brandA, kind: 'discord_webhook', redirectUri: REDIRECT },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'kind', issue: 'unknown_provider:discord_webhook' }] });
      await expect(start(member(tenantA, 'creator'))).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(start(agent(tenantA))).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(start(owner(), brandB)).rejects.toBeInstanceOf(NotFoundError); // another tenant's brand
    });

    it('start gives the source’s authorisation URL (offline access, consent) under a one-shot state', async () => {
      const started = await start(member(tenantA, 'publisher'));
      const url = new URL(started.url);
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('state')).toBe(started.state);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
      expect(url.searchParams.get('client_id')).toBe('fixture-client');
      expect(Date.parse(started.expiresAt)).toBeGreaterThan(Date.now());
      // Only the actor who started it, in its tenant, can complete it; then it is spent.
      await expect(complete(otherPerson, started.state)).rejects.toMatchObject({
        details: [{ path: 'state', issue: 'connect_state_invalid_or_expired' }],
      });
      await expect(complete(member(tenantA, 'publisher'), started.state)).rejects.toMatchObject({
        details: [{ path: 'state', issue: 'connect_state_invalid_or_expired' }],
      });
      expect((await auditsOf('destination.connect.start')).length).toBeGreaterThanOrEqual(1);
    });

    it('complete exchanges the code, seals the grant and offers the targets; nothing is registered yet', async () => {
      const publisher = member(tenantA, 'publisher');
      const started = await start(publisher);
      const choice = await complete(publisher, started.state, 'code_1');
      pendingId = choice.pendingId;
      expect(fixture.lastCode).toBe('code_1');
      expect(choice).toMatchObject({ brandId: brandA, kind: 'ga4_property', targets: fixture.targets });
      expect(JSON.stringify(choice)).not.toContain('fixture_src');
      const rows = await pendingRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: pendingId, brandId: brandA, actorKind: 'user', actorId: USER });
      expect(rows[0]!.aad).toBe(`${tenantA}:${rows[0]!.destinationId}`);
      expect(JSON.stringify(rows)).not.toContain('fixture_src'); // sealed, never plaintext
      const before = await tdb.db
        .select()
        .from(brandDestinations)
        .where(eq(brandDestinations.brandId, brandA));
      expect(before.some((d) => d.externalId.startsWith('properties/900'))).toBe(false);
      expect(await auditsOf('destination.connect.complete')).toHaveLength(1);
    });

    it('a grant missing the required scope, or a failed exchange, never leaves a pending row', async () => {
      const publisher = member(tenantA, 'publisher');
      const started = await start(publisher);
      await expect(complete(publisher, started.state, 'bad')).rejects.toMatchObject({
        name: 'ProviderAuthError',
        code: 'exchange_failed',
      });
      const narrow = await start(publisher);
      const scopes = fixture.grant.grantedScopes;
      fixture.grant.grantedScopes = ['openid'];
      try {
        await expect(complete(publisher, narrow.state)).rejects.toMatchObject({
          details: [
            { path: 'code', issue: 'scope_missing:https://www.googleapis.com/auth/fixture.readonly' },
          ],
        });
      } finally {
        fixture.grant.grantedScopes = scopes;
      }
      expect(await pendingRows()).toHaveLength(1); // the earlier flow only
    });

    it('select: only the completing actor, among the targets offered; another brand’s identity is refused and the flow kept', async () => {
      const publisher = member(tenantA, 'publisher');
      await expect(select(otherPerson, pendingId, 'properties/9001')).rejects.toMatchObject({
        details: [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
      });
      await expect(select(publisher, pendingId, 'properties/other')).rejects.toMatchObject({
        details: [{ path: 'externalId', issue: 'target_not_offered' }],
      });
      // properties/1001 is brand A1's own registration: a conflict, exactly as register answers.
      await expect(select(publisher, pendingId, 'properties/1001')).rejects.toBeInstanceOf(ConflictError);
      expect(await pendingRows()).toHaveLength(1); // refused inside the transaction: the choice is still open
      // properties/9001 held by another brand of the tenant: refused without naming it, the flow still open.
      await run(tenantA, (tx) =>
        destinationService.register(
          owner(),
          { brandId: brandA2, kind: 'ga4_property', externalId: 'properties/9001', displayName: 'A2 web' },
          tx,
        ),
      );
      const otherBrand = await select(publisher, pendingId, 'properties/9001').catch((e: unknown) => e);
      expect(otherBrand).toBeInstanceOf(ValidationFailedError);
      expect((otherBrand as ValidationFailedError).details).toEqual([
        { path: 'externalId', issue: 'remote_identity_registered_to_another_brand' },
      ]);
      expect(JSON.stringify(otherBrand)).not.toContain('A2 web');
      const [stillOpen] = await pendingRows();
      expect(stillOpen).toMatchObject({ id: pendingId, actorId: USER });
      expect(stillOpen!.ciphertext).not.toBe(''); // the sealed grant was not shredded
      // A member of the tenant granted another brand only: the flow does not exist for them; nothing changes.
      const restricted: ResolvedActor = {
        kind: 'user',
        id: 'usr_destinations_restricted',
        tenantId: tenantA,
        membershipId: 'mem_destinations_restricted',
        membershipStatus: 'active',
        role: 'publisher',
        allBrands: false,
        brandGrants: [{ brandId: brandA2, roles: ['publisher'] }],
        mfaEnrolled: false,
      };
      const restrictedCtx: TenantContext = { ...ctx(tenantA), brandIds: new Set([brandA2]) };
      const as = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(restrictedCtx, () => withTransaction(fn));
      for (const attempt of [
        () =>
          as((tx) =>
            destinationService.connect.select(restricted, { pendingId, externalId: 'properties/9002' }, tx),
          ),
        () => as((tx) => destinationService.connect.cancel(restricted, { pendingId }, tx)),
      ])
        await expect(attempt()).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
          details: [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
        });
      expect(await pendingRows()).toEqual([stillOpen]);
    });

    it('select registers the chosen target with the sealed grant: credential, scopes, expiry, healthy; one-shot', async () => {
      const publisher = member(tenantA, 'publisher');
      const registered = await select(publisher, pendingId, 'properties/9002');
      connectedId = registered.id;
      expect(registered).toMatchObject({
        brandId: brandA,
        kind: 'ga4_property',
        externalId: 'properties/9002',
        displayName: 'Acme · Acme app',
        ownerUserId: USER,
        grantedScopes: fixture.grant.grantedScopes,
        health: 'healthy',
        capabilityVersion: 1,
        status: 'active',
      });
      expect(JSON.stringify(registered)).not.toContain('credentialRef');
      const row = await destinationRow(registered.id);
      expect(row.credentialRefId).toBeTruthy();
      expect(row.tokenExpiresAt).toBeInstanceOf(Date);
      expect(row.healthCheckedAt).toBeInstanceOf(Date);
      const credential = await credentialRow(row.credentialRefId!);
      expect(credential.aad).toBe(`${tenantA}:${registered.id}`);
      expect(credential.destroyedAt).toBeNull();
      // The broker opens it under the destination's AAD (worker-core's path); nothing in the row is plaintext.
      const opened = await inTenant(tenantA, () =>
        credentialBroker.withCredentialRef(
          { tenantId: tenantA, credentialRefId: row.credentialRefId!, aad: `${tenantA}:${registered.id}` },
          async (creds) => creds.accessToken, // the object itself is scrubbed once fn returns
        ),
      );
      expect(opened).toBe('at_fixture_src');
      expect(JSON.stringify(credential)).not.toContain('fixture_src');
      expect(await pendingRows()).toEqual([]);
      // One audit row for the write, under the command that made it (register records destination.register).
      expect(await auditsOf('destination.connect.select')).toHaveLength(1);
      expect((await auditsOf('destination.register')).filter((a) => a.resourceId === registered.id)).toEqual(
        [],
      );
      const events = await tdb.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, 'destination.registered')));
      expect(events.map((e) => e.payload['destinationId'])).toContain(registered.id);
      await expect(select(publisher, pendingId, 'properties/9001')).rejects.toMatchObject({
        details: [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
      });
    });

    it('cancel deletes the flow with its grant; an expired flow is purged by the next start', async () => {
      const publisher = member(tenantA, 'publisher');
      const started = await start(publisher);
      const choice = await complete(publisher, started.state);
      await run(tenantA, (tx) =>
        destinationService.connect.cancel(publisher, { pendingId: choice.pendingId }, tx),
      );
      expect(await pendingRows()).toEqual([]);
      await expect(
        run(tenantA, (tx) =>
          destinationService.connect.cancel(publisher, { pendingId: choice.pendingId }, tx),
        ),
      ).rejects.toMatchObject({
        details: [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
      });
      expect(await auditsOf('destination.connect.cancel')).toHaveLength(1);
      const stale = await complete(publisher, (await start(publisher)).state);
      await tdb.db
        .update(pendingDestinationGrants)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(pendingDestinationGrants.id, stale.pendingId));
      await expect(select(publisher, stale.pendingId, 'properties/9001')).rejects.toMatchObject({
        details: [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
      });
      await start(publisher);
      expect(await pendingRows()).toEqual([]);
    });

    it('the daily refresh lists what is due across tenants, rotates the credential and audits; a revoked grant leaves the destination unreachable', async () => {
      const row = await destinationRow(connectedId);
      const firstRef = row.credentialRefId!;
      const due = await runtime.refresh.listDueDestinationRefreshes({
        correlationId: 'corr_refresh',
        now: new Date().toISOString(),
        withinHours: 24,
      });
      expect(due).toContainEqual({ tenantId: tenantA, destinationId: connectedId });
      expect(due.some((d) => d.destinationId === propertyId)).toBe(false); // registered without a grant
      const farAhead = await runtime.refresh.listDueDestinationRefreshes({
        correlationId: 'corr_refresh',
        now: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        withinHours: 1,
      });
      expect(farAhead.some((d) => d.destinationId === connectedId)).toBe(false);

      const refreshed = await asPlatformJob(tenantA, () =>
        runtime.refresh.refreshDestinationCredential({
          tenantId: tenantA,
          destinationId: connectedId,
          actor: REFRESH_ACTOR,
          correlationId: 'corr_refresh',
        }),
      );
      expect(refreshed.ok).toBe(true);
      expect(fixture.refreshCalls.at(-1)).toMatchObject({ refreshToken: 'rt_fixture_src' });
      const after = await destinationRow(connectedId);
      expect(after.credentialRefId).not.toBe(firstRef);
      expect(after.health).toBe('healthy');
      expect((await credentialRow(firstRef)).destroyedAt).toBeInstanceOf(Date);
      expect((await credentialRow(firstRef)).rotatedAt).toBeInstanceOf(Date);
      const opened = await asPlatformJob(tenantA, () =>
        credentialBroker.withCredentialRef(
          { tenantId: tenantA, credentialRefId: after.credentialRefId!, aad: `${tenantA}:${connectedId}` },
          async (creds) => creds.accessToken,
        ),
      );
      expect(opened).toBe('at_fixture_src_refreshed');
      const allowed = (await auditsOf('destination.token_refresh')).filter((a) => a.decision === 'allowed');
      expect(allowed).toHaveLength(1);
      expect(allowed[0]!.actorKind).toBe('platform_operator');

      fixture.refreshBehaviour = { kind: 'transient' };
      expect(
        await asPlatformJob(tenantA, () =>
          runtime.refresh.refreshDestinationCredential({
            tenantId: tenantA,
            destinationId: connectedId,
            actor: REFRESH_ACTOR,
            correlationId: 'corr_refresh',
          }),
        ),
      ).toEqual({ ok: false, reason: 'locked' }); // the per-destination lock from the refresh a moment ago
      const unlocked = createDestinationRuntime();
      expect(
        await asPlatformJob(tenantA, () =>
          unlocked.refresh.refreshDestinationCredential({
            tenantId: tenantA,
            destinationId: connectedId,
            actor: REFRESH_ACTOR,
            correlationId: 'corr_refresh',
          }),
        ),
      ).toEqual({ ok: false, reason: 'transient' });
      expect((await destinationRow(connectedId)).health).toBe('healthy'); // a transient failure changes nothing
      fixture.refreshBehaviour = { kind: 'revoked' };
      expect(
        await asPlatformJob(tenantA, () =>
          createDestinationRuntime().refresh.refreshDestinationCredential({
            tenantId: tenantA,
            destinationId: connectedId,
            actor: REFRESH_ACTOR,
            correlationId: 'corr_refresh',
          }),
        ),
      ).toEqual({ ok: false, reason: 'reconnect_required' });
      const revoked = await destinationRow(connectedId);
      expect(revoked.health).toBe('unreachable');
      expect(revoked.credentialRefId).toBe(after.credentialRefId); // the grant stays until a person reconnects
      const denied = (await auditsOf('destination.token_refresh')).filter((a) => a.decision === 'denied');
      expect(denied.map((a) => a.metadata?.['reason'])).toEqual(['transient', 'reconnect_required']);
      expect(denied[1]!.metadata).toMatchObject({ fromState: 'healthy', toState: 'unreachable' });
      fixture.refreshBehaviour = { kind: 'refresh' };
    });

    it('disconnect destroys the credential; the broker refuses it afterwards and the refresh skips it', async () => {
      const row = await destinationRow(connectedId);
      await run(tenantA, (tx) =>
        destinationService.disconnect(
          owner(),
          { brandId: brandA, destinationId: connectedId, expectedVersion: row.version },
          tx,
        ),
      );
      const after = await destinationRow(connectedId);
      expect(after).toMatchObject({ status: 'disconnected', tokenExpiresAt: null });
      const credential = await credentialRow(row.credentialRefId!);
      expect(credential.destroyedAt).toBeInstanceOf(Date);
      expect(credential.rotatedAt).toBeNull();
      expect(credential.wrappedDataKey).toBe('');
      await expect(
        inTenant(tenantA, () =>
          credentialBroker.withCredentialRef(
            { tenantId: tenantA, credentialRefId: row.credentialRefId!, aad: `${tenantA}:${connectedId}` },
            async () => 'opened',
          ),
        ),
      ).rejects.toMatchObject({ reason: 'credential_destroyed' });
      expect(
        await asPlatformJob(tenantA, () =>
          createDestinationRuntime().refresh.refreshDestinationCredential({
            tenantId: tenantA,
            destinationId: connectedId,
            actor: REFRESH_ACTOR,
            correlationId: 'corr_refresh',
          }),
        ),
      ).toEqual({ ok: false, reason: 'not_active' });
      const due = await runtime.refresh.listDueDestinationRefreshes({
        correlationId: 'corr_refresh',
        now: new Date().toISOString(),
        withinHours: 24,
      });
      expect(due.some((d) => d.destinationId === connectedId)).toBe(false);
    });
  });
  describe('website articles (ledger R2-3, D-16): a secret connect, its verification and the article publisher', () => {
    const cms = new FixtureCmsAdapter();
    const SITE = 'https://blog.acme.example';
    const SECRET = 'abcd efgh ijkl mnop';
    const VERIFY_ACTOR = { kind: 'user' as const, id: USER };
    const article: ArticleDocumentV1 = {
      kind: 'article',
      title: 'Why ore and tar last',
      slug: 'why-ore-and-tar-last',
      excerpt: 'A short answer.',
      blocks: [
        { type: 'paragraph', text: 'Ore is heavy.' },
        { type: 'faq', question: 'Is it safe?', answer: 'Yes, mostly.' },
      ],
      categories: ['Guides'],
      tags: ['ore'],
    };
    const variant = (
      destinationId: string,
      over: Partial<ChannelVariantForPublishing> = {},
    ): ChannelVariantForPublishing => ({
      id: newId('channelVariant'),
      tenantId: tenantA,
      brandId: brandA,
      contentPackageId: newId('contentPackage'),
      contentRevisionId: newId('contentRevision'),
      channelConnectionId: null,
      destinationId,
      text: 'A short answer.',
      altTexts: [],
      settings: { publishMode: 'draft' },
      exportIds: [],
      exportHashes: [],
      article,
      version: 0,
      ...over,
    });
    let siteId = '';
    const connect = (actor: ResolvedActor, over: Record<string, unknown> = {}) =>
      run(tenantA, (tx) =>
        destinationService.connect.withSecret(
          actor,
          {
            brandId: brandA,
            kind: 'cms_site',
            siteUrl: SITE,
            username: 'ore-editor',
            secret: SECRET,
            ...over,
          },
          tx,
        ),
      );
    // A runtime per call: the per-destination verify lock (a minute, as the refresh's) would otherwise read `locked`.
    const verify = (destinationId: string) =>
      inTenant(tenantA, () =>
        createDestinationRuntime().verify.verifyDestinationCredential({
          tenantId: tenantA,
          destinationId,
          actor: VERIFY_ACTOR,
          correlationId: 'corr_verify',
        }),
      );
    const setArticlePolicy = (allowedUses: Array<'read' | 'write'>) =>
      run(tenantA, async (tx) => {
        const existing = (
          await sourceUsePolicyService.list(owner(), { brandId: brandA, destinationKind: 'cms_site' }, tx)
        ).items.find((p) => p.dataType === 'cms.articles');
        return sourceUsePolicyService.set(
          owner(),
          {
            brandId: brandA,
            destinationKind: 'cms_site',
            dataType: 'cms.articles',
            allowedUses,
            reviewDueAt: inDays(90),
            ...(existing ? { expectedVersion: existing.version } : {}),
          },
          tx,
        );
      });

    beforeAll(() => {
      configureDestinationCms({ registry: new CmsRegistry().register(cms) });
      configureSourceAvailability(() => true);
    });

    it('connect.withSecret seals the secret, registers the site with health unknown and asks for a verification; nothing returns the secret', async () => {
      const registered = await connect(member(tenantA, 'publisher'));
      siteId = registered.id;
      expect(registered).toMatchObject({
        kind: 'cms_site',
        externalId: SITE,
        displayName: 'blog.acme.example',
        grantedScopes: ['articles:write'],
        health: 'unknown',
        healthCheckedAt: null,
        status: 'active',
      });
      expect(JSON.stringify(registered)).not.toContain('abcd');
      const row = (await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, siteId)))[0]!;
      expect(row.credentialRefId).toBeTruthy();
      const credential = (
        await tdb.db.select().from(credentialRefs).where(eq(credentialRefs.id, row.credentialRefId!))
      )[0]!;
      expect(credential.aad).toBe(`${tenantA}:${siteId}`);
      expect(String(credential.ciphertext)).not.toContain('abcd');
      const events = await tdb.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.aggregateId, siteId)));
      expect(events.map((e) => [e.eventType, e.payload['verify']])).toEqual([
        ['destination.registered', true],
      ]);
      expect(JSON.stringify(events)).not.toContain('abcd');
    });

    it("withSecret refuses a non-https or path address, the same site twice, a creator, an agent and another tenant's brand", async () => {
      await expect(connect(owner(), { siteUrl: 'http://blog.acme.example' })).rejects.toMatchObject({
        details: [{ path: 'siteUrl', issue: 'site_url_not_allowed' }],
      });
      await expect(connect(owner(), { siteUrl: 'https://blog.acme.example/wp-admin' })).rejects.toMatchObject(
        {
          details: [{ path: 'siteUrl', issue: 'site_url_not_an_origin' }],
        },
      );
      await expect(connect(owner())).rejects.toBeInstanceOf(ConflictError);
      await expect(connect(member(tenantA, 'creator'))).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(connect(agent(tenantA))).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(connect(owner(), { brandId: brandB })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('the worker verifies the sealed secret against the site and records the health; a refused identity is unreachable', async () => {
      cms.calls.length = 0;
      expect(await verify(siteId)).toEqual({ ok: true, health: 'healthy' });
      expect(cms.calls).toEqual([{ op: 'verify', secret: SECRET, username: 'ore-editor', siteUrl: SITE }]);
      let dto = await inTenant(tenantA, () =>
        destinationService.get(owner(), { brandId: brandA, destinationId: siteId }),
      );
      expect(dto.health).toBe('healthy');
      expect(dto.healthCheckedAt).toBeTruthy();
      cms.verifyBehaviour = { kind: 'unauthorised' };
      expect(await verify(siteId)).toEqual({ ok: false, reason: 'reconnect_required' });
      dto = await inTenant(tenantA, () =>
        destinationService.get(owner(), { brandId: brandA, destinationId: siteId }),
      );
      expect(dto.health).toBe('unreachable');
      cms.verifyBehaviour = { kind: 'transient' };
      expect(await verify(siteId)).toEqual({ ok: false, reason: 'transient' });
      expect(
        (
          await inTenant(tenantA, () =>
            destinationService.get(owner(), { brandId: brandA, destinationId: siteId }),
          )
        ).health,
      ).toBe('degraded');
      cms.verifyBehaviour = { kind: 'ok', canPublish: true };
      expect(await verify(siteId)).toEqual({ ok: true, health: 'healthy' });
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'destination.verify')));
      expect(audits.map((a) => a.decision)).toEqual(['allowed', 'denied', 'denied', 'allowed']);
      await expect(verify(newId('destination'))).rejects.toBeInstanceOf(NotFoundError);
    });

    it('describe names the site as a writable target; a destination variant needs an article and a granted publish mode', async () => {
      expect(await inTenant(tenantA, () => destinationService.describe(siteId))).toEqual({
        brandId: brandA,
        kind: 'cms_site',
        capabilityVersion: 1,
        writable: true,
      });
      expect(await inTenant(tenantA, () => destinationArticles.describe(siteId))).toMatchObject({
        id: siteId,
        brandId: brandA,
        kind: 'cms_site',
        usable: true,
        actions: { edit: true, delete: true, unpublish: true },
      });
      expect(await inTenant(tenantA, () => destinationArticles.validateVariant(variant(siteId)))).toEqual({
        ok: true,
        issues: [],
      });
      expect(
        await inTenant(tenantA, () =>
          destinationArticles.validateVariant(variant(siteId, { article: null })),
        ),
      ).toEqual({
        ok: false,
        issues: [{ path: 'article', issue: 'article_missing' }],
      });
      // Live publishing was not granted at connect time: asking for it is a finding, and the write stays a draft.
      expect(
        await inTenant(tenantA, () =>
          destinationArticles.validateVariant(variant(siteId, { settings: { publishMode: 'publish' } })),
        ),
      ).toEqual({
        ok: false,
        issues: [{ path: 'settings.publishMode', issue: 'publish_not_granted' }],
      });
      expect(effectivePublishMode({ publishMode: 'publish' }, ['articles:write'])).toBe('draft');
      expect(effectivePublishMode({ publishMode: 'publish' }, ['articles:write', 'articles:publish'])).toBe(
        'publish',
      );
      expect(effectivePublishMode({}, ['articles:write', 'articles:publish'])).toBe('draft');
      await expect(inTenant(tenantB, () => destinationArticles.describe(siteId))).resolves.toBeNull();
    });

    it('publish is refused without a source-use policy allowing write (default deny); with it the article lands as a draft, is read back and its page validated', async () => {
      const input = {
        tenantId: tenantA,
        destinationId: siteId,
        publicationId: newId('publication'),
        attemptId: newId('publicationAttempt'),
        idempotencyKey: 'idem_1',
        variant: variant(siteId),
      };
      // The policy an earlier test recorded for cms.articles is narrowed to `read`: a write is then refused (D-17).
      await setArticlePolicy(['read']);
      expect(await inTenant(tenantA, () => destinationArticles.publish(input))).toMatchObject({
        outcome: 'rejected',
        code: 'source_use_denied',
      });
      await setArticlePolicy(['read', 'write']);
      let sent = 0;
      cms.calls.length = 0;
      cms.pages.set(`${SITE}/?p=100`, {
        status: 200,
        html: '<html><head><title>Why ore and tar last – Blog</title><link rel="canonical" href="https://blog.acme.example/why-ore-and-tar-last/"><meta name="robots" content="noindex"></head><body><h1>Why ore and tar last</h1><p>Ore is heavy.</p><h3>Is it safe?</h3><p>Yes, mostly.</p></body></html>',
      });
      const result = await inTenant(tenantA, () =>
        destinationArticles.publish(input, undefined, async () => void sent++),
      );
      expect(result).toMatchObject({ outcome: 'accepted', remotePostId: '100', remoteUrl: `${SITE}/?p=100` });
      expect(cms.calls.map((c) => c.op)).toEqual(['create', 'read']);
      expect(cms.calls.every((c) => c.secret === SECRET)).toBe(true);
      expect(cms.articles.get('100')).toMatchObject({
        status: 'draft',
        slug: 'why-ore-and-tar-last',
        html: renderArticleHtml(article),
      });
      if (result.outcome !== 'accepted') return;
      expect(result.readback).toMatchObject({
        remoteId: '100',
        status: 'draft',
        contentHash: cms.articles.get('100')?.contentHash,
      });
      // RA-04: the read-back is compared with what was sent, field by field, and says so.
      expect(result.readbackVerification).toEqual({
        outcome: 'verified',
        matched: ['content', 'title', 'slug', 'status', 'modifiedAt'],
        mismatched: [],
        reason: null,
        sentHash: textFingerprint(renderArticleHtml(article)),
      });
      expect(result.validation).toMatchObject({ ok: true, status: 200, truncated: false, error: null });
      expect(result.validation?.checks.map((c) => `${c.key}:${c.ok}`)).toEqual([
        'status_ok:true',
        'title_present:true',
        'canonical_present:true',
        'indexable:true', // a draft may carry noindex
        'body_present:true',
        'canonical_matches:true', // the canonical names the slug's path on the site
        'last_paragraph_present:true',
      ]);
    });

    it('a page that stops after the first paragraph fails the last-paragraph check (RA-04), everything else passing', async () => {
      cms.pages.set(`${SITE}/?p=101`, {
        status: 200,
        html: '<html><head><title>Why ore and tar last – Blog</title><link rel="canonical" href="https://blog.acme.example/why-ore-and-tar-last/"></head><body><h1>Why ore and tar last</h1><p>Ore is heavy.</p></body></html>',
      });
      const result = await inTenant(tenantA, () =>
        destinationArticles.publish({
          tenantId: tenantA,
          destinationId: siteId,
          publicationId: newId('publication'),
          attemptId: newId('publicationAttempt'),
          idempotencyKey: 'idem_truncated_page',
          variant: variant(siteId),
        }),
      );
      expect(result).toMatchObject({ outcome: 'accepted', remotePostId: '101' });
      if (result.outcome !== 'accepted') return;
      expect(result.validation?.ok).toBe(false);
      expect(result.validation?.checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([
        'last_paragraph_present',
      ]);
    });

    it('publish (RA-04): with no read allowed the write is recorded as unverified with the reason, never as proof; a read-back that differs is a mismatch', async () => {
      await setArticlePolicy(['write']);
      const unverified = await inTenant(tenantA, () =>
        destinationArticles.publish({
          tenantId: tenantA,
          destinationId: siteId,
          publicationId: newId('publication'),
          attemptId: newId('publicationAttempt'),
          idempotencyKey: 'idem_unverified',
          variant: variant(siteId),
        }),
      );
      expect(unverified).toMatchObject({
        outcome: 'accepted',
        readback: { status: 'draft' },
        readbackVerification: {
          outcome: 'unverified',
          matched: [],
          mismatched: [],
          reason: 'read_not_allowed',
        },
      });
      await setArticlePolicy(['read', 'write']);
      // The site rewrote the title on save (a filter): the read-back names the field that did not match.
      const titled = new FixtureCmsAdapter();
      const original = titled.createArticle.bind(titled);
      titled.createArticle = async (...args) => {
        const created = await original(...args);
        if (created.outcome === 'done') {
          const stored = titled.articles.get(created.article.remoteId)!;
          titled.articles.set(stored.remoteId, { ...stored, title: `${stored.title} (filtered)` });
        }
        return created;
      };
      configureDestinationCms({ registry: new CmsRegistry().register(titled) });
      try {
        const mismatch = await inTenant(tenantA, () =>
          destinationArticles.publish({
            tenantId: tenantA,
            destinationId: siteId,
            publicationId: newId('publication'),
            attemptId: newId('publicationAttempt'),
            idempotencyKey: 'idem_mismatch',
            variant: variant(siteId),
          }),
        );
        expect(mismatch).toMatchObject({
          outcome: 'accepted',
          readbackVerification: {
            outcome: 'mismatch',
            matched: ['content', 'slug', 'status', 'modifiedAt'],
            mismatched: ['title'],
          },
        });
      } finally {
        configureDestinationCms({ registry: new CmsRegistry().register(cms) });
      }
    });

    it('an edit reads the remote first: with the read-back hash it writes; after the site moved it refuses as a conflict and overwrites nothing', async () => {
      const current = cms.articles.get('100')!;
      const edited = await inTenant(tenantA, () =>
        destinationArticles.edit({
          tenantId: tenantA,
          destinationId: siteId,
          remoteId: '100',
          expectedHash: current.contentHash,
          expectedModifiedAt: current.modifiedAt,
          html: '<p>Ore is heavy and tar is sticky.</p><script>alert(1)</script>',
          idempotencyKey: 'idem_edit_1',
        }),
      );
      expect(edited).toMatchObject({
        outcome: 'done',
        readback: { remoteId: '100', contentHash: cms.articles.get('100')?.contentHash },
        // RA-04 / RA-12: the read-back after the write matches the HTML sent and the write's own modified instant.
        readbackVerification: {
          outcome: 'verified',
          matched: ['content', 'modifiedAt'],
          mismatched: [],
          sentHash: textFingerprint('<p>Ore is heavy and tar is sticky.</p>'),
        },
      });
      expect(edited.outcome === 'done' && edited.overwritten).toBeUndefined();
      expect(cms.articles.get('100')?.html).toBe('<p>Ore is heavy and tar is sticky.</p>'); // sanitised at send
      // RA-12: the modified instant is a precondition of its own: the same content touched later is a conflict.
      const touched = cms.articles.get('100')!;
      cms.articles.set('100', { ...touched, modifiedAt: new Date(Date.now() + 60_000).toISOString() });
      expect(
        await inTenant(tenantA, () =>
          destinationArticles.edit({
            tenantId: tenantA,
            destinationId: siteId,
            remoteId: '100',
            expectedHash: touched.contentHash,
            expectedModifiedAt: touched.modifiedAt,
            html: '<p>Another edit.</p>',
            idempotencyKey: 'idem_edit_touched',
          }),
        ),
      ).toMatchObject({ outcome: 'rejected', code: 'conflict' });
      cms.articles.set('100', touched);
      // Someone edited the article on the site since: the stored hash no longer matches; the refusal carries the
      // current remote so the stored read-back is refreshed (RA-12).
      const changed = { ...cms.articles.get('100')!, html: '<p>Changed on the site.</p>' };
      cms.articles.set('100', { ...changed, contentHash: fixtureArticleHash(changed) });
      const conflict = await inTenant(tenantA, () =>
        destinationArticles.edit({
          tenantId: tenantA,
          destinationId: siteId,
          remoteId: '100',
          expectedHash: edited.outcome === 'done' ? (edited.readback?.contentHash ?? null) : null,
          expectedModifiedAt: edited.outcome === 'done' ? (edited.readback?.modifiedAt ?? null) : null,
          html: '<p>Another edit.</p>',
          idempotencyKey: 'idem_edit_2',
        }),
      );
      expect(conflict).toMatchObject({
        outcome: 'rejected',
        code: 'conflict',
        readback: { remoteId: '100', contentHash: cms.articles.get('100')?.contentHash },
      });
      expect(cms.articles.get('100')?.html).toBe('<p>Changed on the site.</p>');
    });

    it('an edit (RA-12): a site change that lands between the pre-write read and the write is replaced, detected after the write and returned as what was overwritten', async () => {
      const current = cms.articles.get('100')!;
      cms.editInWindow = () => ({ html: '<p>Edited on the site in the window.</p>' });
      const edited = await inTenant(tenantA, () =>
        destinationArticles.edit({
          tenantId: tenantA,
          destinationId: siteId,
          remoteId: '100',
          expectedHash: current.contentHash,
          expectedModifiedAt: current.modifiedAt,
          html: '<p>Written over the window.</p>',
          idempotencyKey: 'idem_edit_window',
        }),
      );
      expect(edited).toMatchObject({
        outcome: 'done',
        readback: { remoteId: '100' },
        readbackVerification: { outcome: 'verified' },
        overwritten: {
          previous: { remoteId: '100', contentHash: current.contentHash, modifiedAt: current.modifiedAt },
          replaced: {
            remoteId: '100',
            contentHash: fixtureArticleHash({ ...current, html: '<p>Edited on the site in the window.</p>' }),
          },
        },
      });
      expect(cms.editInWindow).toBeNull();
      expect(cms.articles.get('100')?.html).toBe('<p>Written over the window.</p>');
    });

    it('an edit with no read-back to compare against is refused before any call: never an overwrite (D-16)', async () => {
      cms.calls.length = 0;
      const refused = await inTenant(tenantA, () =>
        destinationArticles.edit({
          tenantId: tenantA,
          destinationId: siteId,
          remoteId: '100',
          expectedHash: null,
          expectedModifiedAt: null,
          html: '<p>Blind edit.</p>',
          idempotencyKey: 'idem_edit_3',
        }),
      );
      expect(refused).toMatchObject({ outcome: 'rejected', code: 'no_readback' });
      expect(cms.calls).toEqual([]);
      expect(cms.articles.get('100')?.html).toBe('<p>Written over the window.</p>');
    });

    it('unpublish sets the article back to a draft and reads it back; a rendered validation runs without the secret; a disconnected site is refused', async () => {
      cms.articles.set('100', { ...cms.articles.get('100')!, status: 'publish' });
      const reverted = await inTenant(tenantA, () =>
        destinationArticles.unpublish({ tenantId: tenantA, destinationId: siteId, remoteId: '100' }),
      );
      // RA-02: the revert is proven by reading the article back as a draft, not by the write's own answer.
      expect(reverted).toMatchObject({
        outcome: 'done',
        readback: { status: 'draft' },
        readbackVerification: { outcome: 'verified', matched: ['status', 'modifiedAt'], mismatched: [] },
      });
      expect(cms.calls.map((c) => c.op).slice(-2)).toEqual(['update', 'read']);
      cms.calls.length = 0;
      const validation = await inTenant(tenantA, () =>
        destinationArticles.validateRendered({
          tenantId: tenantA,
          destinationId: siteId,
          url: `${SITE}/missing`,
          title: article.title,
          slug: article.slug,
          firstParagraph: 'Ore is heavy.',
          lastParagraph: 'Yes, mostly.',
          draft: false,
        }),
      );
      expect(validation).toMatchObject({ ok: false, status: 404 });
      expect(validation.checks.find((c) => c.key === 'status_ok')?.ok).toBe(false);
      expect(cms.calls).toEqual([]); // no credential was opened for the public page
      await setArticlePolicy(['read']);
      expect(
        await inTenant(tenantA, () =>
          destinationArticles.unpublish({ tenantId: tenantA, destinationId: siteId, remoteId: '100' }),
        ),
      ).toMatchObject({
        outcome: 'rejected',
        code: 'source_use_denied',
      });
      await setArticlePolicy(['read', 'write']);
      const dto = await inTenant(tenantA, () =>
        destinationService.get(owner(), { brandId: brandA, destinationId: siteId }),
      );
      await run(tenantA, (tx) =>
        destinationService.disconnect(
          owner(),
          { brandId: brandA, destinationId: siteId, expectedVersion: dto.version },
          tx,
        ),
      );
      expect(
        await inTenant(tenantA, () =>
          destinationArticles.publish({
            tenantId: tenantA,
            destinationId: siteId,
            publicationId: newId('publication'),
            attemptId: newId('publicationAttempt'),
            idempotencyKey: 'idem_2',
            variant: variant(siteId),
          }),
        ),
      ).toMatchObject({
        outcome: 'rejected',
        code: 'destination_not_usable',
      });
      expect(await verify(siteId)).toEqual({ ok: false, reason: 'not_active' });
    });
  });
});
