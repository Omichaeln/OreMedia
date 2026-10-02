import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../../testing';
import { SourceReadError } from '../../shared';
import { ga4PropertyAdapter as adapter } from './adapter';

const fx = (name: string) => loadScenario(new URL('./fixtures/reports.json', import.meta.url), name);
const client = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' };
const creds: DecryptedCredentials = { accessToken: 'ya29_at_1_fake', refreshToken: '1//rt_1_fake' };
const target = 'properties/424242';
const range = { start: '2026-09-27', end: '2026-09-28' };

describe('GA4 property reports (ledger R2-1 part B, Data API runReport)', () => {
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

  it('declares three reports, each with the dictionary metrics, a latency and a bounded range', () => {
    expect(adapter.capability.reports.map((r) => r.key)).toEqual([
      'ga4.acquisition',
      'ga4.landing_pages',
      'ga4.engagement',
    ]);
    for (const r of adapter.capability.reports) {
      expect(r.latencyHours).toBeGreaterThan(0);
      expect(r.maxRangeDays).toBeGreaterThan(0);
      expect(r.metrics.length).toBeGreaterThan(0);
    }
  });

  it('acquisition: one runReport with date first, the channel group and the four metrics; dates become ISO days', async () => {
    load('acquisition');
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: target,
      report: 'ga4.acquisition',
      dateRange: range,
    });
    expect(page.nextPageToken).toBeNull();
    // RA-10: the answer's metadata names the property's zone and currency and says the data is sampled and
    // thresholded; the days are the property's local days, never re-bucketed here.
    expect(page.reportingTimeZone).toBe('Africa/Johannesburg');
    expect(page.currencyCode).toBe('ZAR');
    expect(page.quality).toEqual(['sampled', 'thresholded']);
    expect(page.rows).toEqual([
      {
        date: '2026-09-27',
        dimensions: { sessionDefaultChannelGroup: 'Organic Search' },
        metrics: { sessions: 120, totalUsers: 98, engagedSessions: 80, keyEvents: 3 },
      },
      {
        date: '2026-09-27',
        dimensions: { sessionDefaultChannelGroup: 'Direct' },
        metrics: { sessions: 40, totalUsers: 35, engagedSessions: 20, keyEvents: 0 },
      },
      {
        date: '2026-09-28',
        dimensions: { sessionDefaultChannelGroup: 'Organic Search' },
        metrics: { sessions: 130, totalUsers: 101, engagedSessions: 90, keyEvents: 5 },
      },
    ]);
    expect(io.calls).toEqual([
      {
        method: 'POST',
        url: 'https://analyticsdata.googleapis.com/v1beta/properties/424242:runReport',
        mutation: false,
      },
    ]);
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer ya29_at_1_fake');
    expect(server.remaining()).toEqual([]);
  });

  it('landing pages: the landingPage dimension with sessions, engaged sessions and key events', async () => {
    load('landing_pages');
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: target,
      report: 'ga4.landing_pages',
      dateRange: range,
    });
    expect(page.rows.map((r) => [r.date, r.dimensions['landingPage'], r.metrics['sessions']])).toEqual([
      ['2026-09-27', '/', 90],
      ['2026-09-27', '/pricing', 30],
    ]);
    expect(server.remaining()).toEqual([]);
  });

  it('engagement: the day alone; a metric the API left out of the headers is absent, never zero', async () => {
    load('engagement');
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: target,
      report: 'ga4.engagement',
      dateRange: range,
    });
    expect(page.rows).toEqual([
      {
        date: '2026-09-27',
        dimensions: {},
        metrics: { sessions: 160, engagedSessions: 100, averageSessionDuration: 73.5, keyEvents: 3 },
      },
      {
        date: '2026-09-28',
        dimensions: {},
        metrics: { sessions: 130, engagedSessions: 90, averageSessionDuration: 61.25, keyEvents: 5 },
      },
    ]);
    expect('totalUsers' in (page.rows[0]?.metrics ?? {})).toBe(false);
    // Every sample read: not sampled; data folded into "(other)" is a data-loss flag.
    expect(page.quality).toEqual(['data_loss']);
  });

  it('landing pages: an answer without metadata carries no zone and no quality flag (nothing is inferred)', async () => {
    load('landing_pages');
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: target,
      report: 'ga4.landing_pages',
      dateRange: range,
    });
    expect(page.reportingTimeZone).toBeNull();
    expect(page.currencyCode).toBeNull();
    expect(page.quality).toEqual([]);
  });

  it('describeTarget (RA-10): the Admin API property resource gives the reporting zone and currency; a 403 is a classified read error', async () => {
    load('property');
    expect(await adapter.describeTarget(creds, client, io, target)).toEqual({
      reportingTimeZone: 'Africa/Johannesburg',
      currencyCode: 'ZAR',
    });
    expect(io.calls).toEqual([
      {
        method: 'GET',
        url: 'https://analyticsadmin.googleapis.com/v1beta/properties/424242',
        mutation: false,
      },
    ]);
    expect(server.remaining()).toEqual([]);
    load('property_forbidden');
    const err = await adapter.describeTarget(creds, client, io, target).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceReadError);
    expect((err as SourceReadError).classification).toEqual({ kind: 'reconnect_required' });
  });

  it('paging: a rowCount beyond the rows returned yields a token that is the next offset', async () => {
    load('paged');
    const first = await adapter.fetchReport(creds, client, io, {
      externalId: target,
      report: 'ga4.landing_pages',
      dateRange: range,
    });
    expect(first.rows).toHaveLength(2);
    expect(first.nextPageToken).toBe('2');
    const second = await adapter.fetchReport(creds, client, io, {
      externalId: target,
      report: 'ga4.landing_pages',
      dateRange: range,
      pageToken: first.nextPageToken!,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.nextPageToken).toBeNull();
    expect(server.remaining()).toEqual([]);
  });

  it('a quota 429 is a SourceReadError classified rate limited with the Retry-After; a 401 asks for a refresh', async () => {
    load('quota');
    const err = await adapter
      .fetchReport(creds, client, io, { externalId: target, report: 'ga4.acquisition', dateRange: range })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceReadError);
    expect((err as SourceReadError).status).toBe(429);
    expect((err as SourceReadError).classification).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
      retryAfterMs: 120_000,
    });
    expect((err as Error).message).not.toContain('ya29');
    load('unauthorised');
    const unauthorised = await adapter
      .fetchReport(creds, client, io, { externalId: target, report: 'ga4.acquisition', dateRange: range })
      .catch((e: unknown) => e);
    expect((unauthorised as SourceReadError).classification).toEqual({ kind: 'refresh_token' });
  });

  it('an unknown report key is refused before any call', async () => {
    load('quota');
    await expect(
      adapter.fetchReport(creds, client, io, { externalId: target, report: 'ga4.nope', dateRange: range }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(io.calls).toEqual([]);
  });
});
