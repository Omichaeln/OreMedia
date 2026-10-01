import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../../testing';
import { SourceReadError } from '../../shared';
import { gbpLocationAdapter as adapter } from './adapter';

const fx = (name: string) => loadScenario(new URL('./fixtures/reports.json', import.meta.url), name);
const client = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' };
const creds: DecryptedCredentials = { accessToken: 'ya29_at_1_fake', refreshToken: '1//rt_1_fake' };
const target = 'locations/777';
const range = { start: '2026-09-27', end: '2026-09-28' };

describe('Business Profile performance reports (ledger R2-2, Performance API fetchMultiDailyMetricsTimeSeries)', () => {
  const server = new FixtureServer();
  let io: FixtureIO;
  beforeAll(async () => {
    await server.start();
    io = await fixtureIO(server, { providerKey: adapter.key });
  });
  afterAll(() => server.stop());
  const load = (name: string): void => {
    server.load(fx(name));
    io.calls.length = 0;
  };

  it('declares the performance and surfaces reports under gbp.reports, flows only, a latency and a bounded range', () => {
    expect(adapter.capability.reports.map((r) => r.key)).toEqual(['gbp.performance', 'gbp.surfaces']);
    for (const r of adapter.capability.reports) {
      expect(r.latencyHours).toBe(120);
      expect(r.maxRangeDays).toBe(90);
      expect(r.metrics.every((m) => m.kind === 'flow')).toBe(true);
      expect(r.opportunity).toBeUndefined();
    }
    expect(adapter.capability.presentation?.tiles).toEqual({
      reportKey: 'gbp.performance',
      metrics: ['impressions', 'websiteClicks', 'callClicks', 'directionRequests'],
    });
  });

  it('performance: one GET with the nine daily metrics and the range as year/month/day; surfaces summed into impressions; a day without a value is absent, never zero', async () => {
    load('performance');
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: target,
      report: 'gbp.performance',
      dateRange: range,
    });
    expect(page.nextPageToken).toBeNull();
    expect(page.rows).toEqual([
      {
        date: '2026-09-27',
        dimensions: {},
        metrics: { impressions: 150, websiteClicks: 6, callClicks: 3, directionRequests: 4, bookings: 1 },
      },
      {
        date: '2026-09-28',
        dimensions: {},
        metrics: { impressions: 160, websiteClicks: 9, callClicks: 2, directionRequests: 5 },
      },
    ]);
    expect(io.calls).toHaveLength(1);
    expect(io.calls[0]).toMatchObject({ method: 'GET', mutation: false });
    const sent = server.requests[0]!;
    expect(sent.path).toBe('/v1/locations/777:fetchMultiDailyMetricsTimeSeries');
    expect(sent.headers['authorization']).toBe('Bearer ya29_at_1_fake');
    const u = new URL(io.calls[0]!.url); // the recorded query collapses a repeated key: read the URL sent
    expect(u.searchParams.getAll('dailyMetrics')).toHaveLength(9);
    expect(u.searchParams.getAll('dailyMetrics')).toContain('BUSINESS_BOOKINGS');
    expect(server.remaining()).toEqual([]);
  });

  it('surfaces: the four impression metrics only, one row per surface and day, a surface without a value absent', async () => {
    load('surfaces');
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: target,
      report: 'gbp.surfaces',
      dateRange: range,
    });
    expect(page.rows).toEqual([
      { date: '2026-09-27', dimensions: { surface: 'desktop_maps' }, metrics: { impressions: 10 } },
      { date: '2026-09-27', dimensions: { surface: 'desktop_search' }, metrics: { impressions: 40 } },
      { date: '2026-09-27', dimensions: { surface: 'mobile_search' }, metrics: { impressions: 75 } },
    ]);
    const u = new URL(io.calls[0]!.url);
    expect(u.searchParams.getAll('dailyMetrics')).toHaveLength(4);
    expect(u.searchParams.getAll('dailyMetrics').every((m) => m.startsWith('BUSINESS_IMPRESSIONS_'))).toBe(
      true,
    );
  });

  it('a location without data yet yields no rows', async () => {
    load('empty');
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: target,
      report: 'gbp.performance',
      dateRange: range,
    });
    expect(page).toEqual({ rows: [], nextPageToken: null });
  });

  it('a quota 429 is rate limited with the Retry-After; a service-disabled 403 is access_required; a plain 403 a reconnect; a 401 a refresh', async () => {
    const read = () =>
      adapter
        .fetchReport(creds, client, io, { externalId: target, report: 'gbp.performance', dateRange: range })
        .catch((e: unknown) => e);
    load('quota');
    const quota = await read();
    expect(quota).toBeInstanceOf(SourceReadError);
    expect((quota as SourceReadError).status).toBe(429);
    expect((quota as SourceReadError).classification).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
      retryAfterMs: 90_000,
    });
    expect((quota as Error).message).not.toContain('ya29');
    load('access_required');
    expect((await read()) as SourceReadError).toMatchObject({
      status: 403,
      classification: { kind: 'rejected', code: 'access_required' },
    });
    load('forbidden');
    expect(((await read()) as SourceReadError).classification).toEqual({ kind: 'reconnect_required' });
    load('forbidden_prose'); // prose alone never means access required
    expect(((await read()) as SourceReadError).classification).toEqual({ kind: 'reconnect_required' });
    load('unauthorised');
    expect(((await read()) as SourceReadError).classification).toEqual({ kind: 'refresh_token' });
  });

  it('an unknown report key is refused before any call', async () => {
    load('quota');
    await expect(
      adapter.fetchReport(creds, client, io, { externalId: target, report: 'gbp.reviews', dateRange: range }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(io.calls).toEqual([]);
  });
});
