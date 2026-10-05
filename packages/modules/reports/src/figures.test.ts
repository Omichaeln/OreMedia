import { describe, expect, it } from 'vitest';
import type { MetricValueV1 } from '@oremedia/contracts/measurement';
import {
  channelsOf,
  compareMonthOf,
  composeFigures,
  factsOf,
  figuresOf,
  monthWindow,
  pooledRate,
  postPageOf,
  shiftMonth,
  type ReportPublication,
  type WindowData,
} from './figures';

const value = (subjectId: string, metricKey: string, comparableGroup: string, v: number | null, stale = false): MetricValueV1 => ({
  snapshotId: `ms_${subjectId}_${metricKey}`,
  subjectType: 'publication',
  subjectId,
  metricKey,
  comparableGroup,
  value: v,
  series: null,
  completeness: v === null ? 'unavailable' : 'complete',
  freshness: { fetchedAt: '2026-09-30T10:00:00.000Z', ageHours: 2, latencyHours: 24, stale },
  source: 'fixture',
  definitionVersion: 1,
  windowStart: '2026-09-01T00:00:00.000Z',
  windowEnd: '2026-09-30T23:59:59.999Z',
  brandTimezone: 'UTC',
  numeratorSnapshotId: null,
  denominatorSnapshotId: null,
});
const pub = (id: string, channel: string, day: number): ReportPublication => ({
  publicationId: id,
  contentRevisionId: `cr_${id}`,
  channelConnectionId: channel,
  scheduledFor: `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`,
});
/** n posts on a channel, each with impressions, engagement and its own reach. */
const month = (n: number, channel: string, impressions: number, engagement: number, reach: number): WindowData => {
  const publications = Array.from({ length: n }, (_, i) => pub(`${channel}_${i}`, channel, i + 1));
  const values = publications.flatMap((p) => [
    value(p.publicationId, 'impressions', 'impressions', impressions),
    value(p.publicationId, 'engagement', 'engagement', engagement),
    value(p.publicationId, 'reach', 'reach', reach),
  ]);
  return { publications, values };
};
const merge = (...windows: WindowData[]): WindowData => ({
  publications: windows.flatMap((w) => w.publications),
  values: windows.flatMap((w) => w.values),
});

