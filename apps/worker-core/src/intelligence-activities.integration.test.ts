import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { BrandAnalystWorkflowInputV1 } from '@oremedia/contracts/intelligence';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ResolvedSkill } from '@oremedia/contracts/skills';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, servicePrincipals, tenants, users } from '@oremedia/db/schema/access';
import { agentRuns } from '@oremedia/db/schema/agents';
import { brands } from '@oremedia/db/schema/brand';
import { insights } from '@oremedia/db/schema/intelligence';
import { featureFlags, outboxEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  registerSkillResolver,
  resetRoutingPolicies,
  resetSkillResolver,
  setTenantRoutingPolicy,
} from '@oremedia/ai';
import { createAnalystSweepActivities, createBrandAnalystActivities } from '@oremedia/activities';
import { configureAgentModel } from '@oremedia/module-agents';
import { assetService } from '@oremedia/module-assets';
import { brandService, registerBrandAssetKindSource } from '@oremedia/module-brand';
import { createIntelligenceRuntime } from '@oremedia/module-intelligence';
import { composeModules } from './composition';

/**
 * Ledger G21: brandAnalystWorkflowV1's activity hosts and the weekly sweep's, built from the production factories
 * over the real intelligence runtime with the worker-core composition (the measurement module behind the metrics
 * hook, the analyst target source, the agents module starting the run), against MySQL. The analyst runs as its
 * tenant's service principal re-resolved now; a foreign tenant, a foreign brand or a revoked principal is refused
 * non-retryably before anything is written; the movements and the performance-review run are written once (a
 * retried prepareAnalysis reuses both); the sweep lists references across tenants and writes nothing.
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

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  voice: { ...emptyBrandSystemDocument().voice, summary: 'Plain', tone: ['plain'], prohibitedPhrases: [] },
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
    ],
    typeRoles: [
      { role: 'display', fontAssetId: 'ast_font', weight: 600, minSizePx: 40 },
      { role: 'heading', fontAssetId: 'ast_font', weight: 600, minSizePx: 28 },
      { role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 18 },
      { role: 'label', fontAssetId: 'ast_font', weight: 500, minSizePx: 14 },
      { role: 'caption', fontAssetId: 'ast_font', weight: 400, minSizePx: 12 },
    ],
    spacingScale: [4, 8, 16],
    radii: [0, 4],
    contrastTarget: 'AA',
  },
});
const performanceReview: ResolvedSkill = {
  skillVersionId: 'sv_01HTESTSKILL0000000000000000',
  skillId: 'skl_01HTESTSKILL000000000000000',
  key: 'performance-review',
  versionNumber: 1,
  manifest: {
    schemaVersion: 1,
    key: 'performance-review',
    title: 'Performance review',
    description: 'test',
    taskKinds: ['performance_review'],
    inputSchema: {},
    outputSchema: { type: 'object' },
    requiredContext: ['brand_snapshot'],
    allowedTools: ['brand.getSnapshot', 'metrics.query', 'recommendations.create'],
    budgets: {
      maxSteps: 6,
      maxTokens: 100_000,
      maxCostMicros: 2_000_000,
      maxVariants: 3,
      deadlineSeconds: 900,
    },
    modelCompatibility: [],
    instructionsPath: 'SKILL.md',
  },
  instructions: 'Review the period and propose.',
  references: [],
};

describe('brand analyst and analyst sweep activity hosts (worker-core composition) against MySQL (ledger G21)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const tenantB = newId('ten');
  const brandA = newId('brd');
  const brandA2 = newId('brd');
  const brandB = newId('brd');
  const spA = newId('sp');
  const spRevoked = newId('sp');
  const spB = newId('sp');
  const manager = { id: newId('usr'), membershipId: newId('mem') };
  const managerB = { id: newId('usr'), membershipId: newId('mem') };
  const managerActor: ResolvedActor = {
    kind: 'user',
    id: manager.id,
    tenantId: tenantA,
    membershipId: manager.membershipId,
    membershipStatus: 'active',
    role: 'brand_manager',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  };
  const analystGrants = [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'insight.read', brandIds: 'all' },
    { action: 'insight.manage', brandIds: 'all' },
    { action: 'agent.start_run', brandIds: 'all' },
  ] as const;
  const runtime = createIntelligenceRuntime();
  const analystActs = createBrandAnalystActivities(runtime.analyst);
  const sweepActs = createAnalystSweepActivities(runtime.sweep);
  const periodStart = '2026-09-17T00:00:00.000Z';
  const periodEnd = '2026-09-24T00:00:00.000Z';
  const input = (over: Partial<BrandAnalystWorkflowInputV1> = {}): BrandAnalystWorkflowInputV1 => ({
    tenantId: tenantA,
    actor: { kind: 'service_principal', id: over.servicePrincipalId ?? spA },
    correlationId: 'corr_analyst_acts',
    brandId: brandA,
    servicePrincipalId: spA,
    periodStart,
    periodEnd,
    ...over,
  });
  const ctx = (actor: TenantContext['actor']): TenantContext => ({
    tenantId: tenantA,
    actor,
    brandIds: 'all',
    correlationId: 'corr_analyst_acts',
  });
  const asManager = <T>(fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx({ kind: 'user', id: manager.id }), () => withTransaction(fn));
  const movementsOf = (brandId: string) =>
    tdb.db
      .select()
      .from(insights)
      .where(and(eq(insights.brandId, brandId), eq(insights.periodEnd, new Date(periodEnd))));
  const reviewRunsOf = async (brandId: string) =>
    (await tdb.db.select().from(agentRuns).where(eq(agentRuns.brandId, brandId))).filter(
      (r) => r.taskKind === 'performance_review',
    );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    composeModules();
    // The brand document names the placeholder font ast_font (no asset rows are seeded): the composed asset source
    // is told it is one, so the version publishes (an agent run resolves the brand's published version).
    registerBrandAssetKindSource(async (brandId, ids, tx) => {
      const kinds = await assetService.kindsForBrand(brandId, ids, tx);
      if (ids.includes('ast_font')) kinds.set('ast_font', 'font');
      return kinds;
    });
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'analyst-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'analyst-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    await tdb.db.insert(users).values([
      { id: manager.id, email: `analyst-${manager.id.slice(-6).toLowerCase()}@example.test`, name: 'M' },
      { id: managerB.id, email: `analyst-${managerB.id.slice(-6).toLowerCase()}@example.test`, name: 'MB' },
    ]);
    await tdb.db.insert(memberships).values([
      {
        id: manager.membershipId,
        tenantId: tenantA,
        userId: manager.id,
        role: 'brand_manager',
        status: 'active',
        allBrands: true,
      },
      {
        id: managerB.membershipId,
        tenantId: tenantB,
        userId: managerB.id,
        role: 'brand_manager',
        status: 'active',
        allBrands: true,
      },
    ]);
    await tdb.db.insert(servicePrincipals).values([
      {
        id: spA,
        tenantId: tenantA,
        kind: 'agent',
        name: 'analyst',
        grants: [...analystGrants],
        maxAutonomy: 'create',
        status: 'active',
        createdByUserId: manager.id,
      },
      {
        id: spRevoked,
        tenantId: tenantA,
        kind: 'agent',
        name: 'retired analyst',
        grants: [...analystGrants],
        maxAutonomy: 'create',
        status: 'revoked',
        createdByUserId: manager.id,
      },
      // Tenant B's agent cannot start runs: tenant B has no analyst target.
      {
        id: spB,
        tenantId: tenantB,
        kind: 'agent',
        name: 'reader',
        grants: [{ action: 'brand.read', brandIds: 'all' }],
        maxAutonomy: 'create',
        status: 'active',
        createdByUserId: managerB.id,
      },
    ]);
    await tdb.db.insert(featureFlags).values({
      key: 'intelligence.brand_analyst',
      enabledDefault: false,
      targeting: { tenantIds: [tenantA] },
      owner: 'intelligence',
      removalDate: new Date('2027-03-31T00:00:00Z'),
      successMetric: 'test',
    });
    const draft = await asManager((tx) =>
      brandService.versions.createDraft(managerActor, { brandId: brandA }, tx),
    );
    await asManager((tx) =>
      brandService.versions.update(
        managerActor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 0, document: brandDocument() },
        tx,
      ),
    );
    await asManager((tx) =>
      brandService.versions.submitForReview(
        managerActor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 1 },
        tx,
      ),
    );
    await asManager((tx) =>
      brandService.versions.publish(
        managerActor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 2 },
        tx,
      ),
    );
    await asManager((tx) =>
      brandService.objectives.set(
        managerActor,
        {
          brandId: brandA,
          name: 'Qualified enquiries',
          primaryMetricKey: 'qualified_enquiries',
          guardrailMetricKeys: ['complaints'],
          activeFrom: '2026-01-01T00:00:00.000Z',
        },
        tx,
      ),
    );
    registerSkillResolver(async () => [performanceReview]);
    setTenantRoutingPolicy(tenantA, {
      schemaVersion: 1,
      defaultModel: 'fake-model',
      permittedVendors: ['fake', 'anthropic'],
      permittedRegions: [],
      deniedModels: [],
    });
    configureAgentModel({
      provider: 'fake',
      model: 'fake-model',
      maxOutputTokens: 1024,
      timeoutMs: 1000,
      inputMicrosPerMillionTokens: 1,
      outputMicrosPerMillionTokens: 1,
    });
  });
  afterAll(async () => {
    resetSkillResolver();
    resetRoutingPolicies();
    configureAgentModel(null);
    await tdb?.drop();
  });

  describe('createBrandAnalystActivities (brandAnalystWorkflowV1)', () => {
    it('a foreign tenant, a foreign brand or a revoked principal is refused before anything is written', async () => {
      for (const bad of [
        input({ tenantId: tenantB }), // tenant A's principal claimed in tenant B
        input({ brandId: brandB }), // tenant B's brand from tenant A
        input({ servicePrincipalId: spRevoked }), // the principal was revoked since the schedule fired
        input({ servicePrincipalId: spB }), // tenant B's principal named in tenant A
      ])
        expect(await refusal(analystActs.prepareAnalysis(bad))).toEqual({
          type: 'PolicyDenied',
          nonRetryable: true,
        });
      expect(await movementsOf(brandA)).toEqual([]);
      expect(await movementsOf(brandB)).toEqual([]);
      expect(await reviewRunsOf(brandA)).toEqual([]);
      expect(await reviewRunsOf(brandB)).toEqual([]);
    });

    it('writes the movements and starts the review run as the principal in its tenant; a retried prepareAnalysis reuses both', async () => {
      const prepared = await analystActs.prepareAnalysis(input());
      expect(prepared.skippedReason).toBeNull();
      expect(prepared.runId).toBeTruthy();
      expect(prepared.changeInsightIds).toHaveLength(2);
      const movements = await movementsOf(brandA);
      expect(movements.map((m) => m.id).sort()).toEqual([...prepared.changeInsightIds].sort());
      expect(movements.every((m) => m.tenantId === tenantA && m.agentRunId === null)).toBe(true);
      // No publications in the window: missing is never zero, the statements say there is a data gap.
      expect(movements.every((m) => m.statement.includes('data gap'))).toBe(true);
      expect(movements.every((m) => m.evidence.at(-1)?.ref === prepared.runId)).toBe(true);
      const [run] = await reviewRunsOf(brandA);
      expect(run).toMatchObject({
        id: prepared.runId,
        tenantId: tenantA,
        servicePrincipalId: spA,
        autonomyMode: 'assist',
      });
      const requested = await tdb.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.aggregateId, prepared.runId!)));
      expect(requested.map((e) => e.eventType)).toContain('agent.run_requested');
      // Temporal retries the activity (maximumAttempts 5): the same movements, the same run, nothing written twice.
      expect(await analystActs.prepareAnalysis(input())).toEqual(prepared);
      expect((await movementsOf(brandA)).map((m) => m.id).sort()).toEqual(
        [...prepared.changeInsightIds].sort(),
      );
      expect((await reviewRunsOf(brandA)).map((r) => r.id)).toEqual([prepared.runId]);
      expect(
        (
          await tdb.db
            .select()
            .from(outboxEvents)
            .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.aggregateId, prepared.runId!)))
        ).filter((e) => e.eventType === 'agent.run_requested'),
      ).toHaveLength(1);

      // readAnalystRun and recordAnalystOutcome in the same context; a replayed record reports the same.
      const read = await analystActs.readAnalystRun({ ...input(), runId: prepared.runId! });
      expect(read.terminal).toBe(false);
      const outcome = {
        ...input(),
        runId: prepared.runId,
        runState: 'completed',
        changeInsightIds: prepared.changeInsightIds,
      };
      const recorded = await analystActs.recordAnalystOutcome(outcome);
      expect(recorded).toMatchObject({ insights: 2, recommendations: 0, rankingPolicy: 'baseline' });
      expect(await analystActs.recordAnalystOutcome(outcome)).toEqual(recorded);
      expect(await movementsOf(brandA)).toHaveLength(2);
      // The run and the record are refused across tenants like the preparation.
      expect(
        await refusal(
          analystActs.readAnalystRun({ ...input({ tenantId: tenantB }), runId: prepared.runId! }),
        ),
      ).toEqual({ type: 'PolicyDenied', nonRetryable: true });
      expect(await refusal(analystActs.recordAnalystOutcome({ ...outcome, tenantId: tenantB }))).toEqual({
        type: 'PolicyDenied',
        nonRetryable: true,
      });
    });

    it('a brand without an active objective is skipped: no movement, no run', async () => {
      expect(await analystActs.prepareAnalysis(input({ brandId: brandA2 }))).toMatchObject({
        runId: null,
        skippedReason: 'no_active_objective',
        changeInsightIds: [],
      });
      expect(await movementsOf(brandA2)).toEqual([]);
      expect(await reviewRunsOf(brandA2)).toEqual([]);
    });
  });

  describe('createAnalystSweepActivities (brandAnalystSweepWorkflowV1)', () => {
    it('lists every active brand of a tenant with an analyst principal, across tenants, references only; writes nothing and a replay lists the same', async () => {
      const countRows = async () => ({
        insights: (await tdb.db.select().from(insights)).length,
        runs: (await tdb.db.select().from(agentRuns)).length,
        outbox: (await tdb.db.select().from(outboxEvents)).length,
      });
      const before = await countRows();
      const sweepInput = { correlationId: 'corr_analyst_sweep', now: new Date().toISOString() };
      const targets = await sweepActs.listAnalystTargets(sweepInput);
      // Tenant A's active principal grants agent.start_run and insight.manage (the revoked one is never chosen);
      // tenant B's agent cannot start runs, so its brand is no target.
      expect([...targets].sort((a, b) => a.brandId.localeCompare(b.brandId))).toEqual(
        [
          { tenantId: tenantA, brandId: brandA, servicePrincipalId: spA },
          { tenantId: tenantA, brandId: brandA2, servicePrincipalId: spA },
        ].sort((a, b) => a.brandId.localeCompare(b.brandId)),
      );
      expect(await sweepActs.listAnalystTargets(sweepInput)).toEqual(targets);
      expect(await countRows()).toEqual(before);
    });
  });
});
