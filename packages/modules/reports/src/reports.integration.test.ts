import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ReportDraftRequestV1, ReportDrafterV1 } from '@oremedia/contracts/reports';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import { requireTenant, runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { metricSnapshots } from '@oremedia/db/schema/measurement';
import { publications } from '@oremedia/db/schema/publishing';
import { reports } from '@oremedia/db/schema/reports';
import { newId } from '@oremedia/domain/ids';
import { budgets } from '@oremedia/module-billing';
import { registerCalendarSource } from '@oremedia/module-content';
import {
  definitionService,
  registerMeasurementBrandChecker,
  registerMeasurementPublicationSource,
} from '@oremedia/module-measurement';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureChannelActivation,
  configureCredentialBroker,
  configurePublishingProviders,
  connectedChannel,
  fixtureCapability,
  publicationService,
  registerProviderClients,
  registerPublishingBrandChecker,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';
import { registerReportDrafter } from './hooks';
import { createReportsService } from './service';

/**
 * D-29 against MySQL 8: the builder state per brand and month (create, update at a version, the send record), the
 * figures composed over a seeded month (six posts in September, five in August, under D-14/D-15), the drafting
 * path through a registered fake gateway with its budget charge, and the honest "unavailable" answer without one.
 * Cross-tenant: a foreign brand's report is NOT_FOUND on every read and write, and nothing lands in tenant B.
 */
const USER = 'usr_reports_test';
const NOW = new Date('2026-10-05T09:00:00.000Z');
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_reports',
});
const member = (tenantId: string, role: MembershipRole = 'owner'): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: `mem_reports_${tenantId.slice(-6)}`,
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const read = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);

const FIELDS = {
  compareMode: 'previous_month' as const,
  sections: ['overview', 'cover', 'posts'] as Array<
    'cover' | 'overview' | 'channels' | 'posts' | 'recommendations'
  >,
  executiveSummary: 'September in one paragraph.',
  recommendations: '',
  preparedFor: 'Kofi Asare, Acme',
  preparedBy: 'Ama Mensah, Northwind',
  theme: 'dark' as const,
};

