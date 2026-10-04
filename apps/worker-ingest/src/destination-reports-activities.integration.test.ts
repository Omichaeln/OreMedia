import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { brandDestinations, destinationReportRows } from '@oremedia/db/schema/destinations';
import { auditEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { DESTINATION_REPORTS_ACTOR, createDestinationReportActivities } from '@oremedia/activities';
import {
  FixtureSourceAdapter,
  configureDestinationSources,
  configureSourceActivation,
  createDestinationRuntime,
  destinationService,
  sourceUsePolicyService,
} from '@oremedia/module-destinations';
import { LocalKms, configureCredentialBroker, registerProviderClients } from '@oremedia/module-publishing';
import { SourceRegistry, type SourceReportRow } from '@oremedia/providers';

/**
 * Ledger G21: the report sweep's activity hosts (destinationReportSweepWorkflowV1 and destinationReportsWorkflowV1
 * on `ingest-metrics`), built from the production factory over the real report runtime (one per process, as
 * ingest-worker.ts composes it), against MySQL and the fixture Search Console source. The target listing is
 * platform-level and writes nothing; every other activity runs in its destination's tenant as the platform job;
 * a foreign destination is refused non-retryably before any policy, credential or row is read; the outcome is
 * written (report rows, health, audit) and a replayed call causes no second effect.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const NOW = '2026-09-29T04:00:00.000Z';
const day = (offsetFromSep28: number) =>
  new Date(Date.parse('2026-09-28T00:00:00.000Z') + offsetFromSep28 * 86_400_000).toISOString().slice(0, 10);

/** Search Console rows: two queries per day over the last 40 days. */
function gscQueries(): SourceReportRow[] {
  const rows: SourceReportRow[] = [];
  for (let i = -39; i <= 0; i++) {
    rows.push({
      date: day(i),
      dimensions: { query: 'acme login' },
      metrics: { clicks: 30, impressions: 100, ctr: 0.3, position: 1.2 },
    });
    rows.push({
      date: day(i),
      dimensions: { query: 'acme pricing' },
      metrics: { clicks: 2, impressions: 200, ctr: 0.01, position: 8 },
    });
  }
  return rows;
}

const refusal = async (p: Promise<unknown>) => {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { name?: string; type?: string; nonRetryable?: boolean } | null;
  expect(err?.name).toBe('ApplicationFailure');
  return { type: err?.type, nonRetryable: err?.nonRetryable };
};

describe('destination report activity hosts (worker-ingest) against MySQL and the fixture source (ledger G21)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const tenantB = newId('ten');
  const brandA = newId('brd');
  const brandB = newId('brd');
  const userA = newId('usr');
  const userB = newId('usr');
  const membershipA = newId('mem');
  const membershipB = newId('mem');
  const source = new FixtureSourceAdapter('search_console_site');
  const acts = createDestinationReportActivities(createDestinationRuntime().reports);
  let siteA = '';
  let siteB = '';

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
    correlationId: 'corr_report_acts',
  });
  const run = <T>(tenantId: string, userId: string, fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx(tenantId, userId), () => withTransaction(fn));
  const input = (tenantId: string, destinationId: string) => ({
    tenantId,
    actor: DESTINATION_REPORTS_ACTOR,
    correlationId: 'corr_report_acts',
    destinationId,
    now: NOW,
  });
  const storedRows = (destinationId: string) =>
    tdb.db.select().from(destinationReportRows).where(eq(destinationReportRows.destinationId, destinationId));
  const destinationRow = async (id: string) =>
    (await tdb.db.select().from(brandDestinations).where(eq(brandDestinations.id, id)))[0]!;
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
  const connect = async (tenantId: string, userId: string, brandId: string, externalId: string) => {
    source.targets = [{ externalId, displayName: externalId }];
    const actor = owner(tenantId, userId);
    const started = await run(tenantId, userId, (tx) =>
      destinationService.connect.start(
        actor,
        { brandId, kind: 'search_console_site', redirectUri: 'https://app.example/connect/callback' },
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
  const allowReads = (tenantId: string, userId: string, brandId: string) =>
    run(tenantId, userId, (tx) =>
      sourceUsePolicyService.set(
        owner(tenantId, userId),
        {
          brandId,
          destinationKind: 'search_console_site',
          dataType: 'gsc.reports',
          allowedUses: ['read'],
          reviewDueAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
        },
        tx,
      ),
    );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'report-acts-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'report-acts-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values([
      { id: userA, email: `report-acts-${userA.slice(-6).toLowerCase()}@example.test`, name: 'A' },
      { id: userB, email: `report-acts-${userB.slice(-6).toLowerCase()}@example.test`, name: 'B' },
    ]);
    await tdb.db.insert(memberships).values([
      { id: membershipA, tenantId: tenantA, userId: userA, role: 'owner', status: 'active', allBrands: true },
      { id: membershipB, tenantId: tenantB, userId: userB, role: 'owner', status: 'active', allBrands: true },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configureCredentialBroker({ kms: new LocalKms('report-acts-master-secret-0123456789abcdef') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    configureDestinationSources({ registry: new SourceRegistry().register(source) });
    configureSourceActivation(null); // every source enabled
    source.reportRows = { 'gsc.queries': gscQueries() };
    siteA = await connect(tenantA, userA, brandA, 'sc-domain:a.example');
    siteB = await connect(tenantB, userB, brandB, 'sc-domain:b.example');
    await allowReads(tenantA, userA, brandA);
    await allowReads(tenantB, userB, brandB);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('the target listing is platform-level: references of every tenant, nothing written; a replay lists the same', async () => {
    const before = await tdb.db.select().from(brandDestinations);
    const targets = await acts.listDestinationReportTargets({ correlationId: 'corr_report_acts', now: NOW });
    expect(targets).toEqual(
      expect.arrayContaining([
        { tenantId: tenantA, destinationId: siteA },
        { tenantId: tenantB, destinationId: siteB },
      ]),
    );
    expect(Object.keys(targets[0] ?? {})).toEqual(['tenantId', 'destinationId']);
    expect(await acts.listDestinationReportTargets({ correlationId: 'corr_report_acts', now: NOW })).toEqual(
      targets,
    );
    expect(await tdb.db.select().from(brandDestinations)).toEqual(before);
  });

  it('a foreign destination is refused by every tenant-scoped activity before anything is read or written', async () => {
    const rowsB = await storedRows(siteB);
    const beforeB = await destinationRow(siteB);
    const auditsB = await tdb.db.select().from(auditEvents).where(eq(auditEvents.resourceId, siteB));
    const calls = source.reportCalls.length;
    const foreign = input(tenantA, siteB);
    for (const call of [
      () => acts.planDestinationReports(foreign),
      () =>
        acts.fetchDestinationReport({
          ...foreign,
          reportKey: 'gsc.queries',
          start: '2026-09-01',
          end: '2026-09-28',
        }),
      () => acts.finishDestinationReports({ ...foreign, health: 'degraded', fetched: [], reason: 'forged' }),
      () => acts.pruneDestinationReports(foreign),
    ])
      expect(await refusal(call())).toEqual({ type: 'PolicyDenied', nonRetryable: true });
    expect(source.reportCalls.length).toBe(calls);
    expect(await storedRows(siteB)).toEqual(rowsB);
    expect(await destinationRow(siteB)).toEqual(beforeB);
    expect(await tdb.db.select().from(auditEvents).where(eq(auditEvents.resourceId, siteB))).toEqual(auditsB);
  });

  it('plans under the per-destination lock: a replayed plan is locked and plans nothing twice', async () => {
    const plan = await acts.planDestinationReports(input(tenantA, siteA));
    expect(plan).toEqual({
      outcome: 'planned',
      reports: ['gsc.queries', 'gsc.pages', 'gsc.countries_devices'].map((reportKey) => ({
        reportKey,
        start: '2026-09-01',
        end: '2026-09-28',
      })),
    });
    expect(await acts.planDestinationReports(input(tenantA, siteA))).toEqual({
      outcome: 'skipped',
      reason: 'locked',
    });
  });

  it('a fetch stores the window in the destination tenant; a replayed fetch replaces it, never duplicates', async () => {
    const fetch = {
      ...input(tenantA, siteA),
      reportKey: 'gsc.queries',
      start: '2026-09-01',
      end: '2026-09-28',
    };
    expect(await acts.fetchDestinationReport(fetch)).toEqual({ outcome: 'fetched', rows: 56, days: 28 });
    const stored = await storedRows(siteA);
    expect(stored).toHaveLength(56);
    expect(
      stored.every((r) => r.tenantId === tenantA && r.brandId === brandA && r.reportKey === 'gsc.queries'),
    ).toBe(true);
    expect(source.reportCalls.at(-1)).toMatchObject({
      externalId: 'sc-domain:a.example',
      accessToken: 'at_fixture_src',
    });
    expect(await acts.fetchDestinationReport(fetch)).toEqual({ outcome: 'fetched', rows: 56, days: 28 });
    const again = await storedRows(siteA);
    expect(again).toHaveLength(56);
    expect(new Set(again.map((r) => `${r.date}|${r.dimensionKey}`)).size).toBe(56);
    expect(await storedRows(siteB)).toEqual([]);
  });

  it('finish records the outcome and the health as the platform job; a replayed finish records nothing twice', async () => {
    const finish = {
      ...input(tenantA, siteA),
      health: 'degraded' as const,
      fetched: [{ reportKey: 'gsc.queries', rows: 56 }],
      reason: 'rate_limited',
    };
    expect(await acts.finishDestinationReports(finish)).toEqual({ health: 'degraded' });
    const after = await destinationRow(siteA);
    expect(after.health).toBe('degraded');
    const fetched = await auditsOf(tenantA, 'destination.report.fetched', siteA);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({
      actorKind: DESTINATION_REPORTS_ACTOR.kind,
      actorId: DESTINATION_REPORTS_ACTOR.id,
      decision: 'denied',
      metadata: { count: 56, scope: 'gsc.queries', reason: 'rate_limited', toState: 'degraded' },
    });
    expect(await auditsOf(tenantA, 'destination.health', siteA)).toHaveLength(1);
    // Temporal retries the activity after its commit (the acknowledgement was lost): the run is recorded once.
    expect(await acts.finishDestinationReports(finish)).toEqual({ health: 'degraded' });
    expect(await destinationRow(siteA)).toEqual(after);
    expect(await auditsOf(tenantA, 'destination.report.fetched', siteA)).toHaveLength(1);
    expect(await auditsOf(tenantA, 'destination.health', siteA)).toHaveLength(1);
  });

  it('prune deletes past the operational cache in the destination tenant; a replayed prune deletes nothing more', async () => {
    const pruned = await acts.pruneDestinationReports(input(tenantA, siteA));
    expect(pruned).toEqual({ deleted: 42, cutoff: '2026-09-22' });
    expect(await storedRows(siteA)).toHaveLength(14);
    expect(await auditsOf(tenantA, 'destination.report.pruned', siteA)).toHaveLength(1);
    expect(await acts.pruneDestinationReports(input(tenantA, siteA))).toEqual({
      deleted: 0,
      cutoff: '2026-09-22',
    });
    expect(await storedRows(siteA)).toHaveLength(14);
    expect(await auditsOf(tenantA, 'destination.report.pruned', siteA)).toHaveLength(1);
  });
});
