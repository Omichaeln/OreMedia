import * as React from 'react';
import { cn } from './cn';

export type Tone = 'neutral' | 'good' | 'warning' | 'critical' | 'info';

/** Every tone has a glyph so colour is never the only carrier of status (spec 21.3). */
export const toneGlyph: Record<Tone, string> = {
  neutral: '•',
  good: '✓',
  warning: '!',
  critical: '✕',
  info: 'i',
};

export const toneTextClass: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  good: 'text-status-good',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
  info: 'text-status-info',
};

export const toneBorderClass: Record<Tone, string> = {
  neutral: 'border-border',
  good: 'border-status-good',
  warning: 'border-status-warning',
  critical: 'border-status-critical',
  info: 'border-status-info',
};

/** The dot colours: lighter than the text set, for marks beside text that already carries the state. */
export const toneDotClass: Record<Tone, string> = {
  neutral: 'bg-status-neutral-dot',
  good: 'bg-status-good-dot',
  warning: 'bg-status-warning-dot',
  critical: 'bg-status-critical-dot',
  info: 'bg-status-info-dot',
};

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: Tone;
  size?: 'sm' | 'md';
}

/** A 6 or 7 px status mark; decorative, so the text beside it names the state (spec 21.3). */
export function StatusDot({ tone, size = 'md', className, ...props }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block shrink-0 rounded-full',
        size === 'sm' ? 'h-1.5 w-1.5' : 'h-[7px] w-[7px]',
        toneDotClass[tone],
        className,
      )}
      {...props}
    />
  );
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /**
   * Hide the mark when the text itself is the status (e.g. "Locked"). The mark is a dot in the tone's colour; the
   * glyph the tone also has is kept for assistive technology only, so colour is never the only carrier of state.
   */
  glyph?: boolean;
  /** `pill`: an outlined chip (filters, counts); default: a dot and the label, as the interface sets states. */
  variant?: 'dot' | 'pill';
}

export function Badge({
  tone = 'neutral',
  glyph = true,
  variant = 'dot',
  className,
  children,
  ...props
}: BadgeProps) {
  if (variant === 'pill')
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium leading-4',
          toneTextClass[tone],
          className,
        )}
        {...props}
      >
        {glyph && <span aria-hidden="true">{toneGlyph[tone]}</span>}
        {children}
      </span>
    );
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium leading-4',
        tone === 'neutral' ? 'text-muted-foreground' : 'text-foreground',
        className,
      )}
      {...props}
    >
      {glyph && <StatusDot tone={tone} size="sm" />}
      {glyph && <span className="sr-only">{toneGlyph[tone]} </span>}
      {children}
    </span>
  );
}
