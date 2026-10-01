import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO, type FixtureScenario } from '../../testing';
import { SourceReadError } from '../../shared';
import { GSC_REPORT_ROW_LIMIT, searchConsoleSiteAdapter as adapter } from './adapter';

const fx = (name: string) => loadScenario(new URL('./fixtures/reports.json', import.meta.url), name);
const client = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' };
const creds: DecryptedCredentials = { accessToken: 'ya29_at_1_fake', refreshToken: '1//rt_1_fake' };
const site = 'sc-domain:acme.example';
const range = { start: '2026-09-25', end: '2026-09-26' };

/** A full page of query rows followed by a short one: built here rather than hand-written (1000 rows). */
function pagedScenario(): FixtureScenario {
  const row = (i: number) => ({
    keys: ['2026-09-25', `query ${i}`],
    clicks: i,
    impressions: i * 10,
    ctr: 0.1,
    position: 3,
  });
  const request = {
    method: 'POST',
    host: 'www.googleapis.com',
    path: `/webmasters/v3/sites/${site}/searchAnalytics/query`,
  };
  return {
    exchanges: [
      {
        request: { ...request, bodyIncludes: ['"startRow":0'] },
        response: {
          status: 200,
          json: { rows: Array.from({ length: GSC_REPORT_ROW_LIMIT }, (_, i) => row(i)) },
        },
      },
      {
        request: { ...request, bodyIncludes: [`"startRow":${GSC_REPORT_ROW_LIMIT}`] },
        response: { status: 200, json: { rows: [row(GSC_REPORT_ROW_LIMIT)] } },
      },
    ],
  };
}

describe('Search Console reports (ledger R2-1 part B, searchAnalytics/query)', () => {
  const server = new FixtureServer();
  let io: FixtureIO;
  beforeAll(async () => {
    await server.start();
    io = await fixtureIO(server, { providerKey: adapter.key });
  });
  afterAll(() => server.stop());
  const load = (scenario: FixtureScenario): void => {
    server.load(scenario);
    io.calls.length = 0;
  };

  it('declares three reports over the four search metrics', () => {
    expect(adapter.capability.reports.map((r) => r.key)).toEqual([
      'gsc.queries',
      'gsc.pages',
      'gsc.countries_devices',
    ]);
    for (const r of adapter.capability.reports)
      expect(r.metrics.map((m) => m.name)).toEqual(['clicks', 'impressions', 'ctr', 'position']);
  });

  it('queries: one query with date first, final data, rowLimit 1000 from row 0; rows keyed by day and query', async () => {
    load(fx('queries'));
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: site,
      report: 'gsc.queries',
      dateRange: range,
    });
    expect(page.nextPageToken).toBeNull();
    expect(page.rows).toEqual([
      {
        date: '2026-09-25',
        dimensions: { query: 'acme pricing' },
        metrics: { clicks: 12, impressions: 400, ctr: 0.03, position: 4.2 },
      },
      {
        date: '2026-09-25',
        dimensions: { query: 'acme login' },
        metrics: { clicks: 30, impressions: 120, ctr: 0.25, position: 1.1 },
      },
      {
        date: '2026-09-26',
        dimensions: { query: 'acme pricing' },
        metrics: { clicks: 10, impressions: 380, ctr: 0.0263, position: 4.5 },
      },
    ]);
    expect(io.calls).toEqual([
      {
        method: 'POST',
        url: 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aacme.example/searchAnalytics/query',
        mutation: false,
      },
    ]);
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer ya29_at_1_fake');
    expect(server.remaining()).toEqual([]);
  });

  it('pages: a URL-prefix site is encoded into the path; the page dimension carries the URL', async () => {
    load(fx('pages'));
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: 'https://acme.example/',
      report: 'gsc.pages',
      dateRange: range,
    });
    expect(page.rows).toEqual([
      {
        date: '2026-09-25',
        dimensions: { page: 'https://acme.example/pricing' },
        metrics: { clicks: 12, impressions: 400, ctr: 0.03, position: 4.2 },
      },
    ]);
    expect(io.calls[0]?.url).toBe(
      'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Facme.example%2F/searchAnalytics/query',
    );
  });

  it('countries and devices: two dimensions after the day; a metric the API left out is absent, never zero', async () => {
    load(fx('countries_devices'));
    const page = await adapter.fetchReport(creds, client, io, {
      externalId: site,
      report: 'gsc.countries_devices',
      dateRange: range,
    });
    expect(page.rows).toEqual([
      {
        date: '2026-09-25',
        dimensions: { country: 'zwe', device: 'MOBILE' },
        metrics: { clicks: 8, impressions: 200, ctr: 0.04, position: 6.1 },
      },
      {
        date: '2026-09-25',
        dimensions: { country: 'zaf', device: 'DESKTOP' },
        metrics: { clicks: 4, impressions: 90 },
      },
    ]);
  });

  it('paging: a full page yields a token that is the next start row; a short page ends it', async () => {
    load(pagedScenario());
    const first = await adapter.fetchReport(creds, client, io, {
      externalId: site,
      report: 'gsc.queries',
      dateRange: range,
    });
    expect(first.rows).toHaveLength(GSC_REPORT_ROW_LIMIT);
    expect(first.nextPageToken).toBe(String(GSC_REPORT_ROW_LIMIT));
    const second = await adapter.fetchReport(creds, client, io, {
      externalId: site,
      report: 'gsc.queries',
      dateRange: range,
      pageToken: first.nextPageToken!,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.nextPageToken).toBeNull();
    expect(server.remaining()).toEqual([]);
  });

  it('a quota 429 is a SourceReadError classified rate limited (60 s without Retry-After); a 403 means reconnect', async () => {
    load(fx('quota'));
    const err = await adapter
      .fetchReport(creds, client, io, { externalId: site, report: 'gsc.queries', dateRange: range })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceReadError);
    expect((err as SourceReadError).classification).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
      retryAfterMs: 60_000,
    });
    load(fx('forbidden'));
    const forbidden = await adapter
      .fetchReport(creds, client, io, { externalId: site, report: 'gsc.queries', dateRange: range })
      .catch((e: unknown) => e);
    expect((forbidden as SourceReadError).classification).toEqual({ kind: 'reconnect_required' });
  });
});
