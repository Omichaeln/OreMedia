import { useState } from 'react';
import { Link } from 'react-router';
import { Badge, EmptyState, Skeleton, cn } from '@oremedia/ui';
import {
  DESTINATION_KIND_CAPABILITIES,
  webMetricSpec,
  type DestinationKind,
  type DestinationReportOpportunityKind,
} from '@oremedia/contracts/destinations';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { brandPath } from '../brand/brand-context';
import { useDestinations, type DestinationDto } from '../destinations/use-destinations';
import { ageText } from '../intelligence/intelligence-helpers';
import { formatNumber, percent } from './performance-helpers';
import {
  useWebOpportunities,
  useWebReportRows,
  useWebReportSummary,
  type WebReportEntryDto,
  type WebReportRowDto,
} from './use-web-performance';

/**
 * The Performance screen's "Web" section (R2-1 part B): each connected GA4 property and Search Console site with
 * its coverage and freshness, summary tiles by the dictionary's kinds beside the previous period (D-14, D-15), a
 * tabbed drill-down over the stored reports and the computed opportunity queue. A destination whose source-use
 * policy does not allow reads says so and points at Settings → Destinations. AI search (D-19): no official API is
 * verified, so the row is a labelled link to the vendor's console, never a figure.
 */
const WEB_KINDS: ReadonlySet<string> = new Set(['ga4_property', 'search_console_site']);

/** Per kind: the report the tiles read, the tiles' metrics in order, and the drill-down tabs. */
const SCREEN: Readonly<
  Record<
    'ga4_property' | 'search_console_site',
    { tiles: { report: string; metrics: string[] }; tabs: ReadonlyArray<[reportKey: string, label: string]> }
  >
> = {
  ga4_property: {
    tiles: {
      report: 'ga4.engagement',
      metrics: ['sessions', 'engagedSessions', 'keyEvents', 'engagementRate'],
    },
    tabs: [
      ['ga4.acquisition', 'Acquisition channels'],
      ['ga4.landing_pages', 'Landing pages'],
    ],
  },
  search_console_site: {
    tiles: { report: 'gsc.countries_devices', metrics: ['clicks', 'impressions', 'ctr', 'position'] },
    tabs: [
      ['gsc.queries', 'Queries'],
      ['gsc.pages', 'Pages'],
      ['gsc.countries_devices', 'Countries and devices'],
    ],
  },
};
const DIMENSION_LABEL: Record<string, string> = {
  sessionDefaultChannelGroup: 'Channel',
  landingPage: 'Landing page',
  query: 'Query',
  page: 'Page',
  country: 'Country',
  device: 'Device',
};
const OPPORTUNITY_LABEL: Record<DestinationReportOpportunityKind, string> = {
  low_ctr_query: 'Low CTR query',
  low_ctr_page: 'Low CTR page',
  low_engagement_page: 'Low engagement page',
};
/** D-19: the vendor's own console, labelled as such; no AI-search figure is shown or computed here. */
const VENDOR_CONSOLE: Record<'ga4_property' | 'search_console_site', { label: string; href: string }> = {
  ga4_property: { label: 'Google Analytics', href: 'https://analytics.google.com/' },
  search_console_site: { label: 'Search Console', href: 'https://search.google.com/search-console' },
};

/** A value in its metric's own unit (D-15): a rate as a percentage, a gauge to one decimal, a flow as a count. */
export function formatWebValue(metric: string, value: number | null): string {
  if (value === null) return 'Unavailable';
  const kind = webMetricSpec(metric)?.kind ?? 'flow';
  if (kind === 'rate') return percent(value);
  if (kind === 'gauge') return value.toFixed(1);
  return formatNumber(Math.round(value));
}
const metricLabel = (metric: string) => webMetricSpec(metric)?.label ?? metric;
const settingsHref = (companyId: string, brandId: string) =>
  `${brandPath(companyId, brandId, 'settings')}?tab=destinations`;

