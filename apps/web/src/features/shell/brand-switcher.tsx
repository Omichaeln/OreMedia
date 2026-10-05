import { useNavigate } from 'react-router';
import { cn } from '@oremedia/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/dropdown-menu';
import { useCompanies } from '../portfolio/use-companies';
import { brandPath } from '../brand/brand-context';
import { useBrands } from '../brand/use-brand';

/**
 * Spec 11.1: company and brand are always visible. The switcher names both; it lists the brands of this company and
 * the person's other companies (each opens that company's brand list), and the portfolio. Switching is navigation:
 * company and brand live in the URL and the server re-checks membership on every request.
 */
export function BrandSwitcher({
  companyId,
  companyName,
  brandId,
  brandName,
}: {
  companyId: string;
  companyName: string | null;
  brandId: string;
  brandName: string;
}) {
  const navigate = useNavigate();
  const brands = useBrands();
  const companies = useCompanies();
  const otherCompanies = (companies.data ?? []).filter((c) => c.tenantId !== companyId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex w-full flex-col items-start gap-0.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors',
          'hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <span className="block w-full truncate text-xs text-muted-foreground" aria-label="Company">
          {companyName ?? companyId}
        </span>
        <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
          <span className="truncate" aria-label="Brand">
            {brandName}
          </span>
          <span aria-hidden="true" className="text-muted-foreground">
            ⌄
          </span>
        </span>
        <span className="sr-only">. Switch brand or company</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
          Brands of {companyName ?? 'this company'}
        </p>
        {(brands.data ?? []).map((b) => (
          <DropdownMenuItem
            key={b.id}
            onSelect={() => navigate(brandPath(companyId, b.id))}
            aria-current={b.id === brandId ? 'true' : undefined}
            className={cn(b.id === brandId && 'font-medium')}
          >
            {b.name}
            {b.id === brandId && <span className="sr-only"> (current)</span>}
          </DropdownMenuItem>
        ))}
        {otherCompanies.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">Other companies</p>
            {otherCompanies.map((c) => (
              <DropdownMenuItem
                key={c.tenantId}
                onSelect={() => navigate(`/c/${encodeURIComponent(c.tenantId)}`)}
              >
                {c.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/portfolio')}>All companies</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
