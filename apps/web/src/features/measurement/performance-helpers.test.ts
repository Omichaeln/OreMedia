import { describe, expect, it } from 'vitest';
import {
  bestSlot,
  channelFreshness,
  liftOf,
  median,
  periodComparison,
  signedPercent,
  slotCells,
  trendDays,
  trendStatus,
  type TrendPost,
} from './performance-helpers';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('trendStatus', () => {
  it('a post past the query cap is unread, whatever its age', () => {
    expect(trendStatus(null, false, daysAgo(40), 7, NOW)).toBe('unread');
  });
  it('a number is measured; none within a day of reaching the age is not yet; none after that is missing', () => {
    expect(trendStatus(120, true, daysAgo(10), 7, NOW)).toBe('measured');
    expect(trendStatus(null, true, daysAgo(3), 7, NOW)).toBe('not_yet');
    expect(trendStatus(null, true, daysAgo(7.5), 7, NOW)).toBe('not_yet');
    expect(trendStatus(null, true, daysAgo(8.5), 7, NOW)).toBe('missing');
  });
});

describe('trendDays', () => {
  it('means only measured posts per day, counts the rest by status, and keeps empty days', () => {
    const posts: TrendPost[] = [
      { day: '2026-09-20', status: 'measured', value: 100 },
      { day: '2026-09-20', status: 'measured', value: 300 },
      { day: '2026-09-20', status: 'missing', value: null },
      { day: '2026-09-22', status: 'not_yet', value: null },
      { day: '2026-09-22', status: 'unread', value: null },
    ];
    const days = trendDays(posts, ['2026-09-20', '2026-09-21', '2026-09-22']);
    expect(days[0]).toMatchObject({ posts: 3, measured: 2, missing: 1, perPost: 200 });
    expect(days[1]).toMatchObject({ posts: 0, perPost: null });
    expect(days[2]).toMatchObject({ posts: 2, notYet: 1, unread: 1, perPost: null });
  });
});

describe('periodComparison', () => {
  it('compares means per measured post; no baseline, or a zero one, gives no change', () => {
    const m = (value: number): TrendPost => ({ day: 'd', status: 'measured', value });
    expect(periodComparison([m(150), m(250)], [m(100)])).toEqual({
      currentMean: 200,
      baseline: 100,
      measured: 2,
      change: 100,
    });
    expect(periodComparison([m(150)], []).change).toBeNull();
    expect(periodComparison([m(150)], [m(0)]).change).toBeNull();
    expect(periodComparison([], [m(10)]).currentMean).toBeNull();
  });
});

describe('slotCells (UX-12 "when it lands")', () => {
  it('places posts by weekday and six-hour slot on the brand clock and pools the rate per cell', () => {
    // 2026-09-21 is a Monday; 23:30 UTC is Tuesday 01:30 in Berlin (slot 0), 09:00 and 08:00 UTC are Monday 11:00 and 10:00 (slot 1).
    const cells = slotCells(
      [
        { scheduledFor: '2026-09-21T09:00:00.000Z', engagement: 10, impressions: 100 },
        { scheduledFor: '2026-09-21T08:00:00.000Z', engagement: 30, impressions: 100 },
        { scheduledFor: '2026-09-21T23:30:00.000Z', engagement: null, impressions: 50 },
      ],
      'Europe/Berlin',
    );
    expect(cells).toHaveLength(28);
    expect(cells.find((c) => c.weekday === 0 && c.slot === 1)).toEqual({
      weekday: 0,
      slot: 1,
      publications: 2,
      measured: 2,
      rate: 40 / 200, // pooled, not the mean of 0.1 and 0.3
    });
    expect(cells.find((c) => c.weekday === 1 && c.slot === 0)).toEqual({
      weekday: 1,
      slot: 0,
      publications: 1,
      measured: 0,
      rate: null,
    });
    expect(cells.filter((c) => c.publications === 0)).toHaveLength(26);
  });
});

describe('median and lift (the content table’s vs. median)', () => {
  it('takes the middle of the numbers given, the mean of the two middles when even, null when none', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it('a lift needs both sides and a positive reference', () => {
    expect(liftOf(150, 100)).toBeCloseTo(0.5);
    expect(liftOf(null, 100)).toBeNull();
    expect(liftOf(10, 0)).toBeNull();
    expect(liftOf(10, null)).toBeNull();
  });
  it('signs a change with a true minus', () => {
    expect(signedPercent(0.24)).toBe('+24%');
    expect(signedPercent(-0.05)).toBe('−5%');
    expect(signedPercent(0)).toBe('+0%');
  });
});

describe('channelFreshness', () => {
  const value = (subjectId: string, ageHours: number, stale = false, v: number | null = 1) => ({
    subjectId,
    value: v,
    freshness: { fetchedAt: '2026-09-26T00:00:00Z', ageHours, latencyHours: 24, stale },
  });
  it('per channel, the oldest fetch among values with a number; stale when any is; channels without numbers left out', () => {
    const publications = [
      { publicationId: 'a', channelConnectionId: 'cc_x' },
      { publicationId: 'b', channelConnectionId: 'cc_x' },
      { publicationId: 'c', channelConnectionId: 'cc_li' },
      { publicationId: 'd', channelConnectionId: 'cc_ig' },
    ];
    const out = channelFreshness(
      [value('a', 2), value('b', 5), value('c', 60, true), value('d', 1, false, null)],
      publications,
    );
    expect(out).toEqual([
      { channelConnectionId: 'cc_x', ageHours: 5, stale: false },
      { channelConnectionId: 'cc_li', ageHours: 60, stale: true },
    ]);
  });
});

describe('bestSlot', () => {
  it('is the highest rate among slots with the minimum sample, null when none has it', () => {
    const cells = [
      { weekday: 0, slot: 1, publications: 6, measured: 5, rate: 0.04 },
      { weekday: 1, slot: 1, publications: 6, measured: 6, rate: 0.05 },
      { weekday: 2, slot: 2, publications: 2, measured: 2, rate: 0.2 },
    ];
    expect(bestSlot(cells, 5)).toMatchObject({ weekday: 1, slot: 1 });
    expect(bestSlot(cells, 10)).toBeNull();
  });
});