export function WebPerformanceSection({
  companyId,
  brandId,
  windowStart,
  windowEnd,
  days,
}: {
  companyId: string;
  brandId: string;
  /** UTC day bounds (`YYYY-MM-DDT00:00:00.000Z` … `YYYY-MM-DDT23:59:59.999Z`): the platforms report by calendar day. */
  windowStart: string;
  windowEnd: string;
  days: number;
}) {
  const destinations = useDestinations(brandId);
  const connected = (destinations.data?.items ?? []).filter(
    (d) => d.status === 'active' && WEB_KINDS.has(d.kind),
  );
  return (
    <Section id="web-heading" title="Web" testId="web-performance">
      {destinations.isError && (
        <RequestError
          error={destinations.error}
          title="Web sources could not load"
          onRetry={() => void destinations.refetch()}
        />
      )}
      {destinations.isPending && <Skeleton label="Loading web sources" lines={2} />}
      {destinations.isSuccess && connected.length === 0 && (
        <EmptyState
          title="No web source connected"
          description="Connect a Google Analytics 4 property or a Search Console site to see what the website did."
          action={
            <Link to={settingsHref(companyId, brandId)} className="text-sm underline underline-offset-2">
              Settings → Destinations
            </Link>
          }
        />
      )}
      {connected.map((d) => (
        <WebDestinationCard
          key={d.id}
          companyId={companyId}
          brandId={brandId}
          destination={d}
          windowStart={windowStart}
          windowEnd={windowEnd}
          days={days}
        />
      ))}
    </Section>
  );
}

