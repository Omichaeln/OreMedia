import { useMemo, useState } from 'react';
import type { MetricAgeDays } from '@oremedia/contracts/measurement';
import { Skeleton, cn } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { dayKey, trailingRange, wasReleased } from '../publishing/publication-state';
import { useCalendarRange, type CalendarPublicationDto } from '../publishing/use-publishing';
import {
  groupValue,
  periodComparison,
  trendDays,
  trendStatus,
  type TrendDay,
  type TrendPost,
} from './performance-helpers';
import { PerformanceCard } from './performance-panels';
import { usePublicationValues } from './use-measurement';

export const AGES: ReadonlyArray<[MetricAgeDays, string]> = [
  [1, '1 day'],
  [3, '3 days'],
  [7, '7 days'],
  [28, '28 days'],
];
const DAY_MS = 86_400_000;

const number = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v);
/** Axis ticks and the readout: 1.68k, 842 (the table and the summary keep the full number). */
const compact = (v: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const publishedIn = (list: CalendarPublicationDto[] | undefined, channelFilter: string | null) =>
  (list ?? [])
    .filter(
      (p) =>
        // A website article (R2-3) has no post metrics: it is measured through the brand's web sources.
        p.channelConnectionId !== null &&
        wasReleased(p.state) &&
        (!channelFilter || p.channelConnectionId === channelFilter),
    )
    .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor));

