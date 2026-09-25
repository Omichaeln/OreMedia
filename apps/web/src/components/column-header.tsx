import type { ReactNode } from 'react';
import { Button } from '@oremedia/ui';

/** A list row in a column screen (campaigns, experiments, agent runs): unboxed, divided by rules, selected tinted. */
export const listButton = (selected: boolean) =>
  `flex w-full flex-col gap-1 px-4 py-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected ? 'bg-secondary' : 'hover:bg-muted'}`;

/** A column's heading row: the title and the one action that adds to it. */
export function ColumnHeader({
  id,
  title,
  level,
  subtitle,
  action,
}: {
  id: string;
  title: string;
  level: 1 | 2;
  subtitle?: string;
  action?: ReactNode;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div className="flex items-start justify-between gap-2 border-b border-border px-4 pb-3 pt-6">
      <div className="min-w-0">
        <Heading
          id={id}
          className={
            level === 1
              ? 'text-xl font-semibold'
              : 'text-xs font-semibold uppercase tracking-wide text-muted-foreground'
          }
        >
          {title}
        </Heading>
        {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** The "+" that opens a column's create form, named for screen readers; "Close" while the form is open. */
export function AddToggle({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <Button size="sm" variant="ghost" aria-expanded={open} onClick={onToggle}>
      {open ? (
        'Close'
      ) : (
        <>
          <span aria-hidden="true" className="text-base leading-none">
            +
          </span>
          <span className="sr-only">{label}</span>
        </>
      )}
    </Button>
  );
}
