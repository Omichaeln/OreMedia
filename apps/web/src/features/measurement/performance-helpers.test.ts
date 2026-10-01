import { describe, expect, it } from 'vitest';
import { periodComparison, slotCells, trendDays, trendStatus, type TrendPost } from './performance-helpers';

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
