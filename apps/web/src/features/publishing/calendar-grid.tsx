import { useEffect, useRef, type KeyboardEvent } from 'react';
import { StatusDot, cn, type Tone } from '@oremedia/ui';
import { PackageTitle } from '../content/package-title';
import { destinationLabel, type DestinationDto } from '../destinations/use-destinations';
import {
  monthGrid,
  parseKey,
  publicationChip,
  weekDays,
  type CalendarView,
  type GridDay,
} from './publication-state';
import type { CalendarPublicationDto, ChannelDto } from './use-publishing';

export interface CalendarGridProps {
  view: CalendarView;
  anchorKey: string;
  todayKey: string;
  selectedKey: string;
  onSelect: (key: string) => void;
  byDay: Map<string, CalendarPublicationDto[]>;
  /** The week view names each publication's channel or website on its card. */
  channels: ReadonlyMap<string, ChannelDto>;
  destinations: ReadonlyMap<string, DestinationDto>;
  timeZone: string;
  /** The open publication (the week view's cards are pressed for it) and how a card opens one. */
  selectedId: string | null;
  onOpen: (publicationId: string) => void;
}

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
/** Dots a month cell shows before it says "+n"; the day list below names every publication. */
const MAX_DOTS = 8;
const longDate = (key: string) =>
  parseKey(key).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
const weekLabel = (key: string) =>
  parseKey(key).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });

/** The week card's left rule in the state's colour (the dot colours, as the interface draws it). */
const toneRuleClass: Record<Tone, string> = {
  neutral: 'border-l-status-neutral-dot',
  good: 'border-l-status-good-dot',
  warning: 'border-l-status-warning-dot',
  critical: 'border-l-status-critical-dot',
  info: 'border-l-status-info-dot',
};

/** The channel ("Acme LinkedIn (linkedin)") or website a publication goes to, as the day list names it. */
export const channelLabel = (
  p: Pick<CalendarPublicationDto, 'channelConnectionId' | 'destinationId'>,
  channels: ReadonlyMap<string, ChannelDto>,
  destinations: ReadonlyMap<string, DestinationDto>,
): string => {
  if (p.destinationId) return destinationLabel(destinations.get(p.destinationId), p.destinationId);
  const channel = p.channelConnectionId ? channels.get(p.channelConnectionId) : undefined;
  return channel ? `${channel.displayName} (${channel.providerKey})` : (p.channelConnectionId ?? '');
};

export const timeLabel = (iso: string, timeZone: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone });

/**
 * Month and week views drawn from day keys in the brand's time zone, as the interface lays them out: the month is a
 * ruled white grid with a weekday row, today's number on an ink circle, the selected day tinted and a dot per
 * publication in its state's colour; the week is seven columns of cards. One roving tab stop (the selected day)
 * and arrow keys move it, so the whole grid is one keyboard stop and every day is reachable (spec 21.3). Each day
 * names its date and how many publications it holds; the dots are decorative (the day list below carries the
 * states as text).
 */