/**
 * The daily trend on Performance: posts by the day they were published, each measured at the same age, so a post
 * from yesterday is not set against one from last month. Collection pulls a post's lifetime total at +1 h, +1 d,
 * +3 d, +7 d, +28 d and weekly after, so there is no honest per-calendar-day activity series; this is the series
 * the numbers support. The baseline is the previous period of the same length, measured the same way. Every post
 * of both periods is read (page by page), so no day's posts stand unread.
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
  const metrics = usePublicationValues(brandId, groupKeys, prior.from, range.to, {
    ageDays,
    channelConnectionId: channelFilter,
    enabled: thisPeriod.length + lastPeriod.length > 0,
  });

  const now = Date.now();
  const atAge = (posts: CalendarPublicationDto[]): TrendPost[] =>
    posts.map((p) => {
      const { value } = groupValue(
        metrics.items.filter(
          (v) => v.subjectId === p.publicationId && v.comparableGroup === group.comparableGroup,
        ),
      );
      return {
        day: dayKey(p.scheduledFor, timeZone),
        value,
        status: trendStatus(value, true, p.scheduledFor, ageDays, now),
      };
    });
  const currentPosts = metrics.complete ? atAge(thisPeriod) : [];
  const priorPosts = metrics.complete ? atAge(lastPeriod) : [];
  // The midday of each local day, so a daylight-saving change never skips or repeats a key.
  const dayKeys = Array.from({ length: days }, (_, i) =>
    dayKey(new Date(Date.parse(range.from) + i * DAY_MS + DAY_MS / 2), timeZone),
  );
  const series = trendDays(currentPosts, dayKeys);
  const { currentMean, baseline, measured, change } = periodComparison(currentPosts, priorPosts);
  const notYetNow = currentPosts.filter((p) => p.status === 'not_yet').length;
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
        ]
          .filter(Boolean)
          .join(', ');

  const failed = [current, previous, metrics].find((q) => q.isError);
  const loading = current.isPending || previous.isPending || (metrics.isPending && !metrics.isError);
  const [hovered, setHovered] = useState<string | null>(null);
  const hoveredDay = series.find((d) => d.key === hovered) ?? null;
  const peak = Math.max(0, ...series.map((d) => d.perPost ?? 0));
  const readout = hoveredDay
    ? describe(hoveredDay)
    : currentMean === null
      ? ''
      : `Peak ${compact(peak)}${baseline !== null ? ` · previous ${days} days ${compact(baseline)}` : ''}`;
  const tickKeys = [0, Math.floor((series.length - 1) / 2), series.length - 1]
    .filter((i, n, all) => all.indexOf(i) === n)
    .map((i) => series[i]?.key ?? todayKey);

  return (
    <PerformanceCard
      id="trend-heading"
      title={`${group.label} per post · last ${days} days`}
      meta={
        <span className="tabular-nums text-foreground" aria-live="polite" data-testid="trend-readout">
          {readout}
        </span>
      }
      testId="daily-trend"
    >
      <div className="-mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-xs text-muted-foreground">
          By day published, each post measured {ageLabel} after · the dashed line is the previous {days} days
          · dots mark days with publications
        </p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Measured at</span>
          <div
            role="group"
            aria-label="Measured at"
            className="flex h-7 overflow-hidden rounded-md border border-border bg-card"
          >
            {AGES.map(([a, label]) => (
              <button
                key={a}
                type="button"
                aria-pressed={ageDays === a}
                onClick={() => onAgeChange(a)}
                className={cn(
                  'h-full px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  ageDays === a ? 'bg-secondary font-medium' : 'hover:bg-card-tint',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {failed && <RequestError error={failed.error} onRetry={() => void failed.refetch()} />}
      {loading && <Skeleton label="Loading the daily trend" lines={3} />}
      {metrics.complete && (
        <>
          <p className="text-sm" data-testid="trend-summary">
            {currentMean === null ? (
              <span className="text-muted-foreground">
                No post in this period has a number at {ageLabel} yet
                {notYetNow > 0 && ` · ${notYetNow} not measured at ${ageLabel} yet`}.
              </span>
            ) : (
              <>
                <span className="font-bold tabular-nums">{number(currentMean)}</span> per post at {ageLabel}{' '}
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
          <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-accent" />
              {group.label} per post at {ageLabel}
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="w-4 border-t-2 border-dashed border-muted-foreground" />
              Previous {days} days
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
              Publications
            </li>
          </ul>
          <div className="relative h-[232px]" onMouseLeave={() => setHovered(null)}>
            <div
              aria-hidden="true"
              className="absolute top-0 bottom-8 left-0 flex w-10 flex-col justify-between text-right text-2xs text-muted-foreground tabular-nums"
            >
              <span className="-translate-y-1/2">{compact(top)}</span>
              <span className="-translate-y-1/2">{compact(top / 2)}</span>
              <span className="translate-y-1/2">0</span>
            </div>
            <div className="absolute top-0 right-0 bottom-8 left-11">
              <div aria-hidden="true" className="absolute inset-x-0 top-0 border-t border-border" />
              <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-border" />
              <div aria-hidden="true" className="absolute inset-x-0 bottom-0 border-t border-border-strong" />
              {baseline !== null && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-dashed border-muted-foreground"
                  style={{ bottom: `${(baseline / top) * 100}%` }}
                />
              )}
              <div className="absolute inset-0 flex items-end gap-[2px]">
                {series.map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    aria-label={describe(d)}
                    data-testid="trend-day"
                    onMouseEnter={() => setHovered(d.key)}
                    onFocus={() => setHovered(d.key)}
                    onBlur={() => setHovered(null)}
                    className={cn(
                      'relative flex h-full min-w-0 flex-1 items-end justify-center rounded-t-[4px]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      hovered === d.key && 'bg-muted',
                    )}
                  >
                    {d.perPost !== null ? (
                      <span
                        className="block w-full max-w-6 rounded-t-[4px] bg-accent"
                        style={{ height: `${Math.max(1, (d.perPost / top) * 100)}%` }}
                      />
                    ) : d.posts > 0 ? (
                      // Posts without a number at this age: an outline, never a filled bar a reader could size.
                      <span className="block h-2 w-full max-w-6 rounded-t-[4px] border border-b-0 border-dashed border-muted-foreground" />
                    ) : null}
                    {d.posts > 0 && (
                      <span
                        aria-hidden="true"
                        className="absolute -bottom-3 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-muted-foreground"
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div
              aria-hidden="true"
              className="absolute right-0 bottom-0 left-11 flex justify-between text-2xs text-muted-foreground tabular-nums"
            >
              {tickKeys.map((k) => (
                <span key={k}>{dayLabel(k)}</span>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            A dashed outline marks a day whose posts have no number at {ageLabel} yet. Collection pulls
            lifetime totals at fixed ages, so a per-calendar-day activity count is not shown.
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
                    </tr>
                  ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </PerformanceCard>
  );
}
