import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Button, EmptyState, PageHeader, Skeleton, StatusDot, cn } from '@oremedia/ui';
import { RequestError } from '../../../../../../components/request-state';
import { PackageTitle } from '../../../../../../features/content/package-title';
import { brandPath, useBrandContext } from '../../../../../../features/brand/brand-context';
import { CalendarGrid, channelLabel, timeLabel } from '../../../../../../features/publishing/calendar-grid';
import { ChannelStatus } from '../../../../../../features/publishing/channel-status';
import { useDestinationMap } from '../../../../../../features/destinations/use-destinations';
import { PublicationDetail } from '../../../../../../features/publishing/publication-detail';
import {
  dayKey,
  groupByDay,
  parseKey,
  publicationChip,
  rangeFor,
  shiftAnchor,
  type CalendarView,
} from '../../../../../../features/publishing/publication-state';
import { ScheduleForm } from '../../../../../../features/publishing/schedule-form';
import {
  useCalendarRange,
  useChannels,
  type ChannelDto,
} from '../../../../../../features/publishing/use-publishing';
import { toUiError } from '../../../../../../lib/errors';
import { useTRPC } from '../../../../../../lib/trpc';

const VIEWS: Array<[CalendarView, string]> = [
  ['month', 'Month'],
  ['week', 'Week'],
];

const periodTitle = (view: CalendarView, key: string) => {
  const date = parseKey(key);
  return view === 'month'
    ? date.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : `Week of ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`;
};

/**
 * Spec 21.1 calendar: scheduling and per-channel outcomes, laid out as the supplied interface: the period as the
 * title, Month / Week, ‹ Today ›, Schedule; the channel banners; the month grid (or the week's columns); the
 * selected day's list; the open publication in a right drawer. Spec 21.2 states: token expiry (channel banners),
 * invalid media (variant findings in the schedule form), partial success and outcome_unknown with reconcile,
 * cancellation race and held with reasons (publication detail). The selected day and publication live in the URL
 * so a deep link opens the same view.
 */