describe('report figures (D-14, D-15)', () => {
  it('sums flows, pools the rate from the operands and never totals reach', () => {
    const current = month(6, 'cc_a', 100, 10, 80);
    const previous = month(5, 'cc_a', 80, 4, 70);
    const figures = figuresOf(current, previous, true);
    const by = (k: string) => figures.find((f) => f.key === k);
    expect(by('impressions')).toMatchObject({ kind: 'flow', value: 600, previous: 400, change: 0.5, notSummed: null });
    expect(by('engagement')).toMatchObject({ value: 60, previous: 20, change: 2 });
    expect(by('rate:engagement/impressions')).toMatchObject({ kind: 'rate', value: 0.1, previous: 0.05, change: 1 });
    expect(by('reach')).toMatchObject({ kind: 'unique', value: null, previous: null, change: null, notSummed: 'unique people: never summed across posts' });
    expect(by('reach')?.coverage).toEqual({ withData: 6, requested: 6 });
    expect(by('clicks')).toMatchObject({ value: null, change: null });
  });

  it('carries no change below the minimum sample on either side (insufficient sample)', () => {
    const current = month(6, 'cc_a', 100, 10, 80);
    const previous = month(4, 'cc_a', 80, 4, 70);
    const composed = composeFigures({
      brand: { id: 'brd', name: 'Acme', timeZone: 'UTC' },
      periodMonth: '2026-09',
      compareMode: 'previous_month',
      current,
      previous,
      trend: [{ month: '2026-09', data: current }],
      channels: [{ id: 'cc_a', providerKey: 'x', displayName: 'X' }],
      formats: [],
      recommendations: [],
      computedAt: new Date('2026-10-05T00:00:00Z'),
    });
    expect(composed.sample).toEqual({ current: 6, previous: 4, minimum: 5, sufficient: false });
    expect(composed.figures.find((f) => f.key === 'impressions')).toMatchObject({ value: 600, previous: 320, change: null });
    expect(factsOf(composed).join('\n')).toContain('insufficient sample');
  });

  it('pools the rate over posts carrying both operands, never a mean of per-post rates', () => {
    const byPost = new Map<string, MetricValueV1[]>([
      ['a', [value('a', 'impressions', 'impressions', 1000), value('a', 'engagement', 'engagement', 10)]],
      ['b', [value('b', 'impressions', 'impressions', 10), value('b', 'engagement', 'engagement', 5)]],
      ['c', [value('c', 'engagement', 'engagement', 50)]], // no impressions: left out, never a zero
    ]);
    expect(pooledRate(byPost)).toBeCloseTo(15 / 1010, 10);
    expect(pooledRate(new Map([['d', [value('d', 'impressions', 'impressions', 0), value('d', 'engagement', 'engagement', 1)]]]))).toBeNull();
  });

  it('rows a channel per connection with its own flows, pooled rate and share of impressions (never of reach)', () => {
    const current = merge(month(6, 'cc_a', 100, 10, 80), month(5, 'cc_b', 300, 6, 200));
    const previous = merge(month(5, 'cc_a', 50, 5, 40), month(2, 'cc_b', 100, 2, 90));
    const rows = channelsOf(
      [
        { id: 'cc_a', providerKey: 'x', displayName: 'X' },
        { id: 'cc_b', providerKey: 'linkedin', displayName: 'LinkedIn' },
        { id: 'cc_idle', providerKey: 'instagram', displayName: 'Idle' },
      ],
      current,
      previous,
    );
    expect(rows.map((r) => r.channelConnectionId)).toEqual(['cc_b', 'cc_a']);
    expect(rows[1]).toMatchObject({ publications: 6, previousPublications: 5, impressions: 600, engagement: 60, engagementRate: 0.1, impressionsChange: 1.4, sufficient: true, shareOfImpressions: 600 / 2100 });
    // Two posts the month before: no comparison for LinkedIn, but its share and rate stand.
    expect(rows[0]).toMatchObject({ impressions: 1500, impressionsChange: null, sufficient: false, shareOfImpressions: 1500 / 2100, engagementRate: 30 / 1500 });
    expect(rows[0]?.bestPublicationId).toBe('cc_b_0');
  });

  it('ranks posts by engagements, keeps each post’s reach, and lists the lowest rates below the line', () => {
    const current = month(8, 'cc_a', 100, 10, 80);
    // One post well ahead, one trailing, one without any number.
    current.values.push(value('cc_a_7', 'engagement', 'engagement', 90));
    current.values = current.values.map((v) => (v.subjectId === 'cc_a_0' && v.metricKey === 'engagement' ? { ...v, value: 1 } : v));
    current.publications.push(pub('cc_a_none', 'cc_a', 20));
    const page = postPageOf(current);
    expect(page.total).toBe(9);
    expect(page.withNumbers).toBe(8);
    expect(page.ranked[0]).toMatchObject({ publicationId: 'cc_a_7', engagement: 100, reach: 80, engagementRate: 1 });
    expect(page.ranked).toHaveLength(5);
    expect(page.lowest[0]).toMatchObject({ publicationId: 'cc_a_0', engagementRate: 0.01 });
    expect(page.topShare).toBeCloseTo((100 + 10 * 4) / (100 + 10 * 6 + 1), 10);
  });

  it('months: comparison, shifting and a month’s window in the brand’s zone', () => {
    expect(compareMonthOf('2026-01', 'previous_month')).toBe('2025-12');
    expect(compareMonthOf('2026-09', 'last_year')).toBe('2025-09');
    expect(shiftMonth('2026-09', -5)).toBe('2026-04');
    expect(monthWindow('2026-09', 'UTC')).toEqual({ start: new Date('2026-09-01T00:00:00.000Z'), end: new Date('2026-09-30T23:59:59.999Z') });
    expect(monthWindow('2026-09', 'Africa/Johannesburg').start.toISOString()).toBe('2026-08-31T22:00:00.000Z');
    expect(monthWindow('2026-03', 'Europe/London').end.toISOString()).toBe('2026-03-31T22:59:59.999Z');
  });

  it('the facts a draft may use name every figure with its coverage and say what is not totalled', () => {
    const current = month(6, 'cc_a', 100, 10, 80);
    const facts = factsOf(
      composeFigures({
        brand: { id: 'brd', name: 'Acme', timeZone: 'UTC' },
        periodMonth: '2026-09',
        compareMode: 'last_year',
        current,
        previous: month(5, 'cc_a', 80, 4, 70),
        trend: [],
        channels: [{ id: 'cc_a', providerKey: 'x', displayName: 'X' }],
        formats: [],
        recommendations: [{ id: 'rec', title: 'Post more', rationale: 'Because.', state: 'proposed', expectedBenefit: { metricKey: 'engagement', direction: 'up' }, rank: 1 }],
        computedAt: new Date('2026-10-05T00:00:00Z'),
      }),
    );
    expect(facts[0]).toContain('comparison: September 2025 (the same month last year)');
    expect(facts).toContain('Impressions: 600 (+50.0% vs Sep 2025); 6 of 6 posts have a number.');
    expect(facts).toContain('Reach: not totalled (unique people: never summed across posts).');
    expect(facts).toContain('Link clicks: no number reported this month.');
    expect(facts.some((f) => f.startsWith('Recommendation (proposed): Post more.'))).toBe(true);
  });
});
