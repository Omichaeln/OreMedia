import { Link } from 'react-router';
import { EmptyState, KpiStrip, PageHeader, Skeleton } from '@oremedia/ui';
import { TopBar } from '../root';
import { RequestError } from '../../components/request-state';
import { useBrandSummary, useBrandsOf } from '../../features/brand/use-brand';
import { brandPath } from '../../features/brand/brand-context';
import { useCompanies, type CompanyDto } from '../../features/portfolio/use-companies';
import { roleLabel } from '../../features/session/account-menu';

const ZERO = { overdueApprovals: 0, publicationsNeedingPerson: 0, upcomingPublications: 0 };
type BrandSummaryDto = NonNullable<ReturnType<typeof useBrandSummary>['data']>;

/**
 * Spec 21.2 portfolio states: no memberships; restricted access. The supplied interface's layout: three figures
 * across every company the person can see, then each company as its own section (a separate tenant; nothing is
 * shared between them) with the person's role there and a row per brand that opens that brand. Every figure is a
 * count the server returned; a company whose counts could not load says so instead of showing zero.
 */
export function PortfolioRoute() {
  const companies = useCompanies();
  return (
    <>
      <TopBar title="Portfolio" />
      <main id="main" className="om-fade mx-auto flex w-full max-w-[960px] flex-col gap-9 px-4 py-8 sm:px-8 sm:py-12">
        <PageHeader
          title="Portfolio"
          description="Companies and brands you have access to. Each company is a separate tenant; nothing is shared between them."
        />
        <Link
          to="/portfolio/performance"
          className="-mt-6 self-start text-sm font-medium hover:opacity-60"
        >
          Performance across all brands <span aria-hidden="true">→</span>
        </Link>
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
            description="Ask a company owner to invite you. Invitations are managed in each company's settings; nothing appears here until a membership is active."
          />
        )}
        {companies.isSuccess && companies.data.length > 0 && <Companies companies={companies.data} />}
      </main>
    </>
  );
}

/** The totals strip and the company sections share one summary read per company, asked with that tenant. */
function Companies({ companies }: { companies: CompanyDto[] }) {
  return (
    <>
      <PortfolioTotals companies={companies} />
      <ul className="flex flex-col gap-9" aria-label="Companies">
        {companies.map((c) => (
          <li key={c.tenantId}>
            <Company company={c} />
          </li>
        ))}
      </ul>
    </>
  );
}

function PortfolioTotals({ companies }: { companies: CompanyDto[] }) {
  // One hook call per company, in a stable order (companies come from one query, so the list is fixed per render).
  const summaries = companies.map((c) => useBrandSummary(c.tenantId));
  const loaded = summaries.filter((s) => s.data);
  const sum = (key: keyof typeof ZERO) =>
    loaded.reduce((n, s) => n + (s.data?.brands.reduce((m, b) => m + b[key], 0) ?? 0), 0);
  const upcomingDays = loaded[0]?.data?.upcomingDays ?? 7;
  const partial = loaded.length < summaries.length;
  const figure = (key: keyof typeof ZERO) =>
    loaded.length === 0 ? '—' : partial ? `${sum(key)}+` : sum(key);
  return (
    <div className="flex flex-col gap-2">
      <KpiStrip
        items={[
          { label: 'Overdue approvals', value: figure('overdueApprovals') },
          {
            label: 'Failed or unknown releases',
            value: figure('publicationsNeedingPerson'),
            tone: sum('publicationsNeedingPerson') > 0 ? 'critical' : 'default',
          },
          { label: `Going out in ${upcomingDays} days`, value: figure('upcomingPublications') },
        ]}
      />
      {partial && summaries.some((s) => s.isError) && (
        <p className="text-xs text-muted-foreground">
          Counts for some companies are unavailable right now; the figures above cover the rest.
        </p>
      )}
    </div>
  );
}

