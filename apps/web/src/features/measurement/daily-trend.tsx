import { useMemo } from 'react';
import type { MetricAgeDays } from '@oremedia/contracts/measurement';
import { Button, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { Tooltip } from '../../components/tooltip';
import { dayKey, trailingRange } from '../publishing/publication-state';
import { useCalendarRange, type CalendarPublicationDto } from '../publishing/use-publishing';
import {
  groupValue,
  periodComparison,
  trendDays,
  trendStatus,
  type TrendDay,
  type TrendPost,
} from './performance-helpers';
import { usePublicationMetrics } from './use-measurement';

export const AGES: ReadonlyArray<[MetricAgeDays, string]> = [
  [1, '1 day'],
  [3, '3 days'],
  [7, '7 days'],
  [28, '28 days'],
];
const DAY_MS = 86_400_000;
/** The query's own bound (MetricsQuery: subjectIds ≤ 200); this period's posts first, then the previous period's. */
const MAX_SUBJECTS = 200;

const number = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const publishedIn = (list: CalendarPublicationDto[] | undefined, channelFilter: string | null) =>
  (list ?? [])
    .filter((p) => p.state === 'published' && (!channelFilter || p.channelConnectionId === channelFilter))
    .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor));

/**
 * The daily trend on Performance: posts by the day they were published, each measured at the same age, so a post
 * from yesterday is not set against one from last month. Collection pulls a post's lifetime total at +1 h, +1 d,
 * +3 d, +7 d, +28 d and weekly after, so there is no honest per-calendar-day activity series; this is the series
 * the numbers support. The baseline is the previous period of the same length, measured the same way.
 */