export function CalendarRoute() {
  const { companyId, brandId, brand } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const timeZone = brand.timezone || 'UTC';
  const todayKey = dayKey(new Date(), timeZone);
  const [params, setParams] = useSearchParams();
  const view: CalendarView = params.get('view') === 'week' ? 'week' : 'month';
  const selectedKey = params.get('day') ?? todayKey;
  const [anchorKey, setAnchorKey] = useState(selectedKey);
  // Back/forward or a deep link changes `day` without selectDay: the grid follows the selected day.
  useEffect(() => setAnchorKey(selectedKey), [selectedKey]);
  const selectedId = params.get('publication');
  const range = useMemo(() => rangeFor(view, anchorKey, timeZone), [view, anchorKey, timeZone]);
  const calendar = useCalendarRange(brandId, range.from, range.to);
  const channels = useChannels(brandId);
  const channelMap = useMemo(
    () => new Map<string, ChannelDto>((channels.data ?? []).map((c) => [c.id, c])),
    [channels.data],
  );
  const destinationMap = useDestinationMap(brandId);
  const byDay = useMemo(
    () => groupByDay(calendar.data?.publications ?? [], timeZone),
    [calendar.data, timeZone],
  );
  const dayItems = byDay.get(selectedKey) ?? [];

  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };
  const selectDay = (key: string) => {
    setAnchorKey(key);
    update({ day: key });
  };
  const go = (direction: -1 | 1) => setAnchorKey((k) => shiftAnchor(k, view, direction));
  const openPublication = (publicationId: string) => update({ publication: publicationId });
  const closePublication = () => {
    const id = selectedId;
    update({ publication: null });
    // Focus goes back to the row that opened the drawer when it is still on the page.
    if (id) document.querySelector<HTMLButtonElement>(`[data-publication="${id}"]`)?.focus();
  };

  return (
    <main
      id="main"
      className="om-in flex w-full min-w-0 flex-col gap-[22px] px-4 py-8 sm:px-9 sm:pb-20 sm:pt-9"
    >
      <PageHeader
        title={periodTitle(view, anchorKey)}
        description={`${timeZone} · each channel is its own publication with its own outcome`}
        actions={
          <>
            <div
              role="group"
              aria-label="View"
              className="flex h-7 overflow-hidden rounded-md border border-border bg-card"
            >
              {VIEWS.map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => update({ view: v })}
                  className={cn(
                    'h-full px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    view === v ? 'bg-secondary font-medium' : 'hover:bg-card-tint',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              className="w-7 px-0"
              onClick={() => go(-1)}
              aria-label={view === 'month' ? 'Previous month' : 'Previous week'}
            >
              ‹
            </Button>
            <Button size="sm" onClick={() => selectDay(todayKey)}>
              Today
            </Button>
            <Button
              size="sm"
              className="w-7 px-0"
              onClick={() => go(1)}
              aria-label={view === 'month' ? 'Next month' : 'Next week'}
            >
              ›
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void queryClient.invalidateQueries(trpc.publishing.publications.pathFilter());
                void calendar.refetch();
              }}
              disabled={calendar.isFetching}
            >
              {calendar.isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button asChild size="sm" variant="primary">
              <a href="#schedule">Schedule</a>
            </Button>
          </>
        }
      />
      {channels.isError && (
        <RequestError
          error={channels.error}
          onRetry={() => void channels.refetch()}
          title="Channels could not be loaded"
        />
      )}
      {channels.data && (
        <ChannelStatus channels={channels.data} settingsHref={brandPath(companyId, brandId, 'settings')} />
      )}

      <section aria-label="Calendar" className="flex min-w-0 flex-col gap-3">
        {calendar.isPending && <Skeleton label="Loading calendar" lines={4} />}
        {calendar.isError && (
          <RequestError
            error={calendar.error}
            onRetry={() => void calendar.refetch()}
            title={
              toUiError(calendar.error).kind === 'forbidden'
                ? 'Restricted access: you cannot see this brand’s calendar'
                : undefined
            }
          />
        )}
        {calendar.data && (
          <>
            <CalendarGrid
              view={view}
              anchorKey={anchorKey}
              todayKey={todayKey}
              selectedKey={selectedKey}
              onSelect={selectDay}
              byDay={byDay}
              channels={channelMap}
              destinations={destinationMap}
              timeZone={timeZone}
              selectedId={selectedId}
              onOpen={openPublication}
            />
            {calendar.data.publications.length === 0 && (
              <EmptyState
                title="No publications in this period"
                description="Schedule a channel variant below; approved packages and mandates are the two authorities that release one."
              />
            )}
          </>
        )}
      </section>

      <section aria-labelledby="day-title" className="flex min-w-0 flex-col">
        <h2 id="day-title" className="om-label mb-2">
          {parseKey(selectedKey).toLocaleDateString(undefined, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: 'UTC',
          })}
        </h2>
        {dayItems.length === 0 ? (
          <p className="border-t border-border py-3 text-sm text-muted-foreground">
            Nothing scheduled on this day.
          </p>
        ) : (
          <ul className="flex flex-col" aria-label="Publications" data-testid="day-list">
            {dayItems.map((p, i) => {
              const chip = publicationChip(p.state, p.remoteStatus);
              const selected = p.publicationId === selectedId;
              const target = channelLabel(p, channelMap, destinationMap);
              return (
                <li key={p.publicationId} className="om-in" style={{ animationDelay: `${i * 30}ms` }}>
                  <button
                    type="button"
                    data-publication={p.publicationId}
                    aria-pressed={selected}
                    onClick={() => openPublication(p.publicationId)}
                    className={cn(
                      'grid w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-x-3.5 border-t border-border px-1.5 py-3 text-left text-sm',
                      'md:grid-cols-[52px_minmax(0,1fr)_minmax(0,180px)_minmax(0,170px)]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      selected ? 'bg-secondary' : 'hover:bg-muted',
                    )}
                  >
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {timeLabel(p.scheduledFor, timeZone)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate">
                        <PackageTitle contentPackageId={p.contentPackageId} />
                      </span>
                      <span className="block truncate text-xs text-muted-foreground md:hidden">
                        {target} · <code>{p.publicationId}</code>
                      </span>
                    </span>
                    <span className="hidden min-w-0 text-muted-foreground md:block">
                      <span className="block truncate">{target}</span>
                      <code className="block truncate text-2xs">{p.publicationId}</code>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <StatusDot tone={chip.tone} size="sm" />
                      {chip.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {selectedId !== null && (
        <PublicationDetail
          brandId={brandId}
          publicationId={selectedId}
          channels={channelMap}
          destinations={destinationMap}
          timeZone={timeZone}
          onClose={closePublication}
        />
      )}

      <div id="schedule" className="scroll-mt-4">
        <ScheduleForm
          companyId={companyId}
          brandId={brandId}
          timeZone={timeZone}
          channels={channelMap}
          destinations={destinationMap}
          variantId={params.get('schedule')}
          onScheduled={(publicationId, key) => {
            setAnchorKey(key);
            update({ day: key, publication: publicationId, schedule: null });
          }}
        />
      </div>
    </main>
  );
}
