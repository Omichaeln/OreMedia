import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runAsPlatform } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  UserDirectory,
  accessService,
  authenticate,
  resolveTenantContext,
  tenantKinds,
} from '@oremedia/module-access';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src';
import { configureRateLimiter } from './trpc';

/**
 * Demo workspace stage 1: every company has a kind, `live` unless a system path created it as a `demo`. The kind is
 * fixed at creation (no request can choose it, nothing updates it), and it reaches tenant resolution and the company
 * list, so later stages can key server-side behaviour on it.
 */
describe('tenant kind (live or demo)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let demoTenantId = '';
  const correlationId = () => `test-${randomUUID()}`;
  const kindOf = async (tenantId: string) =>
    (await tdb.db.select().from(tenants).where(eq(tenants.id, tenantId)))[0]?.kind;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA } = await seedTwoTenants(tdb.db));
    ({ tenantId: demoTenantId } = await accessService.createTenantWithOwner(
      { name: 'Demo workspace', slug: `demo-${randomUUID().slice(0, 8)}` },
      tenantA.ownerUserId,
      correlationId(),
      undefined,
      'demo',
    ));
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('every company is live unless created as a demo, and a request cannot choose the kind', async () => {
    expect(await kindOf(tenantA.tenantId)).toBe('live');
    const email = `owner-${randomUUID().slice(0, 8)}@example.test`;
    const created = await accessService.bootstrapOwner(
      {
        email,
        name: 'New owner',
        // Not part of TenantCreate: stripped by the contract, so sign-up always makes a live company.
        tenant: { name: 'New', slug: `new-${randomUUID().slice(0, 8)}`, kind: 'demo' } as {
          name: string;
          slug: string;
        },
      },
      correlationId(),
    );
    expect(await kindOf(created.tenantId)).toBe('live');
  });

  it('access.listCompanies reports each company’s kind', async () => {
    const res = await callPath({ bearer: tenantA.ownerToken }, 'access.listCompanies', undefined);
    const companies = res.data as Array<{ tenantId: string; kind: string }>;
    expect(companies.find((c) => c.tenantId === tenantA.tenantId)?.kind).toBe('live');
    expect(companies.find((c) => c.tenantId === demoTenantId)?.kind).toBe('demo');
  });

  it('tenant resolution carries the kind for a person and for an API key; tenantKinds reads it', async () => {
    const person = {
      kind: 'user' as const,
      userId: tenantA.ownerUserId,
      sessionId: 'ses_unused',
      selectedTenantId: null,
    };
    expect((await resolveTenantContext(person, demoTenantId, correlationId())).tenantKind).toBe('demo');
    expect((await resolveTenantContext(person, tenantA.tenantId, correlationId())).tenantKind).toBe('live');
    const key = await authenticate(tenantA.apiClientKey);
    expect(key?.kind).toBe('api_client');
    expect((await resolveTenantContext(key!, undefined, correlationId())).tenantKind).toBe('live');
    expect(await tenantKinds.of(demoTenantId, correlationId())).toBe('demo');
    expect(await tenantKinds.of(tenantA.tenantId, correlationId())).toBe('live');
    await expect(tenantKinds.of('ten_UNKNOWN', correlationId())).rejects.toThrow();
  });

  it('nothing changes the kind after creation: closing the company (tenant deletion) keeps it', async () => {
    const { tenantId } = await accessService.createTenantWithOwner(
      { name: 'Demo to close', slug: `demo-${randomUUID().slice(0, 8)}` },
      tenantA.creatorUserId,
      correlationId(),
      undefined,
      'demo',
    );
    await runAsPlatform('deletion', correlationId(), () => new UserDirectory().closeTenant(tenantId));
    const [row] = await tdb.db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(row).toMatchObject({ status: 'closing', kind: 'demo' });
    expect(await kindOf(tenantA.tenantId)).toBe('live');
  });
});
