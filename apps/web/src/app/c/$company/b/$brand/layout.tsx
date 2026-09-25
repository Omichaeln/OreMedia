import { useState } from 'react';
import { Outlet, useMatch, useParams } from 'react-router';
import { Button, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../../../../components/request-state';
import { Drawer, DrawerContent, DrawerTrigger } from '../../../../../components/drawer';
import { useCompanies } from '../../../../../features/portfolio/use-companies';
import { useBrand } from '../../../../../features/brand/use-brand';
import { type BrandContext } from '../../../../../features/brand/brand-context';
import { BrandSidebar, type NavItem } from '../../../../../features/shell/brand-sidebar';
import { useNavCounts } from '../../../../../features/shell/use-nav-counts';
import type { BrandDto } from '../../../../../features/brand/use-brand';

const WORK: NavItem[] = [
  { segment: 'home', label: 'Home' },
  { segment: 'review', label: 'Review' },
  { segment: 'calendar', label: 'Calendar' },
  { segment: 'campaigns', label: 'Campaigns' },
  { segment: 'performance', label: 'Performance' },
  { segment: 'intelligence', label: 'Intelligence' },
  { segment: 'experiments', label: 'Experiments' },
  { segment: 'agents', label: 'Agents' },
];
const STANDING: NavItem[] = [
  { segment: 'system', label: 'Brand system' },
  { segment: 'assets', label: 'Assets' },
  { segment: 'settings', label: 'Settings' },
];

/**
 * Spec 11.1: company and brand are always visible; every brand screen renders inside this shell. A sidebar beside
 * the screen from 1024 px; below that a top bar names company and brand and opens the same navigation as a drawer.
 * The studio is a full-screen workspace with its own breadcrumb, so it renders without the sidebar.
 */
export function BrandLayout() {
  const { company = '', brand: brandId = '' } = useParams();
  const companies = useCompanies();
  const brand = useBrand(brandId);
  const inStudio = useMatch('/c/:company/b/:brand/studio/*') !== null;
  const [menuOpen, setMenuOpen] = useState(false);
  const companyName = companies.data?.find((c) => c.tenantId === company)?.name ?? null;
  const brandName = brand.data?.name ?? (brand.isPending ? 'Loading…' : brandId);

  const sidebar = (onNavigate?: () => void) =>
    brand.data ? (
      <CountedSidebar
        brand={brand.data}
        companyId={company}
        companyName={companyName}
        onNavigate={onNavigate}
      />
    ) : (
      <BrandSidebar
        companyId={company}
        companyName={companyName}
        brandId={brandId}
        brandName={brandName}
        work={WORK}
        standing={STANDING}
        onNavigate={onNavigate}
      />
    );

  const content = (
    <>
      {brand.isPending && (
        <main id="main" className="p-6">
          <Skeleton label="Loading brand" />
        </main>
      )}
      {brand.isError && (
        <main id="main" className="p-6">
          <RequestError error={brand.error} onRetry={() => void brand.refetch()} title="Restricted access" />
        </main>
      )}
      {brand.isSuccess && (
        <Outlet
          context={{ companyId: company, companyName, brandId, brand: brand.data } satisfies BrandContext}
        />
      )}
    </>
  );

  if (inStudio) return <div className="flex h-full min-h-0 flex-col">{content}</div>;

  return (
    <div className="flex h-full min-h-0">
      <aside
        aria-label="Brand navigation"
        className="hidden w-60 shrink-0 border-r border-border bg-muted lg:block"
      >
        {sidebar()}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2 lg:hidden">
          <p className="min-w-0 truncate text-sm">
            <span className="text-muted-foreground" aria-label="Company">
              {companyName ?? company}
            </span>
            <span aria-hidden="true" className="px-1.5 text-muted-foreground">
              /
            </span>
            <span className="font-medium" aria-label="Brand">
              {brandName}
            </span>
          </p>
          <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
            <DrawerTrigger asChild>
              <Button size="sm" variant="secondary">
                Menu
              </Button>
            </DrawerTrigger>
            <DrawerContent title="Brand navigation">{sidebar(() => setMenuOpen(false))}</DrawerContent>
          </Drawer>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
      </div>
    </div>
  );
}

/** The sidebar once the brand has loaded: the same navigation with the counts its sections report. */
function CountedSidebar({
  brand,
  companyId,
  companyName,
  onNavigate,
}: {
  brand: BrandDto;
  companyId: string;
  companyName: string | null;
  onNavigate?: () => void;
}) {
  const counts = useNavCounts(brand);
  const withCount = (items: NavItem[]) =>
    items.map((n) => {
      const count = counts[n.segment as keyof typeof counts];
      return count === undefined ? n : { ...n, count };
    });
  return (
    <BrandSidebar
      companyId={companyId}
      companyName={companyName}
      brandId={brand.id}
      brandName={brand.name}
      work={withCount(WORK)}
      standing={withCount(STANDING)}
      onNavigate={onNavigate}
    />
  );
}