export function DailyTrend({
  brandId,
  timeZone,
  days,
  range,
  todayKey,
  channelFilter,
  group,
  groupKeys,
  ageDays,
  onAgeChange,
}: {
  brandId: string;
  timeZone: string;
  days: number;
  range: { from: string; to: string };
  todayKey: string;
  channelFilter: string | null;
  group: { comparableGroup: string; label: string };
  /** Only the selected group's metric keys are asked for, so the query's row bound is spent on them. */
  groupKeys: string[];
  ageDays: MetricAgeDays;
  onAgeChange: (age: MetricAgeDays) => void;
}) {
  const prior = useMemo(
    () => trailingRange(days, dayKey(new Date(Date.parse(range.from) - 1), timeZone), timeZone),
    [days, range.from, timeZone],
  );
  const current = useCalendarRange(brandId, range.from, range.to);
  const previous = useCalendarRange(brandId, prior.from, prior.to);
  const thisPeriod = useMemo(
    () => publishedIn(current.data?.publications, channelFilter),
    [current.data, channelFilter],
  );
  const lastPeriod = useMemo(
    () => publishedIn(previous.data?.publications, channelFilter),
    [previous.data, channelFilter],
  );
  const subjectIds = useMemo(
    () => [...thisPeriod, ...lastPeriod].slice(0, MAX_SUBJECTS).map((p) => p.publicationId),
    [thisPeriod, lastPeriod],
  );
  const metrics = usePublicationMetrics(brandId, subjectIds, groupKeys, prior.from, range.to, ageDays);

  const now = Date.now();
  const read = new Set(subjectIds);
  const atAge = (posts: CalendarPublicationDto[]): TrendPost[] =>
    posts.map((p) => {
      const { value } = groupValue(
        (metrics.data?.values ?? []).filter(
          (v) => v.subjectId === p.publicationId && v.comparableGroup === group.comparableGroup,
        ),
      );
      return {
        day: dayKey(p.scheduledFor, timeZone),
        value,
        status: trendStatus(value, read.has(p.publicationId), p.scheduledFor, ageDays, now),
      };
    });
  const currentPosts = metrics.data ? atAge(thisPeriod) : [];
  const priorPosts = metrics.data ? atAge(lastPeriod) : [];
  // The midday of each local day, so a daylight-saving change never skips or repeats a key.
  const dayKeys = Array.from({ length: days }, (_, i) =>
    dayKey(new Date(Date.parse(range.from) + i * DAY_MS + DAY_MS / 2), timeZone),
  );
  const series = trendDays(currentPosts, dayKeys);
  const { currentMean, baseline, measured, change } = periodComparison(currentPosts, priorPosts);
  const notYetNow = currentPosts.filter((p) => p.status === 'not_yet').length;
  const unread = [...currentPosts, ...priorPosts].filter((p) => p.status === 'unread').length;
  const top = Math.max(1, baseline ?? 0, ...series.map((d) => d.perPost ?? 0)) * 1.1;

  const ageLabel = AGES.find(([a]) => a === ageDays)?.[1] ?? `${ageDays} days`;
  const dayLabel = (key: string) =>
    new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
  const describe = (d: TrendDay) =>
    d.posts === 0
      ? `${dayLabel(d.key)}: nothing published`
      : [
          `${dayLabel(d.key)}: ${plural(d.posts, 'post', 'posts')}`,
          d.perPost !== null && `${number(d.perPost)} per post at ${ageLabel}`,
          d.notYet > 0 && `${d.notYet} not measured at ${ageLabel} yet`,
          d.missing > 0 && `${d.missing} without a number`,
          d.unread > 0 && `${d.unread} not read`,
        ]
          .filter(Boolean)
          .join(', ');

  const failed = [current, previous, metrics].find((q) => q.isError);
  const loading =
    current.isPending || previous.isPending || (metrics.isPending && metrics.fetchStatus !== 'idle');

  return (
    <Section id="trend-heading" title={`${group.label} per post by day published`} testId="daily-trend">
      <div role="group" aria-label="Measured at" className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground">Measured at</span>
        {AGES.map(([a, label]) => (
          <Button
            key={a}
            size="sm"
            variant={ageDays === a ? 'secondary' : 'ghost'}
            aria-pressed={ageDays === a}
            onClick={() => onAgeChange(a)}
          >
            {label}
          </Button>
        ))}
      </div>
      {failed && <RequestError error={failed.error} onRetry={() => void failed.refetch()} />}
      {loading && <Skeleton label="Loading the daily trend" lines={3} />}
      {metrics.data && (
        <>
          <p className="text-sm" data-testid="trend-summary">
            {currentMean === null ? (
              <span className="text-muted-foreground">
                No post in this period has a number at {ageLabel} yet
                {notYetNow > 0 && ` · ${notYetNow} not measured at ${ageLabel} yet`}.
              </span>
            ) : (
              <>
                <span className="font-semibold tabular-nums">{number(currentMean)}</span> per post at{' '}
                {ageLabel}{' '}
                <span className="text-muted-foreground">
                  across {measured} of {plural(currentPosts.length, 'post', 'posts')}
                  {baseline !== null
                    ? ` · previous ${days} days ${number(baseline)}`
                    : ` · no numbers at ${ageLabel} in the previous ${days} days`}
                </span>
                {change !== null && (
                  <span className="tabular-nums">
                    {' '}
                    ({change >= 0 ? '+' : '−'}
                    {Math.abs(change).toFixed(1)}%)
                  </span>
                )}
              </>
            )}
          </p>
          <div className="relative mt-2 flex h-40 items-end gap-[2px] border-b border-border">
            {baseline !== null && (
              <div
                className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-muted-foreground/60"
                style={{ bottom: `${(baseline / top) * 100}%` }}
              >
                <span className="absolute -top-5 right-0 bg-background px-1 text-xs text-muted-foreground">
                  Previous {days} days
                </span>
              </div>
            )}
            {series.map((d) => (
              <Tooltip key={d.key} content={describe(d)}>
                <button
                  type="button"
                  aria-label={describe(d)}
                  data-testid="trend-day"
                  className="flex h-full min-w-0 flex-1 items-end focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {d.perPost !== null ? (
                    <span
                      className="block w-full rounded-t-[4px] bg-accent"
                      style={{ height: `${Math.max(1, (d.perPost / top) * 100)}%` }}
                    />
                  ) : d.posts > 0 ? (
                    // Posts without a number at this age: an outline, never a filled bar a reader could size.
                    <span className="block h-2 w-full rounded-t-[4px] border border-b-0 border-dashed border-muted-foreground/60" />
                  ) : null}
                </button>
              </Tooltip>
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{dayLabel(series[0]?.key ?? todayKey)}</span>
            <span>{dayLabel(todayKey)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Each post counts on the day it was published, measured {ageLabel} after; a dashed outline marks a
            day whose posts have no number at that age. Collection pulls lifetime totals at fixed ages, so a
            per-calendar-day activity count is not shown.
            {unread > 0 &&
              ` ${plural(unread, 'post was', 'posts were')} not read: only ${MAX_SUBJECTS} posts are asked for, this period's newest first.`}
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Show as a table</summary>
            <table className="mt-2 w-full text-left text-xs tabular-nums" data-testid="trend-table">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Day</th>
                  <th className="py-1 font-medium">Posts</th>
                  <th className="py-1 font-medium">Per post at {ageLabel}</th>
                  <th className="py-1 font-medium">Not measured yet</th>
                  <th className="py-1 font-medium">Without a number</th>
                  <th className="py-1 font-medium">Not read</th>
                </tr>
              </thead>
              <tbody>
                {series
                  .filter((d) => d.posts > 0)
                  .map((d) => (
                    <tr key={d.key} className="border-t border-border">
                      <td className="py-1">{dayLabel(d.key)}</td>
                      <td className="py-1">{d.posts}</td>
                      <td className="py-1">{d.perPost === null ? '—' : number(d.perPost)}</td>
                      <td className="py-1">{d.notYet}</td>
                      <td className="py-1">{d.missing}</td>
                      <td className="py-1">{d.unread}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Section>
  );
}
