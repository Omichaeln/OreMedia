import * as React from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '@oremedia/ui';

export const Tabs = RadixTabs.Root;

/**
 * `line` (default): a row of tabs on one rule, as the interface draws them (Settings, Intelligence): 20 px apart,
 * scrolling sideways when narrow. `pill`: the interface's panel tabs (the studio's side panels), small buttons with
 * the active one on the secondary fill and no rule.
 */
export type TabVariant = 'line' | 'pill';

export function TabList({
  label,
  className,
  variant = 'line',
  children,
}: {
  label: string;
  className?: string;
  variant?: TabVariant;
  children: React.ReactNode;
}) {
  return (
    <RadixTabs.List
      aria-label={label}
      className={cn(
        'flex shrink-0',
        variant === 'line' ? 'gap-5 overflow-x-auto border-b border-border' : 'gap-0.5 px-2.5 pt-2.5',
        className,
      )}
    >
      {children}
    </RadixTabs.List>
  );
}

/** `line`: the active tab is ink with a 2 px ink underline on the list's rule; the others are muted text. */
export function Tab({
  value,
  variant = 'line',
  children,
}: {
  value: string;
  variant?: TabVariant;
  children: React.ReactNode;
}) {
  return (
    <RadixTabs.Trigger
      value={value}
      className={cn(
        'whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        variant === 'line'
          ? 'relative -mb-px rounded-t-md border-b-2 border-transparent py-2.5 text-sm data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground'
          : 'rounded-md px-2.5 py-1.5 text-xs font-medium data-[state=active]:bg-secondary data-[state=active]:text-foreground',
      )}
    >
      {children}
    </RadixTabs.Trigger>
  );
}

export function TabPanel({
  value,
  className,
  keepMounted = false,
  children,
}: {
  value: string;
  className?: string;
  /** Keeps the panel (and any unsent input in it) mounted while another tab is shown; it is hidden, not removed. */
  keepMounted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <RadixTabs.Content
      value={value}
      forceMount={keepMounted || undefined}
      className={cn(
        'min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring',
        keepMounted && 'data-[state=inactive]:hidden',
        className,
      )}
    >
      {children}
    </RadixTabs.Content>
  );
}
