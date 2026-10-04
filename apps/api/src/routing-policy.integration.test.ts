import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ModelRoutingPolicy } from '@oremedia/contracts/agents';
import { modelRoutingPolicies } from '@oremedia/db/schema/agents';
import { auditEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { modelConfigFromEnv, modelRegion } from '@oremedia/ai';
import { configureAgentModel } from '@oremedia/module-agents';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src';
import { configureRateLimiter } from './trpc';

/**
 * Spec 12.7 through the tRPC surface: a tenant administrator stores the tenant's model-routing policy with
 * agents.routingPolicy.set, and the model route it forbids is refused for that tenant on the next run start
 * (agents.runs.start checks it before a run is created); another tenant is unaffected. A creator cannot change it,
 * and a stale version is a CONFLICT.
 */
describe('agents.routingPolicy through tRPC (spec 12.7)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  // The model agents.runs.start routes to (configuration, never a literal at a call site).
  const { model, provider } = modelConfigFromEnv();
  const inUse = { provider, model, region: modelRegion() };
  const denyConfigured: ModelRoutingPolicy = {
    schemaVersion: 1,
    defaultModel: `${model}-alt`,
    permittedVendors: ['anthropic', 'fake'],
    permittedRegions: [],
    deniedModels: [model],
  };

  const owner = (t: SeededTenant) => ({ bearer: t.ownerToken, tenantId: t.tenantId });
  const startRun = (t: SeededTenant) =>
    callPath(owner(t), 'agents.runs.start', {
      brandId: t.brandIds[0],
      servicePrincipalId: t.servicePrincipalId,
      requestedAutonomy: 'create',
      taskKind: 'copywriting',
      brief: { objective: 'routing' },
    });
  const routingDenied = { code: 'FORBIDDEN', message: `Model ${model} is not permitted for this company` };

  beforeAll(async () => {
    // The api is told the deployment's route (OREMEDIA_MODEL_PROVIDER, docs/runbooks/deploy-railway.md); it holds no key.
    vi.stubEnv('OREMEDIA_MODEL_PROVIDER', provider);
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await tdb?.drop();
  });

  it('an owner stores a policy and the model route it forbids is refused for that tenant only', async () => {
    const before = await startRun(tenantA);
    expect(before.error?.message).not.toBe(routingDenied.message);
    expect(await callPath(owner(tenantA), 'agents.routingPolicy.get', undefined)).toEqual({
      data: { policy: null, version: null, stored: false, inUse },
    });

    // It refuses the model in use, so it is stored only on the administrator's explicit choice.
    const unconfirmed = await callPath(owner(tenantA), 'agents.routingPolicy.set', {
      policy: denyConfigured,
    });
    expect(unconfirmed.error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(unconfirmed.error?.message).toContain(`Model ${model} is not permitted for this company`);
    expect(
      await tdb.db
        .select()
        .from(modelRoutingPolicies)
        .where(eq(modelRoutingPolicies.tenantId, tenantA.tenantId)),
    ).toEqual([]);
    const set = await callPath(owner(tenantA), 'agents.routingPolicy.set', {
      policy: denyConfigured,
      confirmStopsRuns: true,
    });
    expect(set).toEqual({ data: { policy: denyConfigured, version: 0 } });
    expect(await callPath(owner(tenantA), 'agents.routingPolicy.get', undefined)).toEqual({
      data: { policy: denyConfigured, version: 0, stored: true, inUse },
    });

    expect((await startRun(tenantA)).error).toMatchObject(routingDenied);
    // Tenant B has no stored policy: the platform policy applies and the route is not refused by routing.
    expect((await startRun(tenantB)).error?.message).not.toBe(routingDenied.message);

    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, tenantA.tenantId), eq(auditEvents.action, 'agent.routing_policy.set')),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: tenantA.ownerUserId, resourceId: tenantA.tenantId });
  });

  it('a creator can neither read nor change the policy', async () => {
    const creator = { bearer: tenantB.creatorToken, tenantId: tenantB.tenantId };
    expect(
      (
        await callPath(creator, 'agents.routingPolicy.set', {
          policy: denyConfigured,
          confirmStopsRuns: true,
        })
      ).error,
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect((await callPath(creator, 'agents.routingPolicy.get', undefined)).error).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      await tdb.db
        .select()
        .from(modelRoutingPolicies)
        .where(eq(modelRoutingPolicies.tenantId, tenantB.tenantId)),
    ).toEqual([]);
  });

  it('a change needs the current version: missing is VALIDATION_FAILED, stale is CONFLICT', async () => {
    const permit = { ...denyConfigured, deniedModels: [] };
    expect(
      (await callPath(owner(tenantA), 'agents.routingPolicy.set', { policy: permit })).error,
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      (await callPath(owner(tenantA), 'agents.routingPolicy.set', { policy: permit, expectedVersion: 5 }))
        .error,
    ).toMatchObject({ code: 'CONFLICT' });
    expect((await startRun(tenantA)).error).toMatchObject(routingDenied); // unchanged
    expect(
      await callPath(owner(tenantA), 'agents.routingPolicy.set', { policy: permit, expectedVersion: 0 }),
    ).toEqual({ data: { policy: permit, version: 1 } });
    expect((await startRun(tenantA)).error?.message).not.toBe(routingDenied.message);
  });

  it('a policy that drops the only configured gateway is refused unless confirmed (an OpenRouter deployment)', async () => {
    // The staging and production shape: worker-core routes through OpenRouter; a form default listing only
    // Anthropic must not be stored silently. The service's route is pinned as the composition would read it.
    configureAgentModel({ ...modelConfigFromEnv(), provider: 'openrouter', model: 'vendor/model-x' });
    try {
      const anthropicOnly: ModelRoutingPolicy = {
        schemaVersion: 1,
        defaultModel: 'vendor/model-x',
        permittedVendors: ['anthropic'],
        permittedRegions: [],
        deniedModels: [],
      };
      const got = await callPath(owner(tenantB), 'agents.routingPolicy.get', undefined);
      expect(got.data).toMatchObject({
        stored: false,
        inUse: { provider: 'openrouter', model: 'vendor/model-x' },
      });
      const refused = await callPath(owner(tenantB), 'agents.routingPolicy.set', { policy: anthropicOnly });
      expect(refused.error).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(refused.error?.message).toContain('Model vendor openrouter is not permitted for this company');
      const permitted = { ...anthropicOnly, permittedVendors: ['openrouter' as const] };
      expect(await callPath(owner(tenantB), 'agents.routingPolicy.set', { policy: permitted })).toEqual({
        data: { policy: permitted, version: 0 },
      });
    } finally {
      configureAgentModel(null);
    }
  });

  it('an api that is not told the deployment’s route reports no model in use rather than the built-in default', async () => {
    vi.stubEnv('OREMEDIA_MODEL_PROVIDER', '');
    try {
      expect((await callPath(owner(tenantB), 'agents.routingPolicy.get', undefined)).data).toMatchObject({
        inUse: null,
      });
    } finally {
      vi.stubEnv('OREMEDIA_MODEL_PROVIDER', provider);
    }
  });
});
