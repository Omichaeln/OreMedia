import { useState } from 'react';
import { Outlet, useLocation, useMatch, useParams } from 'react-router';
import { IconButton, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../../../../components/request-state';
import { Drawer, DrawerContent, DrawerTrigger } from '../../../../../components/drawer';
import { useCompanies } from '../../../../../features/portfolio/use-companies';
import { useBrand } from '../../../../../features/brand/use-brand';
import { type BrandContext } from '../../../../../features/brand/brand-context';
import { BrandSidebar, type NavItem } from '../../../../../features/shell/brand-sidebar';
import { useNavCounts } from '../../../../../features/shell/use-nav-counts';
import type { BrandDto } from '../../../../../features/brand/use-brand';

/**
 * D-28: the supplied interface's order, with the inbox (which it has no screen for) kept beside the work it serves.
 * Reports joins the list with its screen (D-29); a link to a screen that does not exist is a dead control.
 */
const WORK: NavItem[] = [
  { segment: 'home', label: 'Home' },
  { segment: 'review', label: 'Review' },
  { segment: 'calendar', label: 'Calendar' },
  { segment: 'campaigns', label: 'Campaigns' },
  { segment: 'studio', label: 'Studio' },
  { segment: 'performance', label: 'Performance' },
  { segment: 'reports', label: 'Reports' },
  { segment: 'inbox', label: 'Inbox' },
  { segment: 'intelligence', label: 'Intelligence' },
  { segment: 'experiments', label: 'Experiments' },
  { segment: 'agents', label: 'Agents' },
];
const STANDING: NavItem[] = [
  { segment: 'system', label: 'Brand system' },
  { segment: 'assets', label: 'Assets' },
  { segment: 'settings', label: 'Settings' },
];
/** Screens reachable without a navigation entry (D-28): named in the narrow top bar like the others. */
const OTHER_TITLES: Record<string, string> = { overview: 'Web overview' };

const screenTitle = (pathname: string): string => {
  const segment = pathname.split('/b/')[1]?.split('/')[1] ?? 'home';
  return [...WORK, ...STANDING].find((n) => n.segment === segment)?.label ?? OTHER_TITLES[segment] ?? 'Home';
};

/**
 * Spec 11.1: company and brand are always visible; every brand screen renders inside this shell. A 224 px sidebar
 * beside the screen from 900 px (the `wide` breakpoint); below that a 52 px bar names brand and screen and opens the
 * same navigation as a drawer. The Studio (its create screen, the format step and every document) is a full-screen
 * workspace with its own breadcrumb bar, as the interface draws it, so it renders without the sidebar.
 */
export function BrandLayout() {
  const { company = '', brand: brandId = '' } = useParams();
  const { pathname } = useLocation();
  const companies = useCompanies();
  const brand = useBrand(brandId);
  // The Studio is full-screen in the interface: its create and format steps and every document have their own bar.
  const inStudio = useMatch('/c/:company/b/:brand/studio/*') !== null;
  const [menuOpen, setMenuOpen] = useState(false);
  const membership = companies.data?.find((c) => c.tenantId === company) ?? null;
  const companyName = membership?.name ?? null;
  const role = membership?.role ?? null;
  const brandName = brand.data?.name ?? (brand.isPending ? 'Loading…' : brandId);

  const sidebar = (onNavigate?: () => void) =>
    brand.data ? (
      <CountedSidebar
        brand={brand.data}
        companyId={company}
        companyName={companyName}
        role={role}
        onNavigate={onNavigate}
      />
    ) : (
      <BrandSidebar
        companyId={company}
        companyName={companyName}
        brandId={brandId}
        brandName={brandName}
        role={role}
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
        className="hidden w-56 shrink-0 border-r border-border bg-background wide:block"
      >
        {sidebar()}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-md wide:hidden">
          <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
            <DrawerTrigger asChild>
              <IconButton label="Menu" size="md" className="rounded-lg">
                <span className="flex flex-col items-center gap-[3px]">
                  <span className="block h-[1.5px] w-3.5 bg-foreground" />
                  <span className="block h-[1.5px] w-3.5 bg-foreground" />
                  <span className="block h-[1.5px] w-3.5 bg-foreground" />
                </span>
              </IconButton>
            </DrawerTrigger>
            <DrawerContent title="Brand navigation" className="w-[min(85vw,264px)] bg-background">
              {sidebar(() => setMenuOpen(false))}
            </DrawerContent>
          </Drawer>
          <p className="flex min-w-0 items-center gap-2 text-sm">
            <span className="sr-only" aria-label="Company">
              {companyName ?? company}
            </span>
            <span className="truncate text-muted-foreground" aria-label="Brand">
              {brandName}
            </span>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span className="truncate font-medium">{screenTitle(pathname)}</span>
          </p>
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
  role,
  onNavigate,
}: {
  brand: BrandDto;
  companyId: string;
  companyName: string | null;
  role: string | null;
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
      role={role}
      work={withCount(WORK)}
      standing={withCount(STANDING)}
      onNavigate={onNavigate}
    />
  );
}
