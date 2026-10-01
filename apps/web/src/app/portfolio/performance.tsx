import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Badge, Button, EmptyState, Skeleton } from '@oremedia/ui';
import { TopBar } from '../root';
import { RequestError } from '../../components/request-state';
import { useBrandsOf } from '../../features/brand/use-brand';
import { useBrandPerformanceOf, type BrandPerformanceDto } from '../../features/measurement/use-measurement';
import { useCompanies } from '../../features/portfolio/use-companies';
import { dayKey, trailingRange } from '../../features/publishing/publication-state';

const PERIODS = [
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
] as const;

/** The columns every brand row carries (D-15: flows and a pooled rate; nothing else is summed across posts). */
const COLUMNS: ReadonlyArray<[group: string, label: string]> = [
  ['impressions', 'Impressions'],
  ['engagement', 'Engagement'],
  ['clicks', 'Clicks'],
  ['rate:engagement/impressions', 'Engagement rate'],
];
/** Listed under the row, never summed and never compared (D-15 unique counts, levels, gauges). */
const LISTED_ONLY: ReadonlyArray<[group: string, label: string]> = [
  ['reach', 'Reach'],
  ['followers', 'Followers'],
];

const number = (v: number) => new Intl.NumberFormat().format(v);
const formatValue = (kind: string, v: number) => (kind === 'rate' ? `${(v * 100).toFixed(1)}%` : number(v));
const formatChange = (c: number) => `${c >= 0 ? '+' : ''}${(c * 100).toFixed(1)}%`;

/**
 * UX-11: every brand of every company the person belongs to, over one period, beside the previous period of equal
 * length. Each company is asked with its own tenant; nothing is summed across companies or across brands, because a
 * brand's flows are its own channels' and the dictionary forbids adding what is not comparable (D-15). The period is
 * counted on the UTC calendar here, since the brands keep different clocks.
 */
