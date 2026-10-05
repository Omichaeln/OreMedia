import * as React from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '@oremedia/ui';

export const Tabs = RadixTabs.Root;

/** A row of tabs on one rule, as the interface draws them (Settings, Intelligence): 20 px apart, scrolling sideways when narrow. */
export function TabList({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <RadixTabs.List
      aria-label={label}
      className={cn('flex shrink-0 gap-5 overflow-x-auto border-b border-border', className)}
    >
      {children}
    </RadixTabs.List>
  );
}

/** The active tab is ink with a 2 px ink underline on the list's rule; the others are muted text. */
export function Tab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <RadixTabs.Trigger
      value={value}
      className={cn(
        'relative -mb-px whitespace-nowrap rounded-t-md border-b-2 border-transparent py-2.5 text-sm text-muted-foreground',
        'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground',
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
