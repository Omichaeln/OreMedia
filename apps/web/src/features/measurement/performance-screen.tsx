import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Badge, Button, EmptyState, Skeleton, cn } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { PackageTitle } from '../content/package-title';
import { HomeSection } from '../home/section';
import { ageText } from '../intelligence/intelligence-helpers';
import { dayKey, trailingRange } from '../publishing/publication-state';
import { useCalendarRange, useChannels, type CalendarPublicationDto } from '../publishing/use-publishing';
import {
  useMetricDefinitions,
  usePublicationMetrics,
  type MetricAggregateDto,
  type MetricValueDto,
} from './use-measurement';

const PERIODS = [
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
] as const;

/** The comparable groups the screen reads, in reading order (spec 15.1 groups); other groups are not asked for. */
const GROUPS: ReadonlyArray<[group: string, label: string]> = [
  ['impressions', 'Impressions'],
  ['reach', 'Reach'],
  ['engagement', 'Engagement'],
  ['likes', 'Likes and reactions'],
  ['comments', 'Comments'],
  ['shares', 'Shares'],
  ['saves', 'Saves'],
  ['clicks', 'Clicks'],
];
const GROUP_LABEL = new Map(GROUPS);
const ENGAGEMENT_RATE = 'rate:engagement/impressions';
/** The query's own bounds (MetricsQuery: subjectIds ≤ 200, metricKeys ≤ 50). */
const MAX_SUBJECTS = 200;
const MAX_KEYS = 50;

const number = (v: number) => new Intl.NumberFormat().format(v);

interface Row {
  publication: CalendarPublicationDto;
  value: number | null;
  rate: number | null;
  stale: boolean;
  fetchedHoursAgo: number | null;
}

/** Sums one publication's values in one comparable group (a group is what may be added together, spec 15.2). */
function groupValue(values: MetricValueDto[]): { value: number | null; stale: boolean; age: number | null } {
  const withData = values.filter((v) => v.value !== null && v.completeness !== 'unavailable');
  return {
    value: withData.length ? withData.reduce((s, v) => s + (v.value as number), 0) : null,
    stale: withData.some((v) => v.freshness.stale),
    age: withData.length ? Math.max(...withData.map((v) => v.freshness.ageHours)) : null,
  };
}

/**
 * Performance (the v3 prototype's screen on this app's design language): what the brand's published posts did in a
 * period, from the numbers measurement holds. Every figure is the latest fetch inside the period with its freshness;
 * totals stay inside one comparable group; what was asked and not returned is said, never shown as zero.
 */
