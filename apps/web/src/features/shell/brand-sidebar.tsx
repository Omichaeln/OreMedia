import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { Button, cn } from '@oremedia/ui';
import { brandPath } from '../brand/brand-context';
import { SessionControls } from '../session/session-controls';
import { useTheme } from '../../lib/theme';
import { BrandSwitcher } from './brand-switcher';

export interface NavItem {
  segment: string;
  label: string;
  /** Items that need a person here; only counts an API returns, never an estimate. */
  count?: number;
}

/**
 * The brand shell's navigation (spec 11.1, 21.1): the work of the week first (home, review, calendar, campaigns,
 * performance and the agents), the brand's standing material after (brand system, assets, settings). A count is a
 * number of items that need a person, and it is also spoken, so it never relies on its colour.
 */
export function BrandSidebar({
  companyId,
  companyName,
  brandId,
  brandName,
  work,
  standing,
  footer,
  onNavigate,
}: {
  companyId: string;
  companyName: string | null;
  brandId: string;
  brandName: string;
  work: NavItem[];
  standing: NavItem[];
  footer?: ReactNode;
  onNavigate?: () => void;
}) {
  const { theme, toggle } = useTheme();
  const item = (n: NavItem) => (
    <li key={n.segment}>
      <NavLink
        to={brandPath(companyId, brandId, n.segment)}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm',
            isActive
              ? 'bg-secondary font-medium text-secondary-foreground'
              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
          )
        }
      >
        <span className="truncate">{n.label}</span>
        {n.count !== undefined && n.count > 0 && (
          <span className="text-xs tabular-nums text-status-critical">
            {n.count}
            <span className="sr-only"> need you</span>
          </span>
        )}
      </NavLink>
    </li>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-3">
      <Link
        to="/portfolio"
        className="flex items-center gap-2 px-1 pt-1 text-sm font-semibold"
        onClick={onNavigate}
      >
        <span
          aria-hidden="true"
          className="inline-flex h-5 w-5 items-center justify-center rounded bg-primary"
        >
          <span className="h-2 w-2 rounded-full bg-accent" />
        </span>
        Oremedia
      </Link>
      <BrandSwitcher
        companyId={companyId}
        companyName={companyName}
        brandId={brandId}
        brandName={brandName}
      />
      <nav aria-label="Brand sections" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <ul className="flex flex-col gap-0.5">{work.map(item)}</ul>
        <ul className="flex flex-col gap-0.5 border-t border-border pt-3">{standing.map(item)}</ul>
      </nav>
      <div className="flex flex-col gap-3 border-t border-border pt-3">
        {footer}
        <div className="flex flex-wrap items-center gap-1">
          <SessionControls />
          <Button size="sm" variant="ghost" onClick={toggle} aria-pressed={theme === 'dark'}>
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </Button>
        </div>
      </div>
    </div>
  );
}