export function CalendarGrid({
  view,
  anchorKey,
  todayKey,
  selectedKey,
  onSelect,
  byDay,
  channels,
  destinations,
  timeZone,
  selectedId,
  onOpen,
}: CalendarGridProps) {
  const days = view === 'month' ? monthGrid(anchorKey) : weekDays(anchorKey);
  const listRef = useRef<HTMLOListElement>(null);
  const hasSelected = days.some((d) => d.key === selectedKey);
  const focusKey = hasSelected ? selectedKey : (days.find((d) => d.inMonth)?.key ?? days[0]?.key);
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingFocus.current) return;
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `button[data-day="${pendingFocus.current}"]`,
    );
    pendingFocus.current = null;
    el?.focus();
  });

  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const step = delta[e.key];
    let target: GridDay | undefined;
    if (step !== undefined) target = days[index + step];
    else if (e.key === 'Home') target = days[index - (index % 7)];
    else if (e.key === 'End') target = days[index - (index % 7) + 6];
    if (!target) return;
    e.preventDefault();
    pendingFocus.current = target.key;
    onSelect(target.key);
  };

  const dayProps = (day: GridDay, index: number, items: CalendarPublicationDto[]) => {
    const isToday = day.key === todayKey;
    return {
      type: 'button' as const,
      'data-day': day.key,
      'data-testid': `day-${day.key}`,
      tabIndex: day.key === focusKey ? 0 : -1,
      'aria-pressed': day.key === selectedKey,
      'aria-current': isToday ? ('date' as const) : undefined,
      'aria-label': `${longDate(day.key)}${isToday ? ', today' : ''}: ${items.length} publication${items.length === 1 ? '' : 's'}`,
      onClick: () => onSelect(day.key),
      onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => move(e, index),
    };
  };

  const dots = (items: CalendarPublicationDto[]) => (
    <span className="flex flex-wrap gap-[3px]" aria-hidden="true">
      {items.slice(0, MAX_DOTS).map((p) => (
        <StatusDot key={p.publicationId} tone={publicationChip(p.state, p.remoteStatus).tone} size="sm" />
      ))}
      {items.length > MAX_DOTS && (
        <span className="text-2xs leading-[6px] text-muted-foreground">+{items.length - MAX_DOTS}</span>
      )}
    </span>
  );

  if (view === 'week')
    return (
      <ol ref={listRef} aria-label="Days of the week" className="grid grid-cols-7 gap-1.5">
        {days.map((day, index) => {
          const items = byDay.get(day.key) ?? [];
          const selected = day.key === selectedKey;
          const isToday = day.key === todayKey;
          return (
            <li key={day.key} className="flex min-w-0 flex-col gap-1.5">
              <button
                {...dayProps(day, index, items)}
                className={cn(
                  'flex min-w-0 flex-col items-start gap-1.5 rounded-md py-1.5 text-left text-xs tabular-nums',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected && 'font-semibold',
                  isToday ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="truncate">{weekLabel(day.key)}</span>
                {/* Below the stacking width the cards give way to dots; the day list below names each one. */}
                <span className="md:hidden">{dots(items)}</span>
              </button>
              {items.map((p) => {
                const chip = publicationChip(p.state, p.remoteStatus);
                const open = p.publicationId === selectedId;
                return (
                  <button
                    key={p.publicationId}
                    type="button"
                    aria-pressed={open}
                    onClick={() => onOpen(p.publicationId)}
                    className={cn(
                      'hidden min-w-0 flex-col gap-1 rounded-md border border-border border-l-[3px] p-2 text-left md:flex',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      toneRuleClass[chip.tone],
                      open ? 'bg-secondary' : 'bg-card hover:bg-card-tint',
                    )}
                  >
                    <span className="truncate text-2xs tabular-nums text-muted-foreground">
                      {timeLabel(p.scheduledFor, timeZone)} · {channelLabel(p, channels, destinations)}
                    </span>
                    <span className="line-clamp-2 text-xs leading-[1.3]">
                      <PackageTitle contentPackageId={p.contentPackageId} />
                    </span>
                    <span className="sr-only">{chip.label}</span>
                  </button>
                );
              })}
            </li>
          );
        })}
      </ol>
    );

  return (
    <div className="border-l border-t border-border bg-card">
      <div className="grid grid-cols-7" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span
            key={w}
            className="truncate border-b border-r border-border px-2.5 py-2 text-xs tabular-nums text-muted-foreground"
          >
            {w}
          </span>
        ))}
      </div>
      <ol ref={listRef} aria-label="Days of the month" className="grid grid-cols-7">
        {days.map((day, index) => {
          const items = byDay.get(day.key) ?? [];
          const selected = day.key === selectedKey;
          const isToday = day.key === todayKey;
          return (
            <li key={day.key} className="min-w-0">
              <button
                {...dayProps(day, index, items)}
                className={cn(
                  'flex h-[86px] w-full min-w-0 flex-col items-start gap-1.5 border-b border-r border-border p-2 text-left',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  selected ? 'bg-background' : 'bg-card hover:bg-background',
                )}
              >
                <span
                  className={cn(
                    'flex h-[22px] w-[22px] items-center justify-center rounded-full text-xs tabular-nums',
                    (isToday || selected) && 'font-semibold',
                    isToday && 'bg-primary text-primary-foreground',
                    // Muted text alone keeps 4.5:1 in both themes; a lighter value would not (WCAG 1.4.3).
                    !isToday && !day.inMonth && 'text-muted-foreground',
                  )}
                >
                  {day.dayOfMonth}
                </span>
                {items.length > 0 && dots(items)}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
