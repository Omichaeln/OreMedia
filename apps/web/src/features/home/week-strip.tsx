import { useMemo } from 'react';
import { Link } from 'react-router';
import { Skeleton, StatusDot, cn, type Tone } from '@oremedia/ui';
import { RequestError } from '../../components/request-state';
import { brandPath, useBrandContext } from '../brand/brand-context';
import {
  PUBLICATION_CHIP,
  channelOutcomeSummary,
  dayKey,
  groupByDay,
  parseKey,
  rangeFor,
  weekDays,
  type PublicationStateT,
} from '../publishing/publication-state';
import { useCalendarRange } from '../publishing/use-publishing';
import { Section } from '../../components/section';

const weekday = (key: string) =>
  parseKey(key).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).toUpperCase();

const MAX_DOTS = 6;
const toneOf = (state: string): Tone => PUBLICATION_CHIP[state as PublicationStateT]?.tone ?? 'neutral';

/**
 * This week at a glance, as the interface draws it: seven cards, one per day of the brand's week in its timezone,
 * each with a dot per publication in the state's colour; the count and any that need a person are also said in
 * text, so nothing rests on colour. A day links to the calendar's week view with that day selected.
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
    <Section
      id="this-week"
      title="This week"
      action={
        <Link to={`${calendarHref}?view=week`} className="hover:text-foreground">
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
        <ol className="grid grid-cols-4 gap-1.5 sm:grid-cols-7" data-testid="week-strip">
          {days.map((d, i) => {
            const pubs = byDay.get(d.key) ?? [];
            const summary = channelOutcomeSummary(pubs);
            const problems = summary.failed + summary.held + summary.unknown;
            const isToday = d.key === todayKey;
            const spoken =
              pubs.length === 0
                ? 'Nothing scheduled'
                : `${pubs.length} ${pubs.length === 1 ? 'post' : 'posts'}${
                    problems > 0 ? `, ${problems} need${problems === 1 ? 's' : ''} attention` : ''
                  }`;
            return (
              <li key={d.key} className="om-in" style={{ animationDelay: `${i * 30}ms` }}>
                <Link
                  to={`${calendarHref}?view=week&day=${d.key}`}
                  aria-current={isToday ? 'date' : undefined}
                  className={cn(
                    'flex h-full min-h-[84px] flex-col items-start gap-2 rounded-lg border bg-card p-2.5 transition-colors hover:border-border-strong',
                    isToday ? 'border-foreground' : 'border-border',
                  )}
                >
                  <span className="text-2xs tabular-nums text-muted-foreground">{weekday(d.key)}</span>
                  <span className="text-lg font-bold tabular-nums">{d.dayOfMonth}</span>
                  <span className="flex flex-wrap gap-[3px]">
                    {pubs.slice(0, MAX_DOTS).map((p) => (
                      <StatusDot key={p.publicationId} tone={toneOf(p.state)} size="sm" />
                    ))}
                    {pubs.length > MAX_DOTS && (
                      <span aria-hidden="true" className="text-2xs leading-[6px] text-muted-foreground">
                        +{pubs.length - MAX_DOTS}
                      </span>
                    )}
                    <span className="sr-only">{spoken}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
