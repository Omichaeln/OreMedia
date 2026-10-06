import type { MetricValueDto } from './use-measurement';
import { brandPath } from '../brand/brand-context';
import { dayKey } from '../publishing/publication-state';

export const PERIODS = [
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
] as const;
export const formatNumber = (v: number) => new Intl.NumberFormat().format(v);
export const percent = (v: number) => `${(v * 100).toFixed(1)}%`;
/** A value in the group's own unit (D-15): a rate as a percentage, everything else as a count. */
export const formatValue = (kind: string, v: number) => (kind === 'rate' ? percent(v) : formatNumber(v));
/** The calendar, opened on the publication's day in the brand zone with the publication selected. */
export const publicationCalendarHref = (
  companyId: string,
  brandId: string,
  publication: { publicationId: string; scheduledFor: string },
  timeZone: string,
) =>
  `${brandPath(companyId, brandId, 'calendar')}?publication=${encodeURIComponent(publication.publicationId)}&day=${dayKey(publication.scheduledFor, timeZone)}`;

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

// ---- UX-12 "when it lands": publication moments by weekday and slot in the brand's zone ----

export const SLOT_HOURS = 6;
export const SLOTS = ['00–06', '06–12', '12–18', '18–24'] as const;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Monday-first weekday (0 = Monday) and hour of an instant on the brand's wall clock. */
export function zoneWeekdayHour(iso: string, timeZone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
  }).formatToParts(new Date(iso));
  const weekday = WEEKDAYS.indexOf(
    (parts.find((p) => p.type === 'weekday')?.value ?? 'Mon') as (typeof WEEKDAYS)[number],
  );
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return { weekday: weekday < 0 ? 0 : weekday, hour: Number.isNaN(hour) ? 0 : hour };
}

export interface SlotPost {
  scheduledFor: string;
  engagement: number | null;
  impressions: number | null;
}
export interface SlotCell {
  weekday: number;
  slot: number;
  /** Publications in the cell, whatever their numbers. */
  publications: number;
  /** Publications whose engagement and impressions both exist: the rate's denominator in posts. */
  measured: number;
  /** Σ engagement ÷ Σ impressions over the measured posts (D-15), null when none. */
  rate: number | null;
}

/** 7 × 4 cells, every one present (an empty cell says 0 posts, never a rate). */
export function slotCells(posts: SlotPost[], timeZone: string): SlotCell[] {
  const cells: SlotCell[] = [];
  const sums = new Map<string, { engagement: number; impressions: number }>();
  const counts = new Map<string, { publications: number; measured: number }>();
  for (const p of posts) {
    const { weekday, hour } = zoneWeekdayHour(p.scheduledFor, timeZone);
    const key = `${weekday}:${Math.floor(hour / SLOT_HOURS)}`;
    const c = counts.get(key) ?? { publications: 0, measured: 0 };
    c.publications += 1;
    if (p.engagement !== null && p.impressions !== null && p.impressions > 0) {
      c.measured += 1;
      const s = sums.get(key) ?? { engagement: 0, impressions: 0 };
      s.engagement += p.engagement;
      s.impressions += p.impressions;
      sums.set(key, s);
    }
    counts.set(key, c);
  }
  for (let weekday = 0; weekday < WEEKDAYS.length; weekday += 1)
    for (let slot = 0; slot < SLOTS.length; slot += 1) {
      const key = `${weekday}:${slot}`;
      const c = counts.get(key) ?? { publications: 0, measured: 0 };
      const s = sums.get(key);
      cells.push({
        weekday,
        slot,
        publications: c.publications,
        measured: c.measured,
        rate: s && s.impressions > 0 ? s.engagement / s.impressions : null,
      });
    }
  return cells;
}

// ---- the interface's content table, freshness line, slot note and creative lift ----

/** The median of the numbers given (null when there are none); a missing number is left out, never a zero. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

/** A relative change against a reference: null when either side is missing or the reference is not positive. */
export const liftOf = (value: number | null, reference: number | null): number | null =>
  value === null || reference === null || reference <= 0 ? null : (value - reference) / reference;

/** A signed percentage with a true minus sign: "+24%", "−5%", "+0%". */
export const signedPercent = (change: number, digits = 0): string =>
  `${change < 0 ? '−' : '+'}${Math.abs(change * 100).toFixed(digits)}%`;

export interface ChannelFreshness {
  channelConnectionId: string;
  /** The oldest fetch among the channel's values: how old the channel's numbers can be. */
  ageHours: number;
  stale: boolean;
}

/**
 * The freshness line: per channel, the oldest fetch among the values its publications returned, stale when any is.
 * A channel whose publications returned nothing is left out (the coverage line says what has numbers).
 */
export function channelFreshness(
  values: ReadonlyArray<Pick<MetricValueDto, 'subjectId' | 'value' | 'freshness'>>,
  publications: ReadonlyArray<{ publicationId: string; channelConnectionId: string | null }>,
): ChannelFreshness[] {
  const channelOf = new Map(publications.map((p) => [p.publicationId, p.channelConnectionId]));
  const byChannel = new Map<string, ChannelFreshness>();
  for (const v of values) {
    const channel = channelOf.get(v.subjectId);
    if (!channel || v.value === null) continue;
    const seen = byChannel.get(channel);
    byChannel.set(channel, {
      channelConnectionId: channel,
      ageHours: Math.max(seen?.ageHours ?? 0, v.freshness.ageHours),
      stale: (seen?.stale ?? false) || v.freshness.stale,
    });
  }
  return [...byChannel.values()].sort((a, b) => a.ageHours - b.ageHours);
}

/** The slot with the highest rate among those with the minimum sample (D-14); null when no slot has it. */
export function bestSlot(cells: SlotCell[], minimum: number): SlotCell | null {
  let best: SlotCell | null = null;
  for (const c of cells)
    if (c.rate !== null && c.measured >= minimum && (best === null || c.rate > (best.rate ?? 0))) best = c;
  return best;
}
