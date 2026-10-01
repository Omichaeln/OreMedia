import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { sourceUsePolicies } from '@oremedia/db/schema/destinations';
import { auditEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { destinationService, sourceUsePolicyService } from './service';

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

  it('a remote identity is registered once per tenant, whichever brand asks', async () => {
    await expect(
      run(tenantA, (tx) =>
        destinationService.register(
          owner(),
          { brandId: brandA2, kind: 'ga4_property', externalId: 'properties/1001', displayName: 'Again' },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
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
      destinationKind = 'ga4_property' as const,
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
});