export function PerformanceScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const timeZone = brand.timezone || 'UTC';
  const [params, setParams] = useSearchParams();
  const days = PERIODS.find(([d]) => String(d) === params.get('period'))?.[0] ?? 30;
  const channelFilter = params.get('channel');
  const todayKey = dayKey(new Date(), timeZone);
  const range = useMemo(() => trailingRange(days, todayKey, timeZone), [days, todayKey, timeZone]);

  const calendar = useCalendarRange(brandId, range.from, range.to);
  const channels = useChannels(brandId);
  const definitions = useMetricDefinitions();

  const published = useMemo(
    () =>
      (calendar.data?.publications ?? [])
        .filter((p) => p.state === 'published' && (!channelFilter || p.channelConnectionId === channelFilter))
        .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor)),
    [calendar.data, channelFilter],
  );
  const subjects = useMemo(() => published.slice(0, MAX_SUBJECTS), [published]);
  const subjectIds = useMemo(() => subjects.map((p) => p.publicationId), [subjects]);
  // The register lists every provider's metrics; only the brand's own channels can have numbers here.
  const brandProviders = useMemo(
    () => new Set((channels.data ?? []).map((c) => c.providerKey)),
    [channels.data],
  );
  const allKeys = useMemo(
    () => [
      ...new Set(
        (definitions.data ?? [])
          .filter(
            (d) =>
              (d.providerKey === null || brandProviders.has(d.providerKey)) &&
              d.aggregation !== 'series' &&
              (GROUP_LABEL.has(d.comparableGroup) || d.comparableGroup === ENGAGEMENT_RATE),
          )
          .map((d) => d.key),
      ),
    ],
    [definitions.data, brandProviders],
  );
  const metricKeys = allKeys.slice(0, MAX_KEYS);
  const metrics = usePublicationMetrics(brandId, subjectIds, metricKeys, range.from, range.to);
  // With no posts the query is disabled and holds nothing for this period or channel.
  const current = subjectIds.length > 0 ? metrics.data : undefined;

  const aggregates = useMemo(
    () =>
      GROUPS.flatMap(([group, label]) => {
        const a = current?.aggregates.find((x) => x.comparableGroup === group);
        return a ? [{ ...a, label }] : [];
      }),
    [current],
  );
  const selected =
    aggregates.find((a) => a.comparableGroup === params.get('metric')) ??
    aggregates.find((a) => a.value !== null) ??
    null;

  const rows: Row[] = useMemo(() => {
    const values = current?.values ?? [];
    return subjects.map((p) => {
      const mine = values.filter((v) => v.subjectId === p.publicationId);
      const g = groupValue(mine.filter((v) => v.comparableGroup === selected?.comparableGroup));
      const rate = mine.find((v) => v.comparableGroup === ENGAGEMENT_RATE && v.value !== null)?.value ?? null;
      return { publication: p, value: g.value, rate, stale: g.stale, fetchedHoursAgo: g.age };
    });
  }, [current, subjects, selected?.comparableGroup]);
  const sorted = [...rows].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const max = Math.max(0, ...rows.map((r) => r.value ?? 0));

  const channelName = (id: string) => {
    const c = channels.data?.find((x) => x.id === id);
    return c ? c.displayName : id;
  };
  const byChannel = useMemo(() => {
    const totals = new Map<string, { value: number; publications: number }>();
    for (const r of rows) {
      if (r.value === null) continue;
      const t = totals.get(r.publication.channelConnectionId) ?? { value: 0, publications: 0 };
      totals.set(r.publication.channelConnectionId, {
        value: t.value + r.value,
        publications: t.publications + 1,
      });
    }
    return [...totals.entries()].sort((a, b) => b[1].value - a[1].value);
  }, [rows]);
  const channelMax = Math.max(0, ...byChannel.map(([, t]) => t.value));

  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };
  const calendarHref = brandPath(companyId, brandId, 'calendar');
  const queries = [calendar, channels, definitions];
  const failed = [...queries, metrics].find((q) => q.isError);
  const loading = queries.some((q) => q.isPending) || (metrics.isPending && metrics.fetchStatus !== 'idle');
  const coverage = current?.coverage;

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Performance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {brand.name} · published posts in the last {days} days · every number with its freshness
          </p>
        </div>
        <div role="group" aria-label="Period" className="flex gap-1">
          {PERIODS.map(([d, label]) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'secondary' : 'ghost'}
              aria-pressed={days === d}
              onClick={() => update({ period: String(d) })}
            >
              {label}
            </Button>
          ))}
        </div>
      </header>

      {(channels.data?.length ?? 0) > 1 && (
        <div role="group" aria-label="Channel" className="-mt-4 flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={!channelFilter ? 'secondary' : 'ghost'}
            aria-pressed={!channelFilter}
            onClick={() => update({ channel: null })}
          >
            All channels
          </Button>
          {(channels.data ?? []).map((c) => (
            <Button
              key={c.id}
              size="sm"
              variant={channelFilter === c.id ? 'secondary' : 'ghost'}
              aria-pressed={channelFilter === c.id}
              onClick={() => update({ channel: c.id })}
            >
              {c.displayName}
            </Button>
          ))}
        </div>
      )}

      {failed && (
        <RequestError
          error={failed.error}
          title="Part of this screen could not load"
          onRetry={() => [...queries, metrics].forEach((q) => void q.refetch())}
        />
      )}
      {loading && <Skeleton label="Loading performance" lines={4} />}

      {!loading && calendar.isSuccess && published.length === 0 && (
        <EmptyState
          title={`Nothing published in the last ${days} days`}
          description={
            channelFilter
              ? 'No publication on this channel reached published in the period.'
              : 'Numbers appear here once posts publish and their channels report back.'
          }
        />
      )}
      {!loading && definitions.isSuccess && published.length > 0 && metricKeys.length === 0 && (
        <EmptyState
          title="No metric definitions"
          description="No connected provider declares post metrics this screen reads, so there is nothing to ask for."
        />
      )}

      {current && (
        <>
          <section aria-labelledby="totals-heading" className="flex flex-col gap-3">
            <h2 id="totals-heading" className="sr-only">
              Totals
            </h2>
            {aggregates.length === 0 ? (
              <EmptyState
                title="No numbers yet"
                description="Measurement holds no values for these publications in the period. Collection runs after each post publishes, at the channel's reporting delay."
              />
            ) : (
              <div
                role="group"
                aria-label="Metric"
                className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3"
              >
                {aggregates.map((a) => (
                  <MetricTile
                    key={a.comparableGroup}
                    aggregate={a}
                    label={a.label}
                    requested={subjects.length}
                    pressed={selected?.comparableGroup === a.comparableGroup}
                    onSelect={() => update({ metric: a.comparableGroup })}
                  />
                ))}
              </div>
            )}
            {coverage && (
              <p className="text-xs text-muted-foreground" data-testid="coverage">
                {coverage.subjectsWithData} of {coverage.subjectsRequested}{' '}
                {coverage.subjectsRequested === 1 ? 'publication has' : 'publications have'} numbers
                {coverage.staleValues > 0 &&
                  ` · ${coverage.staleValues} stale ${coverage.staleValues === 1 ? 'value' : 'values'}`}
                {' · '}totals add only numbers of the same kind across channels; a missing number is never
                counted as zero
                {published.length > MAX_SUBJECTS &&
                  ` · the newest ${MAX_SUBJECTS} of ${published.length} publications`}
                {allKeys.length > MAX_KEYS && ` · the first ${MAX_KEYS} of ${allKeys.length} metrics`}
              </p>
            )}
          </section>

          {selected && (
            <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <HomeSection id="posts-heading" title={`Posts by ${selected.label.toLowerCase()}`}>
                <ol className="flex flex-col divide-y divide-border" data-testid="performance-posts">
                  {sorted.map((r) => (
                    <li key={r.publication.publicationId} className="flex flex-col gap-1.5 py-3 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <Link
                          to={`${calendarHref}?publication=${encodeURIComponent(r.publication.publicationId)}&day=${dayKey(r.publication.scheduledFor, timeZone)}`}
                          className="min-w-0 font-medium underline-offset-2 hover:underline"
                        >
                          <PackageTitle contentPackageId={r.publication.contentPackageId} />
                        </Link>
                        <span className="tabular-nums">
                          {r.value === null ? <Badge tone="neutral">Unavailable</Badge> : number(r.value)}
                        </span>
                      </div>
                      <Bar value={r.value} max={max} />
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>{channelName(r.publication.channelConnectionId)}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {new Date(r.publication.scheduledFor).toLocaleDateString(undefined, {
                            timeZone,
                            day: 'numeric',
                            month: 'short',
                          })}
                        </span>
                        {r.rate !== null && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{(r.rate * 100).toFixed(1)}% engagement rate</span>
                          </>
                        )}
                        {r.fetchedHoursAgo !== null && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>fetched {ageText(r.fetchedHoursAgo)}</span>
                          </>
                        )}
                        {r.stale && <Badge tone="warning">Stale</Badge>}
                      </p>
                    </li>
                  ))}
                </ol>
              </HomeSection>

              <HomeSection id="channels-heading" title="By channel">
                {byChannel.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No channel returned {selected.label.toLowerCase()}.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border" data-testid="performance-channels">
                    {byChannel.map(([id, t]) => (
                      <li key={id} className="flex flex-col gap-1.5 py-3 text-sm">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 break-words">{channelName(id)}</span>
                          <span className="tabular-nums">{number(t.value)}</span>
                        </div>
                        <Bar value={t.value} max={channelMax} />
                        <p className="text-xs text-muted-foreground">
                          {t.publications} {t.publications === 1 ? 'publication' : 'publications'} with
                          numbers
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </HomeSection>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function MetricTile({
  aggregate,
  label,
  requested,
  pressed,
  onSelect,
}: {
  aggregate: MetricAggregateDto;
  label: string;
  requested: number;
  pressed: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background p-4 text-left',
        'hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed && 'border-foreground/40 bg-secondary',
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">
        {aggregate.value === null ? 'Unavailable' : number(aggregate.value)}
      </span>
      <span className="text-xs text-muted-foreground">
        {aggregate.subjectsWithData} of {requested} {requested === 1 ? 'post' : 'posts'}
        {aggregate.freshness && ` · oldest ${ageText(aggregate.freshness.ageHours)}`}
      </span>
      {aggregate.stale && (
        <span>
          <Badge tone="warning">Stale</Badge>
        </span>
      )}
    </button>
  );
}

/** A magnitude bar from a shared zero; the number beside it is the record, the bar only helps comparison. */
function Bar({ value, max }: { value: number | null; max: number }) {
  const width = !value || max === 0 ? 0 : Math.max(1, (value / max) * 100);
  return (
    <span aria-hidden="true" className="block h-1.5 w-full rounded-full bg-secondary">
      <span className="block h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
    </span>
  );
}