export function PortfolioPerformanceRoute() {
  const companies = useCompanies();
  const [params, setParams] = useSearchParams();
  const days = PERIODS.find(([d]) => String(d) === params.get('period'))?.[0] ?? 30;
  const todayKey = dayKey(new Date(), 'UTC');
  const range = useMemo(() => trailingRange(days, todayKey, 'UTC'), [days, todayKey]);
  return (
    <>
      <TopBar title="Performance" />
      <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Performance across the portfolio</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every brand you can see, over the last {days} days against the {days} before, on the UTC
              calendar. Nothing is added across brands or companies; a comparison needs the minimum sample on
              both sides.
            </p>
          </div>
          <div role="group" aria-label="Period" className="flex gap-1">
            {PERIODS.map(([d, label]) => (
              <Button
                key={d}
                size="sm"
                variant={days === d ? 'secondary' : 'ghost'}
                aria-pressed={days === d}
                onClick={() => {
                  const p = new URLSearchParams(params);
                  p.set('period', String(d));
                  setParams(p, { replace: true });
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </header>
        {companies.isPending && <Skeleton label="Loading companies" lines={4} />}
        {companies.isError && (
          <RequestError
            error={companies.error}
            onRetry={() => void companies.refetch()}
            title="Restricted access"
          />
        )}
        {companies.isSuccess && companies.data.length === 0 && (
          <EmptyState
            title="You are not a member of any company yet"
            description="Performance appears here once a company owner invites you and a brand there publishes."
          />
        )}
        {companies.isSuccess &&
          companies.data.map((c) => (
            <CompanyPerformance
              key={c.tenantId}
              tenantId={c.tenantId}
              name={c.name}
              windowStart={range.from}
              windowEnd={range.to}
            />
          ))}
      </main>
    </>
  );
}

/** One company's brands, each asked with this company's tenant (brand.list, then metrics.brandSummary per brand). */
function CompanyPerformance({
  tenantId,
  name,
  windowStart,
  windowEnd,
}: {
  tenantId: string;
  name: string;
  windowStart: string;
  windowEnd: string;
}) {
  const brands = useBrandsOf(tenantId);
  const headingId = `performance-${tenantId}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-testid="company-performance">
      <div className="flex items-baseline justify-between gap-2 border-b border-border pb-2">
        <h2 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {name}
        </h2>
        <Link
          to={`/c/${encodeURIComponent(tenantId)}`}
          className="text-sm font-medium underline-offset-2 hover:underline"
        >
          Open company
        </Link>
      </div>
      {brands.isPending && <Skeleton label={`Loading brands of ${name}`} lines={2} />}
      {brands.isError && (
        <RequestError
          error={brands.error}
          title="Brands could not load"
          onRetry={() => void brands.refetch()}
        />
      )}
      {brands.data && brands.data.length === 0 && (
        <p className="text-sm text-muted-foreground">No brand you can see here.</p>
      )}
      {brands.data && brands.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Brand
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Posts
                </th>
                {COLUMNS.map(([group, label]) => (
                  <th key={group} scope="col" className="py-2 pr-3 text-right font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {brands.data.map((b) => (
                <BrandRow
                  key={b.id}
                  tenantId={tenantId}
                  brandId={b.id}
                  name={b.name}
                  windowStart={windowStart}
                  windowEnd={windowEnd}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BrandRow({
  tenantId,
  brandId,
  name,
  windowStart,
  windowEnd,
}: {
  tenantId: string;
  brandId: string;
  name: string;
  windowStart: string;
  windowEnd: string;
}) {
  const performance = useBrandPerformanceOf(tenantId, brandId, windowStart, windowEnd);
  const href = `/c/${encodeURIComponent(tenantId)}/b/${encodeURIComponent(brandId)}/performance`;
  const data = performance.data;
  return (
    <tr className="align-top" data-testid="brand-performance" data-brand={brandId}>
      <th scope="row" className="py-2 pr-3 text-left font-medium">
        <Link to={href} className="underline-offset-2 hover:underline">
          {name}
        </Link>
        {data && !data.sample.sufficient && (
          <span className="mt-1 block">
            <Badge tone="neutral">Insufficient sample</Badge>
          </span>
        )}
        {data && <ListedOnly data={data} />}
      </th>
      {performance.isPending && (
        <td colSpan={COLUMNS.length + 1} className="py-2 text-muted-foreground">
          Loading…
        </td>
      )}
      {performance.isError && (
        <td colSpan={COLUMNS.length + 1} className="py-2 text-muted-foreground">
          Unavailable right now.
        </td>
      )}
      {data && (
        <>
          <td className="py-2 pr-3 text-right tabular-nums">
            {data.sample.current}
            <span className="block text-xs text-muted-foreground">prev {data.sample.previous}</span>
          </td>
          {COLUMNS.map(([group]) => {
            const c = data.comparison.find((x) => x.comparableGroup === group);
            return (
              <td key={group} className="py-2 pr-3 text-right tabular-nums" data-group={group}>
                {c && c.current !== null ? (
                  formatValue(c.kind, c.current)
                ) : (
                  <Badge tone="neutral">Unavailable</Badge>
                )}
                <span className="block text-xs text-muted-foreground">
                  {c && c.change !== null
                    ? formatChange(c.change)
                    : c && c.previous !== null
                      ? `prev ${formatValue(c.kind, c.previous)}`
                      : data.sample.sufficient
                        ? 'no previous'
                        : 'not compared'}
                </span>
              </td>
            );
          })}
        </>
      )}
    </tr>
  );
}

/** Unique counts and levels the brand's channels returned: shown, never summed and never compared (D-15). */
function ListedOnly({ data }: { data: BrandPerformanceDto }) {
  const listed = LISTED_ONLY.flatMap(([group, label]) => {
    const a = data.current.aggregates.find((x) => x.comparableGroup === group);
    return a && a.subjectsWithData > 0 ? [`${label}: not summed (${a.subjectsWithData} posts)`] : [];
  });
  if (listed.length === 0) return null;
  return <span className="mt-1 block text-xs font-normal text-muted-foreground">{listed.join(' · ')}</span>;
}
