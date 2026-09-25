import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Badge, Button, EmptyState, Skeleton } from '@oremedia/ui';
import { RequestError } from '../../../../../../components/request-state';
import { PackageTitle } from '../../../../../../features/content/package-title';
import { brandPath, useBrandContext } from '../../../../../../features/brand/brand-context';
import { CalendarGrid } from '../../../../../../features/publishing/calendar-grid';
import { ChannelStatus } from '../../../../../../features/publishing/channel-status';
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

const periodTitle = (view: CalendarView, key: string) =>
  parseKey(key).toLocaleDateString(
    undefined,
    view === 'month'
      ? { month: 'long', year: 'numeric', timeZone: 'UTC' }
      : { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' },
  );

/**
 * Spec 21.1 calendar: scheduling and per-channel outcomes. Spec 21.2 states: token expiry (channel banners),
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

  return (
    <main id="main" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{periodTitle(view, anchorKey)}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {timeZone} · each channel is its own publication with its own outcome
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <div role="group" aria-label="View" className="flex gap-1">
            {VIEWS.map(([v, label]) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? 'secondary' : 'ghost'}
                aria-pressed={view === v}
                onClick={() => update({ view: v })}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => go(-1)}
            aria-label={view === 'month' ? 'Previous month' : 'Previous week'}
          >
            ‹
          </Button>
          <Button size="sm" variant="ghost" onClick={() => selectDay(todayKey)}>
            Today
          </Button>
          <Button
            size="sm"
            variant="ghost"
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
        </div>
      </header>
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

      <section aria-label="Calendar" className="flex flex-col gap-3">
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
            />
            {calendar.data.publications.length === 0 && (
              <EmptyState
                className="mt-3"
                title="No publications in this period"
                description="Schedule a channel variant below; approved packages and mandates are the two authorities that release one."
              />
            )}
          </>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="day-title" className="flex min-w-0 flex-col gap-2">
          <h2
            id="day-title"
            className="border-b border-border pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {parseKey(selectedKey).toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              timeZone: 'UTC',
            })}
          </h2>
          {dayItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing scheduled on this day.</p>
          ) : (
            <ul
              className="flex flex-col divide-y divide-border"
              aria-label="Publications"
              data-testid="day-list"
            >
              {dayItems.map((p) => {
                const chip = publicationChip(p.state);
                const channel = channelMap.get(p.channelConnectionId);
                const selected = p.publicationId === selectedId;
                return (
                  <li key={p.publicationId}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => update({ publication: p.publicationId })}
                      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-2 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected ? 'bg-secondary' : 'hover:bg-muted'}`}
                    >
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {new Date(p.scheduledFor).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                          timeZone,
                        })}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          <PackageTitle contentPackageId={p.contentPackageId} />
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {channel
                            ? `${channel.displayName} (${channel.providerKey})`
                            : p.channelConnectionId}
                          {' · '}
                          <code>{p.publicationId}</code>
                        </span>
                      </span>
                      <Badge tone={chip.tone}>{chip.label}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <PublicationDetail brandId={brandId} publicationId={selectedId} channels={channelMap} />
      </div>

      <div id="schedule" className="scroll-mt-4">
        <ScheduleForm
          timeZone={timeZone}
          channels={channelMap}
          onScheduled={(publicationId, key) => {
            setAnchorKey(key);
            update({ day: key, publication: publicationId });
          }}
        />
      </div>
    </main>
  );
}
