import * as React from 'react';
import { cn } from './cn';

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The chip is the current filter: `aria-pressed` and the ink outline. */
  selected?: boolean;
  count?: number;
}

/** A filter pill (All · Needs attention · Awaiting · Approved): outlined, the selected one in ink. */
export const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { selected = false, count, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border bg-card px-3 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected ? 'border-foreground text-foreground' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined && <span className="tabular-nums text-muted-foreground">{count}</span>}
    </button>
  );
});
