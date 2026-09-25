import type { ReactNode } from 'react';

/**
 * A home section: a small uppercase heading with an optional link on the right, then an unboxed list whose rows are
 * divided by rules. The screen reads as one column of work rather than a wall of panels.
 */
export function HomeSection({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 border-b border-border pb-2">
        <h2 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {action && <div className="text-sm">{action}</div>}
      </div>
      {children}
    </section>
  );
}
