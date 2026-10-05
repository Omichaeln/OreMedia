import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DemoRefusedError } from '@oremedia/contracts/errors';
import { tenants } from '@oremedia/db/schema/access';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { configureEgressGuard, egressGuardConfigured } from '@oremedia/providers';
import { FixtureServer, fixtureIO } from '@oremedia/providers/testing/fixture-server';
import { composeModules } from './composition';

/**
 * Demo workspace (architecture §4.4) as worker-render composes it: the media worker's brand assist runtime carries
 * provider I/O, so worker-render wires the egress guard. A live company's request goes out (an unwired guard would
 * refuse it in production); a demo company's request never leaves the process.
 */
const newTenantId = () => `ten_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

describe('worker-render composition: provider egress guard', () => {
  let tdb: TestDatabase;
  let server: FixtureServer;
  const live = newTenantId();
  const demo = newTenantId();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: live, name: 'Live', slug: 'wr-live-' + live.slice(-6).toLowerCase() },
      { id: demo, name: 'Demo', slug: 'wr-demo-' + demo.slice(-6).toLowerCase(), kind: 'demo' },
    ]);
    configureEgressGuard(null);
    composeModules();
    server = await new FixtureServer().start();
    server.load({ exchanges: [{ request: { method: 'GET', path: '/' }, repeat: true }] });
  });
  afterAll(async () => {
    await server?.stop();
    await tdb?.drop();
  });

  it('wires the guard: a live company reaches the site, a demo company sends nothing', async () => {
    expect(egressGuardConfigured()).toBe(true);
    const demoIO = await fixtureIO(server, { providerKey: 'brand_source', tenantId: demo });
    await expect(demoIO.request('https://www.example.com/', {}, { mutation: false })).rejects.toBeInstanceOf(
      DemoRefusedError,
    );
    expect(server.requests).toHaveLength(0);
    const liveIO = await fixtureIO(server, { providerKey: 'brand_source', tenantId: live });
    const { res } = await liveIO.request('https://www.example.com/', {}, { mutation: false });
    expect(res.status).toBe(204);
    expect(server.requests).toHaveLength(1);
  });
});
