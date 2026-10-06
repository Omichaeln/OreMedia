import { Fragment, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { COMPARISON_MINIMUM_SAMPLE, NOT_SUMMED } from '@oremedia/contracts/measurement';
import { Badge, Button, Chip, EmptyState, PageHeader, Skeleton, cn } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { Select } from '../../components/select';
import { AGES, DailyTrend } from './daily-trend';
import {
  PERIODS,
  channelFreshness,
  formatValue,
  groupValue,
  liftOf,
  median,
  signedPercent,
  type SlotPost,
} from './performance-helpers';
import {
  AnalystReview,
  CreativeAttributesPanel,
  PerformanceCard,
  PublicationDetail,
  SlotHeatmap,
} from './performance-panels';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { useBrands } from '../brand/use-brand';
import { PackageTitle } from '../content/package-title';
import { ageText } from '../intelligence/intelligence-helpers';
import { useWorkspace } from '../intelligence/use-intelligence';
import { dayKey, trailingDayKeys, trailingRange, wasReleased } from '../publishing/publication-state';
import { useCalendarRange, useChannels, type CalendarPublicationDto } from '../publishing/use-publishing';
import {
  useBrandPerformance,
  useMetricDefinitions,
  usePublicationValues,
  type BrandPerformanceDto,
  type MetricAggregateDto,
} from './use-measurement';
import { SeoAuditSection } from './seo-audit';
import { WebPerformanceSection } from './web-performance';

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
  ['rate:engagement/impressions', 'Engagement rate'],
];
const GROUP_LABEL = new Map(GROUPS);
const ENGAGEMENT_RATE = 'rate:engagement/impressions';
/** The interface's content table columns (Reach · ER · Saves · Clicks), with impressions the rate is pooled over. */
const CONTENT_COLUMNS: ReadonlyArray<[group: string, label: string]> = [
  ['impressions', 'Impressions'],
  ['reach', 'Reach'],
  [ENGAGEMENT_RATE, 'ER'],
  ['saves', 'Saves'],
  ['clicks', 'Clicks'],
];
/** The query's own bound (MetricsQuery: metricKeys ≤ 50); the publications are the period's whole population. */
const MAX_KEYS = 50;
const humanise = (key: string) => {
  const text = key.replace(/^other:/, '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

interface Row {
  publication: CalendarPublicationDto;
  /** The selected group's value (the sort and the vs. median column). */
  value: number | null;
  /** Each content column's value by comparable group. */
  columns: Map<string, number | null>;
  stale: boolean;
  fetchedHoursAgo: number | null;
}

/**
 * Performance, laid out as the supplied interface: the header (brand, period, the overview link), the channel chips
 * with the freshness line, the figure tiles, the trend, by channel and when it lands, what the creative did, the
 * content table and the analyst's review with the next content cycle; then the brand's web sources and audit (the
 * overview's drill-downs, D-28). Every figure is the latest fetch inside the period with its freshness; totals stay
 * inside one comparable group and span every published post of the period (the brand rollup aggregates the whole
 * population server side; the per-post values are read page by page); a change against the prior period compares
 * each post at the same age (D-14); what was asked and not returned is said, never shown as zero.
 */
export function PerformanceScreen() {
  const { companyId, companyName, brandId, brand } = useBrandContext();
  const navigate = useNavigate();
  const timeZone = brand.timezone || 'UTC';
  const [params, setParams] = useSearchParams();
  const days = PERIODS.find(([d]) => String(d) === params.get('period'))?.[0] ?? 30;
  const channelFilter = params.get('channel');
  const postParam = params.get('post');
  const ageDays = AGES.find(([a]) => String(a) === params.get('age'))?.[0] ?? 7;
  const todayKey = dayKey(new Date(), timeZone);
  const range = useMemo(() => trailingRange(days, todayKey, timeZone), [days, todayKey, timeZone]);
  // Web sources report by calendar day: the same last-N-days window as UTC day bounds (R2-1 part B).
  const webWindow = useMemo(() => {
    const { fromKey, toKey } = trailingDayKeys(days, todayKey);
    return { start: `${fromKey}T00:00:00.000Z`, end: `${toKey}T23:59:59.999Z` };
  }, [days, todayKey]);

  const calendar = useCalendarRange(brandId, range.from, range.to);
  const channels = useChannels(brandId);
  const definitions = useMetricDefinitions();
  const brands = useBrands();
  // The objective the screen is ranked against (spec 16.1), from the workspace the analyst's review reads too.
  const workspace = useWorkspace(brandId, false);
  const objectiveKey = workspace.data?.objective?.primaryMetricKey ?? null;
  const objectiveGroup = objectiveKey
    ? ((definitions.data ?? []).find((d) => d.key === objectiveKey)?.comparableGroup ?? objectiveKey)
    : null;
  const groups = useMemo(
    () =>
      objectiveGroup && objectiveKey && !GROUP_LABEL.has(objectiveGroup)
        ? [...GROUPS, [objectiveGroup, humanise(objectiveKey)] as [string, string]]
        : GROUPS,
    [objectiveGroup, objectiveKey],
  );
  const groupLabel = useMemo(() => new Map(groups), [groups]);

  const published = useMemo(
    () =>
      (calendar.data?.publications ?? [])
        .filter(
          (p) =>
            // A website article (R2-3) has no post metrics: it is measured through the brand's web sources.
            p.channelConnectionId !== null &&
            wasReleased(p.state) &&
            (!channelFilter || p.channelConnectionId === channelFilter),
        )
        .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor)),
    [calendar.data, channelFilter],
  );
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
              groupLabel.has(d.comparableGroup),
          )
          .map((d) => d.key),
      ),
    ],
    [definitions.data, brandProviders, groupLabel],
  );
  const metricKeys = allKeys.slice(0, MAX_KEYS);
  // The totals: the brand rollup over every published post of the period (and channel), aggregated server side.
  const summary = useBrandPerformance(brandId, range.from, range.to, undefined, channelFilter);
  // The tiles' change against the prior period: the same rollup with every post counted at one age (D-14).
  const atAge = useBrandPerformance(brandId, range.from, range.to, ageDays, channelFilter);
  // The per-post values, every page of them (spec 7.4); nothing is asked with no posts.
  const metrics = usePublicationValues(brandId, metricKeys, range.from, range.to, {
    channelConnectionId: channelFilter,
    enabled: published.length > 0,
  });
  // With no posts the rollup holds nothing for this period or channel; the panels wait for the last page of values.
  const current =
    published.length > 0 && (metricKeys.length === 0 || metrics.complete) ? summary.data?.current : undefined;

  const aggregates = useMemo(
    () =>
      groups.flatMap(([group, label]) => {
        const a = current?.aggregates.find((x) => x.comparableGroup === group);
        return a ? [{ ...a, label }] : [];
      }),
    [current, groups],
  );
  const selected =
    aggregates.find((a) => a.comparableGroup === params.get('metric')) ??
    aggregates.find((a) => a.value !== null) ??
    null;
  const columns = useMemo(
    () =>
      selected && !CONTENT_COLUMNS.some(([g]) => g === selected.comparableGroup)
        ? [[selected.comparableGroup, selected.label] as [string, string], ...CONTENT_COLUMNS]
        : CONTENT_COLUMNS,
    [selected],
  );

  const rows: Row[] = useMemo(() => {
    const values = metrics.items;
    return published.map((p) => {
      const mine = values.filter((v) => v.subjectId === p.publicationId);
      const of = (group: string) => groupValue(mine.filter((v) => v.comparableGroup === group));
      const g = of(selected?.comparableGroup ?? '');
      return {
        publication: p,
        value: g.value,
        columns: new Map(columns.map(([group]) => [group, of(group).value])),
        stale: g.stale,
        fetchedHoursAgo: g.age,
      };
    });
  }, [metrics.items, published, selected?.comparableGroup, columns]);
  const sorted = [...rows].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const measuredValues = rows.flatMap((r) => (r.value === null ? [] : [r.value]));
  // vs. median: each post against the period's median post, only with the minimum sample (D-14).
  const periodMedian = measuredValues.length >= COMPARISON_MINIMUM_SAMPLE ? median(measuredValues) : null;
  // UX-12: the slot grid pools engagement over impressions per post, whatever metric the tiles show.
  const slotPosts: SlotPost[] = useMemo(() => {
    const values = metrics.items;
    return published.map((p) => {
      const mine = values.filter((v) => v.subjectId === p.publicationId);
      return {
        scheduledFor: p.scheduledFor,
        engagement: groupValue(mine.filter((v) => v.comparableGroup === 'engagement')).value,
        impressions: groupValue(mine.filter((v) => v.comparableGroup === 'impressions')).value,
      };
    });
  }, [metrics.items, published]);
  const freshness = useMemo(() => channelFreshness(metrics.items, published), [metrics.items, published]);

  const channelName = (id: string) => {
    const c = channels.data?.find((x) => x.id === id);
    return c ? c.displayName : id;
  };
  const byChannel = useMemo(() => {
    const totals = new Map<string, { value: number; publications: number }>();
    if (selected && !selected.additive) return []; // D-15: no per-channel sum of a unique count, level or rate
    for (const r of rows) {
      if (r.value === null) continue;
      const key = r.publication.channelConnectionId ?? 'website';
      const t = totals.get(key) ?? { value: 0, publications: 0 };
      totals.set(key, {
        value: t.value + r.value,
        publications: t.publications + 1,
      });
    }
    return [...totals.entries()].sort((a, b) => b[1].value - a[1].value);
  }, [rows, selected]);
  const channelMax = Math.max(0, ...byChannel.map(([, t]) => t.value));

  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    // The selected post belongs to one period and channel: another selection drops it.
    if ('period' in next || 'channel' in next) p.delete('post');
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };
  const queries = [calendar, channels, definitions, summary];
  const failed = [...queries, metrics].find((q) => q.isError);
  const loading =
    queries.some((q) => q.isPending) ||
    (published.length > 0 && metricKeys.length > 0 && !metrics.complete && !metrics.isError);
  const coverage = current?.coverage;
  const objectiveAggregate = objectiveGroup
    ? aggregates.find((a) => a.comparableGroup === objectiveGroup)
    : undefined;

  return (
    <main
      id="main"
      className="om-in mx-auto flex w-full max-w-[1160px] flex-col gap-7 px-4 py-8 sm:px-9 sm:pt-9 sm:pb-[90px]"
    >
      <PageHeader
        title="Performance"
        description={[
          brand.name,
          companyName,
          objectiveKey ? `ranked against ${humanise(objectiveKey).toLowerCase()}` : 'no objective set',
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            {brands.data && brands.data.length > 0 && (
              <Select
                aria-label="Brand"
                size="sm"
                className="w-44 bg-card"
                value={brandId}
                onValueChange={(v) =>
                  void navigate(
                    v === 'all'
                      ? `/portfolio/performance?period=${days}`
                      : `${brandPath(companyId, v, 'performance')}?period=${days}`,
                  )
                }
                options={[
                  { value: 'all', label: 'All brands' },
                  ...brands.data.map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
            )}
            <div
              role="group"
              aria-label="Period"
              className="flex h-8 overflow-hidden rounded-lg border border-border bg-card"
            >
              {PERIODS.map(([d, label]) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={days === d}
                  onClick={() => update({ period: String(d) })}
                  className={cn(
                    'h-full px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    days === d ? 'bg-secondary font-medium' : 'hover:bg-card-tint',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button asChild>
              <Link to={`${brandPath(companyId, brandId, 'overview')}?period=${days}`}>
                Web, search and audit <span aria-hidden="true">→</span>
              </Link>
            </Button>
          </>
        }
      />

      <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        {(channels.data?.length ?? 0) > 1 && (
          <div role="group" aria-label="Channel" className="flex flex-wrap gap-1.5">
            <Chip selected={!channelFilter} onClick={() => update({ channel: null })}>
              All channels
            </Chip>
            {(channels.data ?? []).map((c) => (
              <Chip key={c.id} selected={channelFilter === c.id} onClick={() => update({ channel: c.id })}>
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                {c.displayName}
              </Chip>
            ))}
          </div>
        )}
        {freshness.length > 0 && (
          <p className="ml-auto text-xs text-muted-foreground" data-testid="freshness-line">
            Freshness:{' '}
            {freshness.map((f, i) => (
              <Fragment key={f.channelConnectionId}>
                {i > 0 && ' · '}
                <span className={cn(f.stale && 'text-status-warning')}>
                  {channelName(f.channelConnectionId)} {ageText(f.ageHours)}
                  {f.stale && ', stale'}
                </span>
              </Fragment>
            ))}
          </p>
        )}
      </div>

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
          <section aria-labelledby="totals-heading" className="flex flex-col gap-2">
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
                className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-px overflow-hidden rounded-xl border border-border bg-border"
              >
                {aggregates.map((a) => (
                  <MetricTile
                    key={a.comparableGroup}
                    aggregate={a}
                    label={a.label}
                    requested={current.publications}
                    comparison={atAge.data}
                    objective={a.comparableGroup === objectiveGroup}
                    pressed={selected?.comparableGroup === a.comparableGroup}
                    onSelect={() => update({ metric: a.comparableGroup })}
                  />
                ))}
                {objectiveKey && !objectiveAggregate && (
                  <div className="flex flex-col gap-1.5 bg-card px-4 pt-4 pb-3" data-testid="objective-tile">
                    <span className="flex justify-between gap-2 text-xs text-muted-foreground">
                      <span>{humanise(objectiveKey)}</span>
                      <ObjectiveTag />
                    </span>
                    <span className="text-xl font-bold tracking-title">Unavailable</span>
                    <span className="text-xs text-muted-foreground">
                      No post in the period returned this metric.
                    </span>
                  </div>
                )}
              </div>
            )}
            {coverage && (
              <p className="text-xs text-muted-foreground" data-testid="coverage">
                {coverage.subjectsWithData} of {coverage.subjectsRequested}{' '}
                {coverage.subjectsRequested === 1 ? 'publication has' : 'publications have'} numbers
                {coverage.staleValues > 0 &&
                  ` · ${coverage.staleValues} stale ${coverage.staleValues === 1 ? 'value' : 'values'}`}
                {' · '}totals add only flows of the same kind across channels; unique counts and levels are
                never summed and rates are pooled from their operands; a missing number is never counted as
                zero · changes compare every post at {ageDays} {ageDays === 1 ? 'day' : 'days'} old in both
                periods, with at least {COMPARISON_MINIMUM_SAMPLE} posts on each side
                {allKeys.length > MAX_KEYS && ` · the first ${MAX_KEYS} of ${allKeys.length} metrics`}
              </p>
            )}
          </section>

          {selected && (
            <DailyTrend
              brandId={brandId}
              timeZone={timeZone}
              days={days}
              range={range}
              todayKey={todayKey}
              channelFilter={channelFilter}
              group={selected}
              groupKeys={selected.metricKeys}
              ageDays={ageDays}
              onAgeChange={(age) => update({ age: String(age) })}
            />
          )}

          <div className="grid gap-5 md:grid-cols-2">
            {selected && (
              <PerformanceCard id="channels-heading" title="By channel" meta={selected.label}>
                {byChannel.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {selected.additive
                      ? `No channel returned ${selected.label.toLowerCase()}.`
                      : `${selected.label} is not summed per channel (${NOT_SUMMED[selected.kind] ?? 'not additive'}).`}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-3.5" data-testid="performance-channels">
                    {byChannel.map(([id, t]) => (
                      <li key={id} className="flex flex-col gap-1.5">
                        <span className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="flex min-w-0 items-center gap-1.5 break-words">
                            <span
                              aria-hidden="true"
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                            />
                            {channelName(id)}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {formatValue(selected.kind, t.value)} {selected.label.toLowerCase()} ·{' '}
                            {t.publications} {t.publications === 1 ? 'post' : 'posts'}
                          </span>
                        </span>
                        <Bar value={t.value} max={channelMax} />
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  Sums only a flow across a channel’s posts with numbers; a rate, a unique count or a level is
                  never added up.
                </p>
              </PerformanceCard>
            )}
            <SlotHeatmap posts={slotPosts} timeZone={timeZone} />
          </div>

          <CreativeAttributesPanel
            brandId={brandId}
            windowStart={range.from}
            windowEnd={range.to}
            enabled={published.length > 0}
          />

          {selected && (
            <section aria-labelledby="posts-heading" className="flex min-w-0 flex-col">
              <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-3">
                <h2 id="posts-heading" className="om-label">
                  Content
                </h2>
                <div role="group" aria-label="Sort by" className="flex flex-wrap gap-1">
                  {columns
                    .filter(([group]) => aggregates.some((a) => a.comparableGroup === group))
                    .map(([group, label]) => (
                      <Chip
                        key={group}
                        selected={selected.comparableGroup === group}
                        onClick={() => update({ metric: group })}
                      >
                        {groupLabel.get(group) ?? label}
                      </Chip>
                    ))}
                </div>
              </div>
              <table className="w-full table-fixed border-collapse text-sm" data-testid="performance-posts">
                <caption className="sr-only">
                  Published posts by {selected.label.toLowerCase()}, with each post against the period’s
                  median post
                </caption>
                <thead>
                  <tr className="border-t border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-normal">
                      Post
                    </th>
                    <th scope="col" className="hidden w-32 py-2 pr-3 font-normal sm:table-cell">
                      Channel
                    </th>
                    {columns.map(([group, label]) => (
                      <th
                        key={group}
                        scope="col"
                        className={cn(
                          'w-20 py-2 pr-3 text-right font-normal',
                          group !== selected.comparableGroup && 'hidden md:table-cell',
                          group === selected.comparableGroup && 'text-foreground',
                        )}
                      >
                        {label}
                      </th>
                    ))}
                    <th scope="col" className="w-20 py-2 text-right font-normal">
                      vs. median
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const id = r.publication.publicationId;
                    const open = postParam === id;
                    const lift = liftOf(r.value, periodMedian);
                    const toggle = () => update({ post: open ? null : id });
                    const channel = channelName(r.publication.channelConnectionId ?? 'website');
                    return (
                      <Fragment key={id}>
                        <tr
                          className={cn(
                            'cursor-pointer border-t border-border hover:bg-muted',
                            open && 'bg-card-tint',
                          )}
                          data-publication={id}
                          onClick={toggle}
                        >
                          <td className="py-2.5 pr-3">
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-controls={open ? `post-${id}` : undefined}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle();
                              }}
                              className="flex w-full min-w-0 flex-col gap-0.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span className="truncate">
                                <PackageTitle contentPackageId={r.publication.contentPackageId} />
                              </span>
                              <span className="truncate text-2xs text-muted-foreground tabular-nums">
                                <span className="sm:hidden">{channel} · </span>
                                {new Date(r.publication.scheduledFor).toLocaleDateString(undefined, {
                                  timeZone,
                                  day: 'numeric',
                                  month: 'short',
                                })}
                                {r.fetchedHoursAgo !== null && ` · fetched ${ageText(r.fetchedHoursAgo)}`}
                                {r.stale && ' · stale'}
                              </span>
                            </button>
                          </td>
                          <td className="hidden py-2.5 pr-3 text-xs text-muted-foreground sm:table-cell">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span
                                aria-hidden="true"
                                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                              />
                              <span className="truncate">{channel}</span>
                            </span>
                          </td>
                          {columns.map(([group]) => {
                            const v = r.columns.get(group) ?? null;
                            const kind = aggregates.find((a) => a.comparableGroup === group)?.kind ?? 'flow';
                            return (
                              <td
                                key={group}
                                className={cn(
                                  'py-2.5 pr-3 text-right text-xs tabular-nums',
                                  group !== selected.comparableGroup && 'hidden md:table-cell',
                                )}
                              >
                                {v === null ? <Missing /> : formatValue(kind, v)}
                              </td>
                            );
                          })}
                          <td
                            className={cn(
                              'py-2.5 text-right text-xs tabular-nums',
                              lift !== null && (lift >= 0 ? 'text-status-good' : 'text-status-critical'),
                            )}
                          >
                            {lift === null ? <Missing label="not compared" /> : signedPercent(lift)}
                          </td>
                        </tr>
                        {open && (
                          <tr id={`post-${id}`}>
                            <td colSpan={columns.length + 3} className="pb-3.5">
                              <PublicationDetail
                                companyId={companyId}
                                brandId={brandId}
                                publication={r.publication}
                                timeZone={timeZone}
                                windowStart={range.from}
                                windowEnd={range.to}
                                channelName={channel}
                                onClose={() => update({ post: null })}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">
                {periodMedian === null
                  ? `vs. median needs ${COMPARISON_MINIMUM_SAMPLE} posts with ${selected.label.toLowerCase()}; ${measuredValues.length} have it, so no post is compared.`
                  : `vs. median: each post’s ${selected.label.toLowerCase()} against the period’s median post (${formatValue(selected.kind, periodMedian)}).`}{' '}
                A dash is a number the channel did not return, never a zero.
              </p>
            </section>
          )}
        </>
      )}

      <AnalystReview companyId={companyId} brandId={brandId} days={days} />

      <WebPerformanceSection
        companyId={companyId}
        brandId={brandId}
        windowStart={webWindow.start}
        windowEnd={webWindow.end}
        days={days}
      />
      <SeoAuditSection companyId={companyId} brandId={brandId} />
    </main>
  );
}

/** A number the channel did not return: a dash for the eye, the word for a screen reader (never a zero). */
function Missing({ label = 'Unavailable' }: { label?: string }) {
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">
        —
      </span>
      <span className="sr-only">{label}</span>
    </>
  );
}

function ObjectiveTag() {
  return (
    <span className="h-fit shrink-0 rounded-sm bg-secondary px-1 text-2xs font-medium text-foreground">
      OBJECTIVE
    </span>
  );
}

function MetricTile({
  aggregate,
  label,
  requested,
  comparison,
  objective,
  pressed,
  onSelect,
}: {
  aggregate: MetricAggregateDto;
  label: string;
  requested: number;
  /** The rollup at one post age (D-14), for the change against the prior period; undefined while it loads. */
  comparison: BrandPerformanceDto | undefined;
  objective: boolean;
  pressed: boolean;
  onSelect: () => void;
}) {
  const c = comparison?.comparison.find((x) => x.comparableGroup === aggregate.comparableGroup);
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 bg-card px-4 pt-4 pb-3 text-left transition-colors',
        'hover:bg-card-tint focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        pressed && 'bg-card-tint shadow-[inset_0_-2px_0_var(--color-foreground)]',
      )}
    >
      <span className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        {objective && <ObjectiveTag />}
      </span>
      <span className="text-xl font-bold tracking-title">
        {aggregate.value !== null
          ? formatValue(aggregate.kind, aggregate.value)
          : aggregate.additive || aggregate.subjectsWithData === 0
            ? 'Unavailable'
            : 'Not summed'}
      </span>
      {comparison && (
        <span className="text-xs text-muted-foreground" data-testid="tile-change">
          {c && c.change !== null ? (
            <>
              <span className={c.change >= 0 ? 'text-status-good' : 'text-status-critical'}>
                {signedPercent(c.change)}
              </span>{' '}
              vs. prior period
            </>
          ) : !c ? (
            'not compared (not a flow or rate)'
          ) : !comparison.sample.sufficient ? (
            `not compared: under ${comparison.sample.minimum} posts`
          ) : (
            'no prior value'
          )}
        </span>
      )}
      <span className="text-2xs text-muted-foreground">
        {aggregate.subjectsWithData} of {requested} {requested === 1 ? 'post' : 'posts'}
        {aggregate.freshness && ` · oldest ${ageText(aggregate.freshness.ageHours)}`}
        {!aggregate.additive && aggregate.subjectsWithData > 0 && ` · ${NOT_SUMMED[aggregate.kind] ?? ''}`}
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
    <span aria-hidden="true" className="block h-2 w-full overflow-hidden rounded-sm bg-muted">
      <span className="block h-full rounded-sm bg-accent" style={{ width: `${width}%` }} />
    </span>
  );
}
