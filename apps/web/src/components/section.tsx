import type { ReactNode } from 'react';

/**
 * An unboxed section (home, performance, intelligence, settings): a small uppercase heading with an optional action on the
 * right, then content whose rows are divided by rules. A screen reads as one column of work rather than a wall of
 * panels.
 */
export function Section({
  id,
  title,
  action,
  testId,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2" data-testid={testId}>
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
