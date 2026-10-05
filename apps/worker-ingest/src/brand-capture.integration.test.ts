import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brandSources, brands } from '@oremedia/db/schema/brand';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  brandAssistService,
  configureSourceCapture,
  createBrandAssistRuntime,
  registerAssistModelGate,
} from '@oremedia/module-brand';
import { configureEgressGuard, egressGuardConfigured } from '@oremedia/providers';
import { composeModules } from './composition';

/**
 * Demo workspace stage 2: brand-source URL capture runs on worker-ingest (ingest-metrics). With worker-ingest's
 * composition (the egress guard wired to the tenant kind), a live company's capture through the runtime the worker
 * builds still reaches the website: the guard lets live companies through and only refuses demo ones.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const USER = newId('usr');

describe('brand-source capture through worker-ingest composition (live company)', () => {
  let tdb: TestDatabase;
  let site: Server;
  let base = '';
  const hits: string[] = [];
  const tenantId = newId('ten');
  const brandId = newId('brd');
  const ctx: TenantContext = {
    tenantId,
    actor: { kind: 'user', id: USER },
    brandIds: 'all',
    correlationId: 'c',
  };
  const actor: ResolvedActor = {
    kind: 'user',
    id: USER,
    tenantId,
    membershipId: 'mem_capture',
    membershipStatus: 'active',
    role: 'brand_manager',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  };
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx, () => withTransaction(fn));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    site = http.createServer((req, res) => {
      hits.push(req.url ?? '/');
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><head><title>Live Co</title></head><body><main>We roast coffee.</main></body></html>',
        );
      } else res.writeHead(404).end('not found');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    configureEgressGuard(null);
    composeModules({ COMMENT_AUTHOR_HASH_SECRET_REF: 'capture-author-secret' });
    configureSourceCapture({ insecureAllowLoopback: true });
    registerAssistModelGate({
      describe: () => ({
        provider: 'fake',
        model: 'scripted',
        maxOutputTokens: 4000,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      }),
      assertRouting: async () => {},
    });
    await tdb.db
      .insert(tenants)
      .values({ id: tenantId, name: 'Live', slug: 'cap-' + tenantId.slice(-6).toLowerCase() });
    await tdb.db.insert(users).values({ id: USER, email: `cap-${USER}@example.test`, name: 'Capture' });
    await tdb.db.insert(memberships).values({
      id: newId('mem'),
      tenantId,
      userId: USER,
      role: 'brand_manager',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(brands).values({
      id: brandId,
      tenantId,
      name: 'Live Co',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
  });
  afterAll(async () => {
    configureSourceCapture({});
    registerAssistModelGate(null);
    await new Promise<void>((r) => site?.close(() => r()));
    await tdb?.drop();
  });

  it('captures the live company’s website through the composed runtime', async () => {
    expect(egressGuardConfigured()).toBe(true);
    const source = await run((tx) =>
      brandAssistService.sources.add(actor, { kind: 'url', brandId, url: `${base}/` }, tx),
    );
    const job = await run((tx) =>
      brandAssistService.assist.start(
        actor,
        { brandId, kind: 'setup', sections: ['voice'], sourceIds: [source.sourceId] },
        tx,
      ),
    );
    const rt = createBrandAssistRuntime();
    const input = {
      tenantId,
      actor: { kind: 'user' as const, id: USER },
      correlationId: 'c',
      brandId,
      jobId: job.jobId,
    };
    await runInTenant(ctx, () => rt.beginBrandAssist(input));
    const result = await runInTenant(ctx, () =>
      rt.captureBrandSourceUrl({ ...input, sourceId: source.sourceId }),
    );
    expect(result).toMatchObject({ sourceId: source.sourceId, status: 'captured' });
    expect(hits).toContain('/');
    const [row] = await tdb.db.select().from(brandSources).where(eq(brandSources.id, source.sourceId));
    expect(row?.text).toContain('We roast coffee.');
  });
});
