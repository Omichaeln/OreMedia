import { Link } from 'react-router';
import type { MetricAgeDays } from '@oremedia/contracts/measurement';
import { Badge, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { useBrandsOf } from '../brand/use-brand';
import { formatValue } from './performance-helpers';
import { useBrandPerformanceOf, type BrandPerformanceDto } from './use-measurement';

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
const formatChange = (c: number) => `${c >= 0 ? '+' : ''}${(c * 100).toFixed(1)}%`;

/**
 * UX-11: one company's brands, each asked with this company's tenant (brand.list, then metrics.brandSummary per
 * brand at one post age, D-14). Nothing is summed across brands.
 */
export function CompanyPerformance({
  tenantId,
  name,
  windowStart,
  windowEnd,
  ageDays,
}: {
  tenantId: string;
  name: string;
  windowStart: string;
  windowEnd: string;
  ageDays: MetricAgeDays;
}) {
  const brands = useBrandsOf(tenantId);
  const headingId = `performance-${tenantId}`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col" data-testid="company-performance">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 id={headingId} className="om-label">
          {name}
        </h2>
        <Link to={`/c/${encodeURIComponent(tenantId)}`} className="text-xs font-medium hover:opacity-60">
          Open company <span aria-hidden="true">→</span>
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
              <tr className="border-t border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-normal">
                  Brand
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">
                  Posts
                </th>
                {COLUMNS.map(([group, label]) => (
                  <th key={group} scope="col" className="py-2 pr-3 text-right font-normal">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {brands.data.map((b) => (
                <BrandRow
                  key={b.id}
                  tenantId={tenantId}
                  brandId={b.id}
                  name={b.name}
                  company={name}
                  windowStart={windowStart}
                  windowEnd={windowEnd}
                  ageDays={ageDays}
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
  company,
  windowStart,
  windowEnd,
  ageDays,
}: {
  tenantId: string;
  brandId: string;
  name: string;
  company: string;
  windowStart: string;
  windowEnd: string;
  ageDays: MetricAgeDays;
}) {
  const performance = useBrandPerformanceOf(tenantId, brandId, windowStart, windowEnd, ageDays);
  const href = `/c/${encodeURIComponent(tenantId)}/b/${encodeURIComponent(brandId)}/performance`;
  const data = performance.data;
  return (
    <tr
      className="border-t border-border align-top hover:bg-muted"
      data-testid="brand-performance"
      data-brand={brandId}
    >
      <th scope="row" className="py-3 pr-3 text-left font-medium">
        <Link to={href} className="underline-offset-2 hover:underline">
          {name}
        </Link>
        <span className="block text-xs font-normal text-muted-foreground">{company}</span>
        {data && !data.sample.sufficient && (
          <span className="mt-1 block">
            <Badge tone="neutral">Insufficient sample</Badge>
          </span>
        )}
        {data && <ListedOnly data={data} />}
      </th>
      {performance.isPending && (
        <td colSpan={COLUMNS.length + 1} className="py-3 text-xs text-muted-foreground">
          Loading…
        </td>
      )}
      {performance.isError && (
        <td colSpan={COLUMNS.length + 1} className="py-3 text-xs text-muted-foreground">
          Unavailable right now.
        </td>
      )}
      {data && (
        <>
          <td className="py-3 pr-3 text-right text-xs tabular-nums">
            {data.sample.current}
            <span className="block text-2xs text-muted-foreground">prev {data.sample.previous}</span>
          </td>
          {COLUMNS.map(([group]) => {
            const c = data.comparison.find((x) => x.comparableGroup === group);
            const a = data.current.aggregates.find((x) => x.comparableGroup === group);
            return (
              <td key={group} className="py-3 pr-3 text-right text-xs tabular-nums" data-group={group}>
                {c && c.current !== null ? (
                  formatValue(c.kind, c.current)
                ) : (
                  <Badge tone="neutral">Unavailable</Badge>
                )}
                <span className="block text-2xs text-muted-foreground">
                  {a ? `${a.subjectsWithData}/${data.sample.current} posts` : 'not returned'}
                  {' · '}
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
