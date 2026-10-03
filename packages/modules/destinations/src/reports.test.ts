import { describe, expect, it } from 'vitest';
import { webMetricSums, webMetricValues, type SourceReportMetricV1 } from '@oremedia/contracts/destinations';
import { ga4Reports, searchConsoleReports } from '@oremedia/providers';
import { addDays, dateKey, dayEnd, knownTimeZone, reportRange } from './report-runtime';
import { reportComparison, reportFreshness, reportQuality } from './reports';

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
  it('RA-10: in the reporting zone, "yesterday" is the zone\'s last complete day, across the UTC boundary either way', () => {
    // 04:00 UTC on the 29th is still the 28th in Los Angeles: the 28th is running there, the 27th is the end.
    expect(reportRange(spec, null, now, 'America/Los_Angeles')).toEqual({
      reportKey: 'gsc.queries',
      start: '2026-08-31',
      end: '2026-09-27',
    });
    // 23:30 UTC on the 28th is already the 29th in Auckland: the 28th has ended there and is read.
    expect(reportRange(spec, '2026-09-27', new Date('2026-09-28T23:30:00.000Z'), 'Pacific/Auckland')).toEqual(
      {
        reportKey: 'gsc.queries',
        start: '2026-09-24',
        end: '2026-09-28',
      },
    );
    expect(reportRange(spec, '2026-09-27', new Date('2026-09-28T23:30:00.000Z'), null)?.end).toBe(
      '2026-09-27',
    );
    // A zone the runtime does not know keys UTC days (a stored value is validated on read, spec 6.1).
    expect(reportRange(spec, null, now, 'Mars/Olympus')?.end).toBe('2026-09-28');
    expect(knownTimeZone('Africa/Johannesburg')).toBe(true);
    expect(knownTimeZone('Mars/Olympus')).toBe(false);
    expect(knownTimeZone(null)).toBe(false);
  });
  it('RA-10: a day ends at 23:59:59.999 in its zone', () => {
    expect(dayEnd('2026-09-28').toISOString()).toBe('2026-09-28T23:59:59.999Z');
    expect(dayEnd('2026-09-28', 'Africa/Johannesburg').toISOString()).toBe('2026-09-28T21:59:59.999Z');
    expect(dayEnd('2026-09-28', 'America/Los_Angeles').toISOString()).toBe('2026-09-29T06:59:59.999Z');
    expect(dateKey(new Date('2026-09-29T04:00:00.000Z'), 'America/Los_Angeles')).toBe('2026-09-28');
    // Auckland the day before a DST change either way: the offset of the day itself, not of the day after.
    expect(dayEnd('2026-09-26', 'Pacific/Auckland').toISOString()).toBe('2026-09-26T11:59:59.999Z');
    expect(dayEnd('2026-04-04', 'Pacific/Auckland').toISOString()).toBe('2026-04-04T10:59:59.999Z');
  });
});

describe('reportQuality (RA-10: provisional while a day may still move)', () => {
  it('nothing read: not provisional, no zone, no flags', () => {
    expect(reportQuality(null, null, [], 48, now)).toEqual({
      timeZone: null,
      asOfLocalDate: null,
      provisional: false,
      flags: [],
    });
  });
  it('the latest day inside the latency, a partial day or a not-final answer is provisional; past it, final', () => {
    expect(reportQuality('2026-09-28', 'Africa/Johannesburg', [], 48, now)).toMatchObject({
      timeZone: 'Africa/Johannesburg',
      asOfLocalDate: '2026-09-28',
      provisional: true,
    });
    expect(reportQuality('2026-09-20', 'Africa/Johannesburg', [], 48, now).provisional).toBe(false);
    expect(reportQuality('2026-09-20', null, ['partial_day'], 48, now)).toMatchObject({
      provisional: true,
      flags: ['partial_day'],
    });
    expect(reportQuality('2026-09-20', null, ['not_final'], 48, now).provisional).toBe(true);
    // Sampling and thresholding are passed through as the platform said them; they do not make a day provisional.
    expect(reportQuality('2026-09-20', null, ['sampled', 'thresholded'], 48, now)).toMatchObject({
      provisional: false,
      flags: ['sampled', 'thresholded'],
    });
  });
  it('freshness ages a day from its end in the zone', () => {
    // Los Angeles: the 28th ends at 06:59:59.999Z on the 29th, after `now`; the age is 0, not 4 hours.
    expect(reportFreshness('2026-09-28', now, 48, now, 'America/Los_Angeles').ageHours).toBe(0);
    expect(reportFreshness('2026-09-28', now, 48, now).ageHours).toBe(4);
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
