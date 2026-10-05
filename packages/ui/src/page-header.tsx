import * as React from 'react';
import { cn } from './cn';

export interface PageHeaderProps {
  title: React.ReactNode;
  /** A small line above the title: a date, an identifier, a section. */
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** The id of the h1, for `aria-labelledby`. */
  id?: string;
  className?: string;
}

/** A screen's heading as the interface sets it: 28 px bold, a muted line under it, actions on the right. */
export function PageHeader({ title, eyebrow, description, actions, id, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-x-6 gap-y-3', className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow && <p className="om-eyebrow">{eyebrow}</p>}
        <h1 id={id} className="text-2xl font-bold tracking-title">
          {title}
        </h1>
        {description && <p className="text-md text-pretty text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export interface KpiStripProps {
  items: Array<{ label: string; value: React.ReactNode; tone?: 'default' | 'critical' | 'good' }>;
  className?: string;
}

/** A row of large figures between two rules (the portfolio's counts, a screen's totals). */
export function KpiStrip({ items, className }: KpiStripProps) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 border-y border-border',
        items.length >= 3 ? 'grid-cols-3' : 'grid-cols-2',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-1 py-4">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd
            className={cn(
              'text-xl font-bold tabular-nums',
              item.tone === 'critical' && 'text-status-critical',
              item.tone === 'good' && 'text-status-good',
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
