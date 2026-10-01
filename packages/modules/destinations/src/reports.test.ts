import { describe, expect, it } from 'vitest';
import { webMetricSums, webMetricValues, type SourceReportMetricV1 } from '@oremedia/contracts/destinations';
import { ga4Reports, searchConsoleReports } from '@oremedia/providers';
import { addDays, dateKey, reportRange } from './report-runtime';
import { reportComparison, reportFreshness } from './reports';

/** The pure rules of R2-1 part B: incremental ranges, freshness, the D-14 comparison and the D-15 aggregates. */
const spec = { key: 'gsc.queries', latencyHours: 72, maxRangeDays: 90 };
const now = new Date('2026-09-29T04:00:00.000Z');

describe('reportRange (incremental, latency-aware, bounded)', () => {
  it('a first run reads the last 28 days up to yesterday', () => {
    expect(reportRange(spec, null, now)).toEqual({
      reportKey: 'gsc.queries',
      start: '2026-09-01',
      end: '2026-09-28',
    });
  });
  it('a later run re-reads from the last stored day minus the latency (a day moves until final)', () => {
    expect(reportRange(spec, '2026-09-27', now)).toEqual({
      reportKey: 'gsc.queries',
      start: '2026-09-24',
      end: '2026-09-28',
    });
    expect(reportRange({ ...spec, latencyHours: 48 }, '2026-09-27', now)?.start).toBe('2026-09-25');
  });
  it("a long gap is capped at the report's longest range; nothing new means no range", () => {
    expect(reportRange(spec, '2026-01-01', now)).toEqual({
      reportKey: 'gsc.queries',
      start: '2026-07-01',
      end: '2026-09-28',
    });
    expect(reportRange({ ...spec, latencyHours: 0 }, '2026-09-29', now)).toBeNull();
  });
  it('day arithmetic is UTC', () => {
    expect(dateKey(new Date('2026-03-01T00:30:00.000Z'))).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('reportFreshness (stale beyond STALE_FACTOR × latency)', () => {
  it('nothing read yet is stale with no date', () => {
    expect(reportFreshness(null, null, 48, now)).toEqual({
      latestDate: null,
      fetchedAt: null,
      ageHours: null,
      latencyHours: 48,
      stale: true,
    });
  });
  it("yesterday's data is fresh; a day a week old is stale", () => {
    const fetchedAt = new Date('2026-09-29T03:50:00.000Z');
    expect(reportFreshness('2026-09-28', fetchedAt, 48, now)).toMatchObject({
      latestDate: '2026-09-28',
      fetchedAt: fetchedAt.toISOString(),
      stale: false,
    });
    expect(reportFreshness('2026-09-22', fetchedAt, 48, now).stale).toBe(true);
  });
});

describe('web metric aggregates (D-15) and the comparison (D-14)', () => {
  const gsc = searchConsoleReports[0]!;
  const metrics = gsc.metrics;
  const none: SourceReportMetricV1[] = [];
  const rows = [
    { clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
    { clicks: 30, impressions: 300, ctr: 0.1, position: 6 },
    { clicks: 5, impressions: 100, position: 10 }, // no ctr reported: the pooled rate still forms from the flows
  ];
  it('flows sum, a rate pools Σ numerator ÷ Σ denominator, a gauge is weighted by its weight', () => {
    const values = webMetricValues(metrics, none, webMetricSums(metrics, rows));
    expect(values).toEqual({ clicks: 45, impressions: 500, ctr: 0.09, position: (200 + 1800 + 1000) / 500 });
  });
  it('no rows is null everywhere, never zero; a zero denominator makes the rate null', () => {
    expect(webMetricValues(metrics, none, webMetricSums(metrics, []))).toEqual({
      clicks: null,
      impressions: null,
      ctr: null,
      position: null,
    });
    expect(
      webMetricValues(metrics, none, webMetricSums(metrics, [{ clicks: 0, impressions: 0 }])),
    ).toMatchObject({
      ctr: null,
      position: null,
    });
  });
  it('the GA4 engagement rate derives from engaged sessions over sessions when both are present', () => {
    const landing = ga4Reports.find((r) => r.key === 'ga4.landing_pages')!;
    expect(
      webMetricValues(
        landing.metrics,
        landing.derived,
        webMetricSums(landing.metrics, [
          { sessions: 100, engagedSessions: 40, keyEvents: 1 },
          { sessions: 100, engagedSessions: 20 },
        ]),
      ),
    ).toEqual({ sessions: 200, engagedSessions: 60, keyEvents: 1, engagementRate: 0.3 });
  });
  it('comparison: flows and rates only, a change only with a sufficient sample and a positive previous', () => {
    const current = { clicks: 60, impressions: 600, ctr: 0.1, position: 4 };
    const previous = { clicks: 50, impressions: 500, ctr: 0.1, position: 5 };
    expect(reportComparison(metrics, current, previous, true)).toEqual([
      { metric: 'clicks', kind: 'flow', current: 60, previous: 50, change: 0.2 },
      { metric: 'impressions', kind: 'flow', current: 600, previous: 500, change: 0.2 },
      { metric: 'ctr', kind: 'rate', current: 0.1, previous: 0.1, change: 0 },
    ]);
    expect(reportComparison(metrics, current, previous, false).every((c) => c.change === null)).toBe(true);
    expect(reportComparison(metrics, current, { ...previous, clicks: null }, true)[0]?.change).toBeNull();
  });
});
