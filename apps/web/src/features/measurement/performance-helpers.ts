import type { MetricValueDto } from './use-measurement';

const DAY_MS = 86_400_000;
/**
 * A post counts as not measured yet until a day after it reaches the age: the pull runs at the age from the actual
 * publication moment and may report late, so only after that is a missing number really missing.
 */
export const AGE_GRACE_DAYS = 1;

/** Sums one publication's values in one comparable group (a group is what may be added together, spec 15.2). */
export function groupValue(values: MetricValueDto[]): {
  value: number | null;
  stale: boolean;
  age: number | null;
} {
  const withData = values.filter((v) => v.value !== null && v.completeness !== 'unavailable');
  return {
    value: withData.length ? withData.reduce((s, v) => s + (v.value as number), 0) : null,
    stale: withData.some((v) => v.freshness.stale),
    age: withData.length ? Math.max(...withData.map((v) => v.freshness.ageHours)) : null,
  };
}

/** measured: a number at the age; missing: old enough, none came; not_yet: too young; unread: past the query cap. */
export type TrendStatus = 'measured' | 'missing' | 'not_yet' | 'unread';

export interface TrendPost {
  day: string;
  status: TrendStatus;
  value: number | null;
}

export function trendStatus(
  value: number | null,
  read: boolean,
  publishedAt: string,
  ageDays: number,
  now: number,
): TrendStatus {
  if (!read) return 'unread';
  if (value !== null) return 'measured';
  return now - Date.parse(publishedAt) < (ageDays + AGE_GRACE_DAYS) * DAY_MS ? 'not_yet' : 'missing';
}

export interface TrendDay {
  key: string;
  posts: number;
  measured: number;
  notYet: number;
  missing: number;
  unread: number;
  /** Mean per measured post; null when no post of the day has a number at the age. */
  perPost: number | null;
}

export const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

const measuredValues = (posts: TrendPost[]) =>
  posts.flatMap((p) => (p.status === 'measured' && p.value !== null ? [p.value] : []));

/** One entry per day key, in order; a day's mean uses only its measured posts, so a gap is never a zero. */
export function trendDays(posts: TrendPost[], dayKeys: string[]): TrendDay[] {
  return dayKeys.map((key) => {
    const mine = posts.filter((p) => p.day === key);
    const count = (s: TrendStatus) => mine.filter((p) => p.status === s).length;
    return {
      key,
      posts: mine.length,
      measured: count('measured'),
      notYet: count('not_yet'),
      missing: count('missing'),
      unread: count('unread'),
      perPost: mean(measuredValues(mine)),
    };
  });
}

/** The period's mean per measured post and the change against the baseline (null when either side has none). */
export function periodComparison(current: TrendPost[], previous: TrendPost[]) {
  const currentMean = mean(measuredValues(current));
  const baseline = mean(measuredValues(previous));
  return {
    currentMean,
    baseline,
    measured: measuredValues(current).length,
    change: currentMean !== null && baseline ? ((currentMean - baseline) / baseline) * 100 : null,
  };
}
