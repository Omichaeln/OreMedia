import type { ReactNode } from 'react';

/**
 * An unboxed section (home, performance, intelligence, settings): a small uppercase heading with an optional action on the
 * right, then content whose rows are divided by rules. A screen reads as one column of work rather than a wall of
 * panels. Inside a detail that already has its own h2 (a review request), the heading is an h3.
 */
export function Section({
  id,
  title,
  action,
  testId,
  level = 2,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  testId?: string;
  /** Heading level for the document outline. */
  level?: 2 | 3;
  children: ReactNode;
}) {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2 border-b border-border pb-2">
        <Heading id={id} className="om-label">
          {title}
        </Heading>
        {action && <div className="text-xs text-muted-foreground">{action}</div>}
      </div>
      {children}
    </section>
  );
}