/** One company: its role, then a row per brand the person can see there (brand.list and brand.summary, as that tenant). */
function Company({ company }: { company: CompanyDto }) {
  const brands = useBrandsOf(company.tenantId);
  const summary = useBrandSummary(company.tenantId);
  const headingId = `company-${company.tenantId}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-lg font-bold">
          {company.name}
        </h2>
        <span className="text-xs text-muted-foreground">
          {roleLabel(company.role)}
          {!company.allBrands && ' · Selected brands'}
        </span>
      </div>
      {brands.isPending && (
        <div className="border-t border-border py-3.5">
          <Skeleton label={`Loading the brands of ${company.name}`} lines={2} />
        </div>
      )}
      {brands.isError && (
        <div className="border-t border-border py-3.5 text-sm text-muted-foreground">
          <RequestError
            error={brands.error}
            onRetry={() => void brands.refetch()}
            title="Restricted access"
          />
        </div>
      )}
      {brands.isSuccess && brands.data.length === 0 && (
        <p className="border-t border-border py-3.5 text-sm text-muted-foreground">
          No brands yet.{' '}
          <Link to={`/c/${encodeURIComponent(company.tenantId)}`} className="font-medium text-foreground hover:opacity-60">
            Open the company <span aria-hidden="true">→</span>
          </Link>
        </p>
      )}
      {brands.isSuccess && brands.data.length > 0 && (
        <div className="flex flex-col" data-testid="summary-counts">
          {brands.data.map((b, i) => (
            <div key={b.id} className="om-in" style={{ animationDelay: `${i * 40}ms` }}>
              <BrandRow
                companyId={company.tenantId}
                brand={b}
                counts={summary.data?.brands.find((row) => row.brandId === b.id) ?? (summary.data ? ZERO : null)}
                countsFailed={summary.isError}
              />
            </div>
          ))}
        </div>
      )}
      {brands.isSuccess && (
        <Link
          to={`/c/${encodeURIComponent(company.tenantId)}`}
          className="mt-2 self-end text-xs text-muted-foreground hover:text-foreground"
        >
          Open <span aria-hidden="true">→</span>
          <span className="sr-only"> {company.name}: manage its brands</span>
        </Link>
      )}
    </section>
  );
}

type BrandRowDto = NonNullable<ReturnType<typeof useBrandsOf>['data']>[number];

function BrandRow({
  companyId,
  brand,
  counts,
  countsFailed,
}: {
  companyId: string;
  brand: BrandRowDto;
  counts: Pick<BrandSummaryDto['brands'][number], keyof typeof ZERO> | null;
  countsFailed: boolean;
}) {
  const flag =
    brand.status === 'setup' || !brand.publishedVersionId
      ? 'Setup incomplete · no published standards'
      : brand.status === 'archived'
        ? 'Archived'
        : null;
  const count = (n: number, noun: string) => (
    <span className="text-xs text-muted-foreground">
      <span className="tabular-nums text-foreground">{n}</span> {noun}
    </span>
  );
  return (
    <Link
      to={brandPath(companyId, brand.id)}
      className="grid grid-cols-[minmax(0,1fr)_16px] items-center gap-3 border-t border-border px-1 py-3.5 hover:bg-muted sm:grid-cols-[minmax(0,1fr)_90px_90px_90px_16px]"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-base font-bold">{brand.name}</span>
        {flag && <span className="text-xs text-status-warning">{flag}</span>}
        {counts && (
          <span className="flex gap-3 sm:hidden">
            {count(counts.overdueApprovals, 'overdue')}
            {count(counts.publicationsNeedingPerson, 'failed')}
            {count(counts.upcomingPublications, 'upcoming')}
          </span>
        )}
        {countsFailed && <span className="text-xs text-muted-foreground">Counts unavailable right now.</span>}
      </span>
      <span className="hidden sm:block">{counts && count(counts.overdueApprovals, 'overdue')}</span>
      <span className="hidden sm:block">{counts && count(counts.publicationsNeedingPerson, 'failed')}</span>
      <span className="hidden sm:block">{counts && count(counts.upcomingPublications, 'upcoming')}</span>
      <span aria-hidden="true" className="text-muted-foreground">
        →
      </span>
    </Link>
  );
}
