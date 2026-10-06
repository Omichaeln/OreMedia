import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '@oremedia/ui';
import { useBrandContext } from '../brand/brand-context';

/**
 * The studio's full-screen bar, as the supplied interface draws it on every studio step (create, pick a format, the
 * design and video workspaces): a back arrow, the breadcrumb (brand / Studio / the step), the save state while a
 * document is open, and the step's actions on the right. The company is named for assistive technology, as the
 * shell's narrow bar does. Below the width the actions need, they wrap under the breadcrumb.
 */
export function StudioBar({
  back,
  crumbs,
  status,
  actions,
}: {
  back: { to: string; label: string; title?: string };
  /** After "Studio"; the last is the current step (a node, so the editor's renamable title can sit there). */
  crumbs: ReactNode[];
  status?: ReactNode;
  actions?: ReactNode;
}) {
  const { companyId, companyName, brand } = useBrandContext();
  return (
    <header className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-border bg-card px-4 py-2">
      <Link
        to={back.to}
        aria-label={back.label}
        title={back.title ?? back.label}
        className="-ml-2 inline-flex min-h-6 items-center rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true">←</span>
      </Link>
      <nav aria-label="Breadcrumb" className="min-w-0 max-w-full">
        <ol className="flex min-w-0 items-center gap-2 whitespace-nowrap text-sm">
          <li className="sr-only">{companyName ?? companyId}</li>
          <li className="min-w-0 truncate text-muted-foreground">{brand.name}</li>
          <Separator />
          <li className="text-muted-foreground">Studio</li>
          {crumbs.map((crumb, i) => {
            const current = i === crumbs.length - 1;
            return (
              <Fragment key={i}>
                <Separator />
                <li
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'min-w-0',
                    current ? 'truncate font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {crumb}
                </li>
              </Fragment>
            );
          })}
        </ol>
      </nav>
      {status}
      {actions && <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>}
    </header>
  );
}

function Separator() {
  return (
    <li aria-hidden="true" className="text-muted-foreground">
      /
    </li>
  );
}
