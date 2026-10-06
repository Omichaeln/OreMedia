import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, PageHeader, Skeleton, cn } from '@oremedia/ui';
import { TopBar } from '../root';
import { RequestError } from '../../components/request-state';
import { PERIODS } from '../../features/measurement/performance-helpers';
import { CompanyPerformance } from '../../features/measurement/portfolio-performance';
import { useCompanies } from '../../features/portfolio/use-companies';
import { dayKey, trailingRange } from '../../features/publishing/publication-state';

/** D-14: every brand is compared at the same post age; the trend's default on the brand screen. */
const AGE_DAYS = 7;

/**
 * UX-11: every brand of every company the person belongs to, over one period, beside the previous period of equal
 * length, each post counted at the same age (D-14). Each company is asked with its own tenant; nothing is summed
 * across companies or across brands (D-15). The period is counted on the UTC calendar here, since the brands keep
 * different clocks.
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
      <main
        id="main"
        className="om-in mx-auto flex w-full max-w-[1160px] flex-col gap-7 px-4 py-8 sm:px-9 sm:pt-9 sm:pb-[90px]"
      >
        <PageHeader
          title="Performance"
          description={`All brands · the last ${days} days against the ${days} before · UTC calendar`}
          actions={
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
                  onClick={() => {
                    const p = new URLSearchParams(params);
                    p.set('period', String(d));
                    setParams(p, { replace: true });
                  }}
                  className={cn(
                    'h-full px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    days === d ? 'bg-secondary font-medium' : 'hover:bg-card-tint',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
        <p className="-mt-4 text-xs text-muted-foreground">
          Each post counted at {AGE_DAYS} days old, so posts published on different days compare. Nothing is
          added across brands or companies; a comparison needs the minimum sample on both sides.
        </p>
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
              ageDays={AGE_DAYS}
            />
          ))}
      </main>
    </>
  );
}
