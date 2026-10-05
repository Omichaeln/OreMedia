import { useMemo } from 'react';
import { Link } from 'react-router';
import { Button, StatusBanner } from '@oremedia/ui';
import { brandPath, useBrandContext } from '../../../../../../features/brand/brand-context';
import { SetupChecklist } from '../../../../../../features/brand/setup-checklist';
import { pendingProposal, useBrandVersions } from '../../../../../../features/brand/use-brand';
import { AgentActivity } from '../../../../../../features/home/agent-activity';
import { NeedsYou, useNeedsYouRows } from '../../../../../../features/home/needs-you';
import { Section } from '../../../../../../components/section';
import { WeekStrip } from '../../../../../../features/home/week-strip';
import { RecentDocuments } from '../../../../../../features/studio/documents-panel';
import { dayKey, groupByDay, rangeFor } from '../../../../../../features/publishing/publication-state';
import { useCalendarRange } from '../../../../../../features/publishing/use-publishing';
import { useSessionUser } from '../../../../../../features/session/use-session-user';
import { hasCredential } from '../../../../../../lib/session';

const greetingFor = (hour: number) =>
  hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Spec 21.2 brand home, as the supplied interface lays it out: the day in the brand's timezone, the greeting, one
 * line that counts what needs a person and what goes out today, the standards banners, then "Needs you", the week at
 * a glance, the brand's recent agent runs and its documents. All from live data; nothing is estimated.
 */
export function BrandHomeRoute() {
  const { companyId, brandId, brand } = useBrandContext();
  const user = useSessionUser(hasCredential());
  const versions = useBrandVersions(brandId);
  const proposal = pendingProposal(versions.data?.items ?? [], brand.publishedVersionId);
  const system = brandPath(companyId, brandId, 'system');
  const timeZone = brand.timezone || 'UTC';
  const now = new Date();
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
  const date = now.toLocaleDateString('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const firstName = user.data?.name.split(' ')[0];
  const needs = useNeedsYouRows();
  // The same week read the strip below makes (one query); today's publications are the ones that go out.
  const todayKey = dayKey(now, timeZone);
  const weekRange = useMemo(() => rangeFor('week', todayKey, timeZone), [todayKey, timeZone]);
  const week = useCalendarRange(brandId, weekRange.from, weekRange.to);
  const goingOut = week.data
    ? (groupByDay(week.data.publications, timeZone).get(todayKey) ?? []).filter(
        (p) => p.state !== 'cancelled',
      ).length
    : undefined;
  const summary =
    needs.rows.length === 0 && needs.settled
      ? 'Nothing needs you.'
      : needs.rows.length > 0
        ? `${plural(needs.rows.length, 'thing needs', 'things need')} you.`
        : null;
  const noBrandSystem = brand.status !== 'setup' && !brand.publishedVersionId;

  return (
    <main
      id="main"
      className="om-in mx-auto flex w-full max-w-[980px] flex-col gap-9 px-4 py-8 sm:px-10 sm:pb-20 sm:pt-11"
    >
      <header className="flex flex-col gap-1.5">
        <p className="om-eyebrow tabular-nums">
          {date} · {timeZone}
        </p>
        <h1 className="text-2xl font-bold tracking-title">
          {greetingFor(hour)}
          {firstName ? `, ${firstName}` : ''}.
        </h1>
        <p className="text-md text-muted-foreground" data-testid="attention-summary">
          {summary ?? 'Loading what needs you…'}
          {goingOut !== undefined && ` ${plural(goingOut, 'post goes', 'posts go')} out today.`}
        </p>
      </header>
      {noBrandSystem && (
        <StatusBanner
          tone="warning"
          title="Setup incomplete"
          description="No brand standards are published. Documents can’t be created until a version is published."
          actions={
            <Button asChild variant="primary">
              <Link to={system}>Open brand system</Link>
            </Button>
          }
        />
      )}
      {proposal && (
        <StatusBanner
          tone="info"
          title="Outdated standards."
          description="A proposed update is newer than the published brand system. Documents keep the published version until the update is reviewed and saved."
          actions={
            <Link
              to={system}
              className="inline-flex min-h-6 items-center text-sm font-medium hover:opacity-60"
            >
              Review update <span aria-hidden="true">→</span>
            </Link>
          }
        />
      )}
      {brand.status === 'setup' && <SetupChecklist />}
      <NeedsYou rows={needs} />
      <WeekStrip />
      <div className="grid gap-x-10 gap-y-9 md:grid-cols-2">
        <AgentActivity />
        <Section
          id="documents"
          title="Documents"
          action={
            brand.publishedVersionId ? (
              <Link to={brandPath(companyId, brandId, 'studio')} className="hover:text-foreground">
                + New document
              </Link>
            ) : (
              <span title="Save the brand system first">+ New document</span>
            )
          }
        >
          <RecentDocuments />
        </Section>
      </div>
    </main>
  );
}
