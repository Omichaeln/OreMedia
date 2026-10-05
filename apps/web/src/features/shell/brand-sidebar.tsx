import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { cn } from '@oremedia/ui';
import { brandPath } from '../brand/brand-context';
import { useDeploymentBrand } from '../../lib/deployment-brand';
import { AccountMenu } from '../session/account-menu';
import { AgentSpend } from './agent-spend';
import { BrandSwitcher } from './brand-switcher';

export interface NavItem {
  segment: string;
  label: string;
  /** Items that need a person here; only counts an API returns, never an estimate. */
  count?: number;
}

/** The product mark: an ink square with the accent dot, then the deployment's name. */
export function ProductMark({ className }: { className?: string }) {
  const deployment = useDeploymentBrand();
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <span
        aria-hidden="true"
        className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md bg-primary"
      >
        <span className="h-2 w-2 rounded-full bg-ring" />
      </span>
      <span className="text-base font-bold tracking-[-0.01em]">{deployment.name}</span>
    </span>
  );
}

/**
 * The brand shell's navigation (spec 11.1, 21.1; D-28 order): the work of the week first (home, review, calendar,
 * campaigns, the studio, performance, reports, inbox, intelligence, experiments, agents), the brand's standing
 * material after a gap (brand system, assets, settings). A count is a number of items that need a person, and it is
 * also spoken, so it never relies on its colour. The foot shows the brand's agent spend this month (when the person
 * may read it) and who is signed in.
 */
export function BrandSidebar({
  companyId,
  companyName,
  brandId,
  brandName,
  role,
  work,
  standing,
  footer,
  onNavigate,
}: {
  companyId: string;
  companyName: string | null;
  brandId: string;
  brandName: string;
  /** The person's role in this company, when the membership list has loaded. */
  role: string | null;
  work: NavItem[];
  standing: NavItem[];
  footer?: ReactNode;
  onNavigate?: () => void;
}) {
  const item = (n: NavItem) => (
    <li key={n.segment}>
      <NavLink
        to={brandPath(companyId, brandId, n.segment)}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex items-center justify-between gap-2 rounded-md px-2.5 py-[7px] text-sm transition-colors',
            isActive
              ? 'bg-secondary font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )
        }
      >
        <span className="truncate">{n.label}</span>
        {n.count !== undefined && n.count > 0 && (
          <span className="text-xs tabular-nums text-accent-ink">
            {n.count}
            <span className="sr-only"> need you</span>
          </span>
        )}
      </NavLink>
    </li>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-[18px] px-3 py-4">
      <Link to="/portfolio" className="rounded-md px-2 py-1 hover:opacity-60" onClick={onNavigate}>
        <ProductMark />
      </Link>
      <BrandSwitcher
        companyId={companyId}
        companyName={companyName}
        brandId={brandId}
        brandName={brandName}
      />
      <nav aria-label="Brand sections" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ul className="flex flex-col gap-px">{work.map(item)}</ul>
        <ul className="mt-3 flex flex-col gap-px">{standing.map(item)}</ul>
      </nav>
      <div className="mt-auto flex flex-col gap-2.5">
        {footer}
        <AgentSpend brandId={brandId} role={role} />
        <AccountMenu role={role} />
      </div>
    </div>
  );
}
