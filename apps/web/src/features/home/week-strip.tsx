import { useMemo } from 'react';
import { Link } from 'react-router';
import { Skeleton, cn, toneGlyph, toneTextClass } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { brandPath, useBrandContext } from '../brand/brand-context';
import {
  channelOutcomeSummary,
  dayKey,
  groupByDay,
  parseKey,
  rangeFor,
  weekDays,
} from '../publishing/publication-state';
import { useCalendarRange } from '../publishing/use-publishing';
import { HomeSection } from './section';

const weekday = (key: string) =>
  parseKey(key).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });

/**
 * This week at a glance: seven days of the brand's calendar in the brand's timezone. Each day says how many
 * publications it holds and names any that failed, are held or have an unknown outcome, in text with a glyph; the
 * day links to the calendar's week view with that day selected.
 */
export function WeekStrip() {
  const { companyId, brandId, brand } = useBrandContext();
  const timeZone = brand.timezone || 'UTC';
  const todayKey = dayKey(new Date(), timeZone);
  const days = weekDays(todayKey);
  const range = useMemo(() => rangeFor('week', todayKey, timeZone), [todayKey, timeZone]);
  const calendar = useCalendarRange(brandId, range.from, range.to);
  const byDay = groupByDay(calendar.data?.publications ?? [], timeZone);
  const calendarHref = brandPath(companyId, brandId, 'calendar');
  return (
    <HomeSection
      id="this-week"
      title="This week"
      action={
        <Link to={`${calendarHref}?view=week`} className="underline-offset-2 hover:underline">
          Calendar <span aria-hidden="true">→</span>
        </Link>
      }
    >
      {calendar.isError && (
        <RequestError
          error={calendar.error}
          onRetry={() => void calendar.refetch()}
          title="Calendar unavailable"
        />
      )}
      {calendar.isPending && <Skeleton label="Loading this week" lines={2} />}
      {calendar.isSuccess && (
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" data-testid="week-strip">
          {days.map((d) => {
            const pubs = byDay.get(d.key) ?? [];
            const summary = channelOutcomeSummary(pubs);
            const problems = summary.failed + summary.held + summary.unknown;
            const isToday = d.key === todayKey;
            return (
              <li key={d.key}>
                <Link
                  to={`${calendarHref}?view=week&day=${d.key}`}
                  aria-current={isToday ? 'date' : undefined}
                  className={cn(
                    'flex h-full flex-col gap-1 rounded-md border bg-background p-2.5 text-sm hover:bg-secondary',
                    isToday ? 'border-foreground' : 'border-border',
                  )}
                >
                  <span className="font-mono text-xs uppercase text-muted-foreground">{weekday(d.key)}</span>
                  <span className="text-lg font-semibold tabular-nums">{d.dayOfMonth}</span>
                  <span className="text-xs text-muted-foreground">
                    {pubs.length === 0
                      ? 'Nothing scheduled'
                      : `${pubs.length} ${pubs.length === 1 ? 'post' : 'posts'}`}
                  </span>
                  {problems > 0 && (
                    <span className={cn('text-xs', toneTextClass.critical)}>
                      <span aria-hidden="true">{toneGlyph.critical} </span>
                      {problems} need{problems === 1 ? 's' : ''} attention
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </HomeSection>
  );
}