function WebDestinationCard({
  companyId,
  brandId,
  destination,
  windowStart,
  windowEnd,
  days,
}: {
  companyId: string;
  brandId: string;
  destination: DestinationDto;
  windowStart: string;
  windowEnd: string;
  days: number;
}) {
  const kind = destination.kind as 'ga4_property' | 'search_console_site';
  const screen = SCREEN[kind];
  const [tab, setTab] = useState<string>(screen.tabs[0]?.[0] ?? '');
  const summary = useWebReportSummary(brandId, destination.id, windowStart, windowEnd);
  const allowed = summary.data?.policy.allowed === true;
  const rows = useWebReportRows(brandId, destination.id, tab, windowStart, windowEnd, allowed && tab !== '');
  const opportunities = useWebOpportunities(brandId, destination.id, allowed);
  const tiles = summary.data?.reports.find((r) => r.reportKey === screen.tiles.report) ?? null;
  const latest = (summary.data?.reports ?? [])
    .map((r) => r.freshness.latestDate)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  const stale = (summary.data?.reports ?? []).some(
    (r) => r.freshness.latestDate !== null && r.freshness.stale,
  );
  const console = VENDOR_CONSOLE[kind];

  return (
    <article
      className="flex flex-col gap-4 py-3"
      data-testid={`web-destination-${destination.id}`}
      data-destination-kind={destination.kind}
      aria-labelledby={`web-${destination.id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={`web-${destination.id}`} className="text-sm font-semibold">
          {destination.displayName}
          <span className="ml-2 font-normal text-muted-foreground">
            {DESTINATION_KIND_CAPABILITIES[destination.kind as DestinationKind]?.label ?? destination.kind}
          </span>
        </h3>
        {summary.data?.policy.allowed && (
          <p className="text-xs text-muted-foreground" data-testid="web-coverage">
            {latest ? `data to ${latest}` : 'no data read yet'}
            {' · '}
            {latest ? stale ? <Badge tone="warning">Stale</Badge> : <Badge tone="good">Fresh</Badge> : null}
            {latest && ` · last ${days} days against the ${days} before`}
          </p>
        )}
      </div>

      {summary.isError && (
        <RequestError
          error={summary.error}
          title="This source could not load"
          onRetry={() => void summary.refetch()}
        />
      )}
      {summary.isPending && <Skeleton label={`Loading ${destination.displayName}`} lines={3} />}

      {summary.data && !summary.data.policy.allowed && (
        <p className="text-sm text-muted-foreground" data-testid="web-policy-blocked">
          Reads not allowed by the source-use policy ({summary.data.policy.reason.replace(/_/g, ' ')} for{' '}
          {summary.data.policy.dataType}).{' '}
          <Link to={settingsHref(companyId, brandId)} className="underline underline-offset-2">
            Settings → Destinations
          </Link>
        </p>
      )}

      {summary.data?.policy.allowed && tiles && (
        <div
          role="group"
          aria-label={`${destination.displayName} totals`}
          className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3"
        >
          {screen.tiles.metrics.map((metric) => (
            <WebTile key={metric} metric={metric} entry={tiles} />
          ))}
        </div>
      )}

      {summary.data?.policy.allowed && (
        <div className="flex flex-col gap-2">
          <div
            role="tablist"
            aria-label={`${destination.displayName} reports`}
            className="flex flex-wrap gap-1"
          >
            {screen.tabs.map(([reportKey, label]) => {
              const active = reportKey === tab;
              return (
                <button
                  key={reportKey}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setTab(reportKey)}
                  className={cn(
                    'rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'border-accent bg-secondary font-medium'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" data-testid="web-drilldown">
            {rows.isError && (
              <RequestError
                error={rows.error}
                title="Rows could not load"
                onRetry={() => void rows.refetch()}
              />
            )}
            {rows.isPending && rows.fetchStatus !== 'idle' && <Skeleton label="Loading rows" lines={3} />}
            {rows.data && (
              <WebRows
                entry={summary.data.reports.find((r) => r.reportKey === tab) ?? null}
                rows={rows.data.items}
              />
            )}
          </div>
        </div>
      )}

      {summary.data?.policy.allowed && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Opportunities
          </h4>
          {opportunities.isError && (
            <RequestError
              error={opportunities.error}
              title="Opportunities could not load"
              onRetry={() => void opportunities.refetch()}
            />
          )}
          {opportunities.data && opportunities.data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing below half the {kind === 'ga4_property' ? "property's engagement rate" : "site's CTR"}{' '}
              in the last 28 days with enough traffic to mean something.
            </p>
          )}
          {opportunities.data && opportunities.data.items.length > 0 && (
            <ul className="flex flex-col divide-y divide-border" data-testid="web-opportunities">
              {opportunities.data.items.map((o) => (
                <li key={`${o.kind}:${o.subject}`} className="flex flex-col gap-0.5 py-2 text-sm">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <Badge tone="info" glyph={false}>
                      {OPPORTUNITY_LABEL[o.kind]}
                    </Badge>
                    <span className="min-w-0 break-words font-medium">{o.subject}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{o.suggestedTask}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground" data-testid="web-ai-search">
        AI search: no official API is verified for this report, so no figure is shown here (D-19).{' '}
        <a
          href={console.href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          Open {console.label} (external)
        </a>
      </p>
    </article>
  );
}

function WebTile({ metric, entry }: { metric: string; entry: WebReportEntryDto }) {
  const value = entry.current.metrics[metric] ?? null;
  const comparison = entry.comparison.find((c) => c.metric === metric) ?? null;
  const kind = webMetricSpec(metric)?.kind ?? 'flow';
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background p-4"
      data-testid={`web-tile-${metric}`}
    >
      <span className="text-xs text-muted-foreground">{metricLabel(metric)}</span>
      <span className="text-2xl font-semibold tabular-nums">{formatWebValue(metric, value)}</span>
      <span className="text-xs text-muted-foreground">
        {kind === 'gauge'
          ? 'weighted mean, not compared'
          : !entry.sample.sufficient
            ? `insufficient sample (${entry.sample.current} and ${entry.sample.previous} days of ${entry.sample.minimum})`
            : comparison && comparison.change !== null
              ? `${comparison.change >= 0 ? '+' : ''}${(comparison.change * 100).toFixed(1)}% vs previous ${formatWebValue(metric, comparison.previous)}`
              : 'no previous value'}
        {' · '}
        {entry.current.days} {entry.current.days === 1 ? 'day' : 'days'} with data
        {entry.freshness.ageHours !== null && ` · ${ageText(entry.freshness.ageHours)}`}
      </span>
    </div>
  );
}

function WebRows({ entry, rows }: { entry: WebReportEntryDto | null; rows: WebReportRowDto[] }) {
  const dimensions = entry?.dimensions ?? Object.keys(rows[0]?.dimensions ?? {});
  const metrics = [...(entry?.metrics ?? Object.keys(rows[0]?.metrics ?? {}))];
  if (entry?.metrics.includes('engagedSessions') && entry.metrics.includes('sessions'))
    metrics.push('engagementRate');
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No rows in this period: nothing was read for these days.
      </p>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            {dimensions.map((d) => (
              <th key={d} scope="col" className="py-1 pr-3 font-medium">
                {DIMENSION_LABEL[d] ?? d}
              </th>
            ))}
            {metrics.map((m) => (
              <th key={m} scope="col" className="py-1 pr-3 text-right font-medium">
                {metricLabel(m)}
              </th>
            ))}
            <th scope="col" className="py-1 text-right font-medium">
              Days
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.dimensionKey} data-dimension={Object.values(r.dimensions).join(' / ')}>
              {dimensions.map((d) => (
                <td key={d} className="max-w-xs truncate py-1.5 pr-3" title={r.dimensions[d] ?? ''}>
                  {r.dimensions[d] || '(not set)'}
                </td>
              ))}
              {metrics.map((m) => (
                <td key={m} className="py-1.5 pr-3 text-right tabular-nums">
                  {formatWebValue(m, r.metrics[m] ?? null)}
                </td>
              ))}
              <td className="py-1.5 text-right tabular-nums">{r.days}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