describe('reports module against MySQL 8 (D-29)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter(
    fixtureCapability({
      analytics: { post: ['impressionCount', 'engagement'], account: [], latencyHours: 2 },
    }),
  );
  registry.register(fixture);
  const service = createReportsService({ now: () => NOW });
  let channelId = '';
  const requests: ReportDraftRequestV1[] = [];
  const fakeDrafter: ReportDrafterV1 = {
    describe: () => ({
      provider: 'fake',
      model: 'fake-model',
      maxOutputTokens: 1000,
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 5_000_000,
    }),
    assertRouting: async () => undefined,
    draft: async (req) => {
      requests.push(req);
      return {
        text:
          req.kind === 'summary'
            ? `Draft over ${req.facts.length} facts.`
            : '{"section":"posts","text":"The LinkedIn post of 23 Sep was republished the next day.","reply":"Placed under Post performance."}',
        usage: { inputTokens: 400, outputTokens: 60 },
        costMicros: 700,
      };
    },
  };

  const publish = async (at: Date, impressions: number, engagement: number) => {
    const id = newId('publication');
    await tdb.db.insert(publications).values({
      id,
      tenantId: tenantA,
      brandId: brandA,
      contentPackageId: newId('contentPackage'),
      contentRevisionId: newId('contentRevision'),
      channelVariantId: newId('channelVariant'),
      channelConnectionId: channelId,
      occurrenceKey: `test:${id}`,
      authority: 'approval',
      approvalId: newId('releaseApproval'),
      mandateId: null,
      scheduledFor: at,
      state: 'published',
      remotePostId: `post_${id.slice(-6)}`,
      remoteUrl: 'https://fixture.example/p/1',
      scheduledByKind: 'user',
      scheduledById: USER,
    });
    const fetchedAt = new Date(at.getTime() + 3_600_000);
    for (const [metricKey, v] of [
      ['impressionCount', impressions],
      ['engagement', engagement],
    ] as const)
      await tdb.db.insert(metricSnapshots).values({
        id: newId('metricSnapshot'),
        tenantId: tenantA,
        brandId: brandA,
        subjectType: 'publication',
        subjectId: id,
        metricKey,
        value: v,
        series: null,
        windowStart: at,
        windowEnd: fetchedAt,
        fetchedAt,
        source: `${FIXTURE_PROVIDER_KEY}@v1`,
        completeness: 'complete',
        definitionVersion: 1,
        numeratorSnapshotId: null,
        denominatorSnapshotId: null,
        brandTimezone: 'UTC',
      });
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'reports-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'reports-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(users).values({ id: USER, email: 'reports-test@example.test', name: 'Rep' });
    await tdb.db.insert(memberships).values(
      [tenantA, tenantB].map((tenantId) => ({
        id: `mem_reports_${tenantId.slice(-6)}`,
        tenantId,
        userId: USER,
        role: 'owner' as const,
        status: 'active' as const,
        allBrands: true,
      })),
    );
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'Acme', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'Beta', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configurePublishingProviders({ registry });
    configureCredentialBroker({ kms: new LocalKms('reports-test-master-secret-0123456789abcdef') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    configureChannelActivation(null);
    const checker = {
      assertExist: async (ids: string[]) => {
        const known = requireTenant().tenantId === tenantA ? brandA : brandB;
        for (const id of ids) if (id !== known) throw new NotFoundError('Brand', id);
      },
    };
    registerPublishingBrandChecker(checker);
    registerMeasurementBrandChecker(checker);
    registerMeasurementPublicationSource((brandId, from, to, tx) =>
      publicationService.calendarRangeAll(brandId, from, to, tx),
    );
    registerCalendarSource((brandId, from, to, tx) =>
      publicationService.calendarRange(brandId, from, to, tx),
    );
    await definitionService.seedGlobal([fixture.capability]);
    fixture.grant.remoteAccountId = 'acct_reports';
    const started = await run(tenantA, (tx) =>
      channelService.connect.start(
        member(tenantA),
        { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    channelId = (
      await run(tenantA, (tx) =>
        channelService.connect
          .complete(member(tenantA), { state: started.state, code: 'good' }, tx)
          .then(connectedChannel),
      )
    ).id;
    // Six posts in September with numbers, five in August: the D-14 sample holds on both sides.
    for (let d = 1; d <= 6; d++)
      await publish(new Date(`2026-09-${String(d + 10).padStart(2, '0')}T12:00:00Z`), 100, 10 + d);
    for (let d = 1; d <= 5; d++)
      await publish(new Date(`2026-08-${String(d + 10).padStart(2, '0')}T12:00:00Z`), 80, 4);
  });
  afterAll(async () => {
    registerReportDrafter(null);
    await tdb?.drop();
  });

  it('composes the month’s figures: flows summed, the rate pooled, reach never totalled, the sample named', async () => {
    const f = await read(tenantA, () =>
      service.figures(member(tenantA), {
        brandId: brandA,
        periodMonth: '2026-09',
        compareMode: 'previous_month',
      }),
    );
    expect(f).toMatchObject({
      brandName: 'Acme',
      compareMonth: '2026-08',
      sample: { current: 6, previous: 5, minimum: 5, sufficient: true },
    });
    expect(f.figures.find((x) => x.key === 'impressions')).toMatchObject({
      value: 600,
      previous: 400,
      change: 0.5,
    });
    expect(f.figures.find((x) => x.key === 'engagement')).toMatchObject({ value: 81, previous: 20 });
    expect(f.figures.find((x) => x.key === 'rate:engagement/impressions')).toMatchObject({
      value: 81 / 600,
      previous: 0.05,
    });
    expect(f.figures.find((x) => x.key === 'reach')).toMatchObject({
      value: null,
      notSummed: 'unique people: never summed across posts',
    });
    expect(f.channels).toHaveLength(1);
    expect(f.channels[0]).toMatchObject({
      channelConnectionId: channelId,
      publications: 6,
      impressions: 600,
      shareOfImpressions: 1,
      impressionsChange: 0.5,
    });
    expect(f.posts.ranked[0]?.engagement).toBe(16);
    expect(f.trend.map((t) => t.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(f.trend[5]).toMatchObject({ publications: 6, impressions: 600 });
    expect(f.trend[0]).toMatchObject({ publications: 0, impressions: null });
    // Last year: nothing to compare with, and the figures say so rather than inventing a zero.
    const yoy = await read(tenantA, () =>
      service.figures(member(tenantA), { brandId: brandA, periodMonth: '2026-09', compareMode: 'last_year' }),
    );
    expect(yoy.sample).toMatchObject({ previous: 0, sufficient: false });
    expect(yoy.figures.find((x) => x.key === 'impressions')).toMatchObject({
      value: 600,
      previous: null,
      change: null,
    });
  });

  it('creates the month’s draft, updates it at its version, lists it newest first and refuses a stale write', async () => {
    expect(
      await read(tenantA, () => service.get(member(tenantA), { brandId: brandA, periodMonth: '2026-09' })),
    ).toBeNull();
    const created = await run(tenantA, (tx) =>
      service.save(
        member(tenantA),
        { brandId: brandA, periodMonth: '2026-09', expectedVersion: null, fields: FIELDS },
        tx,
      ),
    );
    expect(created).toMatchObject({
      state: 'draft',
      version: 0,
      sections: ['cover', 'overview', 'posts'],
      sentAt: null,
    });
    await expect(
      run(tenantA, (tx) =>
        service.save(
          member(tenantA),
          { brandId: brandA, periodMonth: '2026-09', expectedVersion: null, fields: FIELDS },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const updated = await run(tenantA, (tx) =>
      service.save(
        member(tenantA),
        {
          brandId: brandA,
          periodMonth: '2026-09',
          expectedVersion: 0,
          fields: { ...FIELDS, executiveSummary: 'Edited.' },
        },
        tx,
      ),
    );
    expect(updated).toMatchObject({ id: created.id, version: 1, executiveSummary: 'Edited.' });
    await expect(
      run(tenantA, (tx) =>
        service.save(
          member(tenantA),
          { brandId: brandA, periodMonth: '2026-09', expectedVersion: 0, fields: FIELDS },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    const list = await read(tenantA, () =>
      service.list(member(tenantA), { brandId: brandA, page: { limit: 10 } }),
    );
    expect(list.items.map((r) => r.id)).toEqual([created.id]);
    // A reviewer reads; only report.edit saves.
    await expect(
      run(tenantA, (tx) =>
        service.save(
          member(tenantA, 'reviewer'),
          { brandId: brandA, periodMonth: '2026-10', expectedVersion: null, fields: FIELDS },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(
      (
        await read(tenantA, () =>
          service.get(member(tenantA, 'reviewer'), { brandId: brandA, periodMonth: '2026-09' }),
        )
      )?.id,
    ).toBe(created.id);
  });

  it('records a send (state, to whom, when) without claiming delivery, and says what the deployment lacks', async () => {
    const delivery = await read(tenantA, () => service.delivery(member(tenantA), { brandId: brandA }));
    expect(delivery.email.configured).toBe(false);
    expect(delivery.link.available).toBe(false);
    expect(delivery.pdf.method).toBe('print');
    const report = (await read(tenantA, () =>
      service.get(member(tenantA), { brandId: brandA, periodMonth: '2026-09' }),
    ))!;
    await expect(
      run(tenantA, (tx) =>
        service.markSent(
          member(tenantA, 'analyst'),
          {
            brandId: brandA,
            reportId: report.id,
            expectedVersion: report.version,
            sentTo: 'kofi@acme.example',
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    const sent = await run(tenantA, (tx) =>
      service.markSent(
        member(tenantA, 'publisher'),
        {
          brandId: brandA,
          reportId: report.id,
          expectedVersion: report.version,
          sentTo: 'kofi@acme.example',
        },
        tx,
      ),
    );
    expect(sent).toMatchObject({
      state: 'sent',
      sentTo: 'kofi@acme.example',
      sentAt: NOW.toISOString(),
      version: report.version + 1,
    });
  });

  it('keeps the auto-draft switch as a preference and says the schedule is not active', async () => {
    expect(
      await read(tenantA, () => service.preferences.get(member(tenantA), { brandId: brandA })),
    ).toMatchObject({ autoDraft: false, scheduleActive: false });
    const on = await run(tenantA, (tx) =>
      service.preferences.set(member(tenantA), { brandId: brandA, autoDraft: true }, tx),
    );
    expect(on).toMatchObject({ autoDraft: true, scheduleActive: false });
    expect(
      (await read(tenantA, () => service.preferences.get(member(tenantA), { brandId: brandA }))).autoDraft,
    ).toBe(true);
  });

  it('without a gateway the draft is unavailable and says so; with one it is drafted over the facts and charged', async () => {
    registerReportDrafter(null);
    const none = await read(tenantA, () =>
      service.draftSummary(member(tenantA), {
        brandId: brandA,
        periodMonth: '2026-09',
        compareMode: 'previous_month',
      }),
    );
    expect(none).toMatchObject({ available: false, reason: 'model_unavailable' });
    registerReportDrafter(fakeDrafter);
    const before = await read(tenantA, () => budgets.summary(brandA));
    const draft = await read(tenantA, () =>
      service.draftSummary(member(tenantA), {
        brandId: brandA,
        periodMonth: '2026-09',
        compareMode: 'previous_month',
      }),
    );
    expect(draft).toMatchObject({ available: true, draft: true, model: 'fake-model', costMicros: 700 });
    expect(requests[0]).toMatchObject({
      kind: 'summary',
      brandName: 'Acme',
      periodLabel: 'September 2026',
      compareLabel: 'Aug',
    });
    expect(requests[0]?.facts.join('\n')).toContain('Impressions: 600 (+50.0% vs Aug)');
    const after = await read(tenantA, () => budgets.summary(brandA));
    expect(after.reservations.length).toBe(before.reservations.length + 1);
    expect(after.reservations.find((r) => r.runId === requests[0]?.requestId)).toMatchObject({
      state: 'settled',
      consumedMicros: 700,
    });
    const addition = await read(tenantA, () =>
      service.ask(member(tenantA), {
        brandId: brandA,
        periodMonth: '2026-09',
        compareMode: 'previous_month',
        question: 'Note the LinkedIn post of 23 Sep was republished',
      }),
    );
    expect(addition).toMatchObject({
      available: true,
      section: 'posts',
      text: 'The LinkedIn post of 23 Sep was republished the next day.',
    });
    expect(requests[1]?.instruction).toBe('Note the LinkedIn post of 23 Sep was republished');
    // Drafting is report.edit: a reviewer is refused before any model call.
    await expect(
      read(tenantA, () =>
        service.draftSummary(member(tenantA, 'reviewer'), {
          brandId: brandA,
          periodMonth: '2026-09',
          compareMode: 'previous_month',
        }),
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(requests).toHaveLength(2);
  });

  it('cross-tenant: tenant B’s brand is NOT_FOUND from tenant A on every read and write, and nothing lands in B', async () => {
    await tdb.db.insert(reports).values({
      id: newId('report'),
      tenantId: tenantB,
      brandId: brandB,
      periodMonth: '2026-09',
      compareMode: 'previous_month',
      sections: ['cover'],
      executiveSummary: 'B only',
      recommendations: '',
      preparedFor: '',
      preparedBy: '',
      theme: 'dark',
      state: 'draft',
    });
    const a = member(tenantA);
    for (const call of [
      () => service.list(a, { brandId: brandB, page: { limit: 10 } }),
      () => service.get(a, { brandId: brandB, periodMonth: '2026-09' }),
      () => service.figures(a, { brandId: brandB, periodMonth: '2026-09', compareMode: 'previous_month' }),
      () => service.delivery(a, { brandId: brandB }),
      () => service.preferences.get(a, { brandId: brandB }),
      () =>
        service.draftSummary(a, { brandId: brandB, periodMonth: '2026-09', compareMode: 'previous_month' }),
    ])
      await expect(read(tenantA, call)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      run(tenantA, (tx) =>
        service.save(a, { brandId: brandB, periodMonth: '2026-09', expectedVersion: 0, fields: FIELDS }, tx),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const bRows = await read(tenantB, () =>
      service.list(member(tenantB), { brandId: brandB, page: { limit: 10 } }),
    );
    expect(bRows.items).toHaveLength(1);
    expect(bRows.items[0]?.executiveSummary).toBe('B only');
    // A's own brand never sees B's report under A's context either.
    expect(await read(tenantA, () => service.get(a, { brandId: brandA, periodMonth: '2026-11' }))).toBeNull();
  });
});
