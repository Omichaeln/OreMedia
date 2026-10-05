import * as React from 'react';
import { cn } from './cn';
import { StatusDot, toneGlyph, type Tone } from './badge';

export interface StatusBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  tone: Tone;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Critical banners interrupt (role=alert); everything else is polite (role=status). */
  live?: 'assertive' | 'polite';
  /** Show a spinner glyph (in-progress states). */
  busy?: boolean;
}

/** Status is carried by glyph + text + role, never by colour alone (spec 21.3). */
export const StatusBanner = React.forwardRef<HTMLDivElement, StatusBannerProps>(function StatusBanner(
  { tone, title, description, actions, live, busy, className, ...props },
  ref,
) {
  const assertive = live ? live === 'assertive' : tone === 'critical';
  return (
    <div
      ref={ref}
      role={assertive ? 'alert' : 'status'}
      aria-busy={busy || undefined}
      className={cn(
        'om-in flex items-start gap-3.5 rounded-xl border border-border bg-card px-4 py-3 text-sm',
        tone === 'critical' && 'bg-status-critical-tint',
        tone === 'warning' && 'bg-status-warning-tint',
        className,
      )}
      {...props}
    >
      {busy ? (
        <span
          aria-hidden="true"
          className="mt-1.5 inline-block h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-status-info-dot"
        />
      ) : (
        <StatusDot tone={tone} className="mt-1.5" />
      )}
      <span className="sr-only">{toneGlyph[tone]} </span>
      <div className="min-w-0 flex-1">
        <p className="text-base font-bold text-foreground">{title}</p>
        {description && <div className="mt-0.5 text-pretty text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 self-center">{actions}</div>}
    </div>
  );
});
