import { describe, expect, it } from 'vitest';
import { periodComparison, trendDays, trendStatus, type TrendPost } from './performance-helpers';

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
