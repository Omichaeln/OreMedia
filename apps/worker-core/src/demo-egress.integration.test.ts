import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ModelRequest } from '@oremedia/contracts/agents';
import { DemoRefusedError } from '@oremedia/contracts/errors';
import { runInTenant, type TenantContext } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { AnthropicModelAdapter, OpenRouterModelAdapter } from '@oremedia/ai';
import { configureGoogleFonts, fetchGoogleFontFiles } from '@oremedia/module-assets';
import { tenantKindResolverConfigured } from '@oremedia/module-operations';
import { egressGuardConfigured } from '@oremedia/providers';
import { FixtureServer, fixtureIO } from '@oremedia/providers/testing/fixture-server';
import { composeModules } from './composition';

/**
 * Demo workspace stage 2 (architecture §4.4): the egress guards at the choke points every outbound call passes, as
 * worker-core wires them. A demo company's request is refused before any socket opens (the fixture server records
 * ZERO requests); a live company's request, and a platform call outside any tenant, go out unchanged; a tenant whose
 * kind cannot be read is refused (fail-closed).
 */
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: 'usr_demo_egress' },
  brandIds: 'all',
  correlationId: 'corr_demo_egress',
});

const chat: ModelRequest = {
  model: 'test-model',
  system: 'SYSTEM',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Begin.' }] }],
  tools: [],
  maxOutputTokens: 64,
  timeoutMs: 5000,
  metadata: { runId: 'run_demo_egress', tenantId: 'unused' },
};

const chatAnswer = {
  request: { method: 'POST', path: '/chat/completions' },
  response: {
    status: 200,
    json: {
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  },
  repeat: true,
};

const tenantId = () => `ten_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

const noEgress = { code: 'FORBIDDEN', reason: 'demo_no_egress', details: [{ issue: 'demo_no_egress' }] };

describe('demo workspace egress guards (worker-core composition)', () => {
  let tdb: TestDatabase;
  let server: FixtureServer;
  const live = tenantId();
  const demo = tenantId();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: live, name: 'Live', slug: 'eg-live-' + live.slice(-6).toLowerCase() },
      { id: demo, name: 'Demo', slug: 'eg-demo-' + demo.slice(-6).toLowerCase(), kind: 'demo' },
    ]);
    composeModules();
    server = await new FixtureServer().start();
  });
  afterAll(async () => {
    await server?.stop();
    await tdb?.drop();
  });
  beforeEach(() => {
    server.load({ exchanges: [chatAnswer, { request: { method: 'GET', path: '/v1/me' }, repeat: true }] });
  });

  it('the composition root wires the provider egress guard and the outbox kind resolver', () => {
    expect(egressGuardConfigured()).toBe(true);
    expect(tenantKindResolverConfigured()).toBe(true);
  });

  it('provider I/O (createProviderIO): a demo company sends nothing; a live one is unchanged; an unknown tenant is refused', async () => {
    const demoIO = await fixtureIO(server, { providerKey: 'linkedin_page', tenantId: demo });
    await expect(
      demoIO.request('https://api.linkedin.com/v1/me', {}, { mutation: false }),
    ).rejects.toBeInstanceOf(DemoRefusedError);
    await expect(
      demoIO.request('https://api.linkedin.com/v1/me', { method: 'POST' }, { mutation: true }),
    ).rejects.toMatchObject(noEgress);
    const unknownIO = await fixtureIO(server, { providerKey: 'linkedin_page', tenantId: tenantId() });
    await expect(
      unknownIO.request('https://api.linkedin.com/v1/me', {}, { mutation: false }),
    ).rejects.toThrow();
    expect(server.requests).toHaveLength(0);

    const liveIO = await fixtureIO(server, { providerKey: 'linkedin_page', tenantId: live });
    const { res } = await liveIO.request('https://api.linkedin.com/v1/me', {}, { mutation: false });
    expect(res.status).toBe(204);
    expect(server.requests).toHaveLength(1);
  });

  it('the model gateway (openRouterFetch): a demo company’s call is refused before any socket; live and platform calls go out', async () => {
    const adapter = new OpenRouterModelAdapter({ apiKey: 'test-key', baseURL: server.baseUrl });
    await expect(runInTenant(ctx(demo), () => adapter.complete(chat))).rejects.toMatchObject(noEgress);
    expect(server.requests).toHaveLength(0);

    const liveAnswer = await runInTenant(ctx(live), () => adapter.complete(chat));
    expect(liveAnswer.stopReason).toBe('end_turn');
    expect(server.requests).toHaveLength(1);
    await adapter.complete(chat); // no tenant context: a platform call
    expect(server.requests).toHaveLength(2);
  });

  it('the direct Anthropic adapter: a demo company’s call is refused before the SDK sends anything', async () => {
    const adapter = new AnthropicModelAdapter({ apiKey: 'test-key', baseURL: server.baseUrl });
    await expect(runInTenant(ctx(demo), () => adapter.complete(chat))).rejects.toMatchObject(noEgress);
    expect(server.requests).toHaveLength(0);
    // A live company's call reaches the (fixture) API: whatever it answers, the request was made.
    await runInTenant(ctx(live), () => adapter.complete(chat)).catch(() => undefined);
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it('the Google Fonts fetch: a demo company downloads nothing', async () => {
    configureGoogleFonts({
      cssOrigin: server.baseUrl,
      fontOrigin: server.baseUrl,
      insecureAllowLoopback: true,
    });
    try {
      await expect(
        runInTenant(ctx(demo), () =>
          fetchGoogleFontFiles({ family: 'Lato', weights: [400], styles: ['normal'] }),
        ),
      ).rejects.toMatchObject(noEgress);
      expect(server.requests).toHaveLength(0);
      // A live company's import reaches the (fixture) origin; the fixture has no stylesheet, so it fails after.
      await runInTenant(ctx(live), () =>
        fetchGoogleFontFiles({ family: 'Lato', weights: [400], styles: ['normal'] }),
      ).catch(() => undefined);
      expect(server.requests.length).toBeGreaterThan(0);
    } finally {
      configureGoogleFonts({});
    }
  });
});
