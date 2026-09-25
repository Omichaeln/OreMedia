import { Link } from 'react-router';
import { Badge, EmptyState, Skeleton } from '@oremedia/ui';
import { TopBar } from '../root';
import { RequestError } from '../../components/request-state';
import { useCompanies } from '../../features/portfolio/use-companies';

/**
 * Spec 21.2 portfolio states: no memberships; restricted access. The v3 prototype's layout: each company is its own
 * section (a separate tenant; nothing is shared between them) with the person's role there and a link into it.
 */
export function PortfolioRoute() {
  const companies = useCompanies();
  return (
    <>
      <TopBar title="Portfolio" />
      <main id="main" className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8">
        <header>
          <h1 className="text-xl font-semibold">Portfolio</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Companies you are a member of. Each company is a separate tenant; nothing is shared between them,
            and the server re-checks your membership on every request.
          </p>
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
            description="Ask a company owner to invite you. Invitations are managed in each company's settings; nothing appears here until a membership is active."
          />
        )}
        {companies.isSuccess && companies.data.length > 0 && (
          <ul className="flex flex-col divide-y divide-border border-y border-border" aria-label="Companies">
            {companies.data.map((c) => (
              <li key={c.tenantId}>
                <section
                  aria-labelledby={`company-${c.tenantId}`}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <div className="min-w-0">
                    <h2 id={`company-${c.tenantId}`} className="font-semibold">
                      {c.name}
                    </h2>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <Badge glyph={false}>{c.role}</Badge>
                      <Badge glyph={false}>{c.allBrands ? 'All brands' : 'Selected brands'}</Badge>
                    </p>
                  </div>
                  <Link
                    to={`/c/${encodeURIComponent(c.tenantId)}`}
                    className="text-sm font-medium underline-offset-2 hover:underline"
                  >
                    Open <span aria-hidden="true">→</span>
                  </Link>
                </section>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
