import { Link } from 'react-router';
import { Button, StatusBanner } from '@oremedia/ui';
import { brandPath, useBrandContext } from '../../../../../../features/brand/brand-context';
import { SetupChecklist } from '../../../../../../features/brand/setup-checklist';
import { useBrandVersions } from '../../../../../../features/brand/use-brand';
import { AgentActivity } from '../../../../../../features/home/agent-activity';
import { NeedsYou } from '../../../../../../features/home/needs-you';
import { Section } from '../../../../../../components/section';
import { WeekStrip } from '../../../../../../features/home/week-strip';
import { Documents, NewDocument } from '../../../../../../features/studio/documents-panel';
import { useSessionUser } from '../../../../../../features/session/use-session-user';
import { hasCredential } from '../../../../../../lib/session';

const greetingFor = (hour: number) =>
  hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

/**
 * Spec 21.2 brand home: the day in the brand's timezone, the standards banners, then one list of what needs a
 * person, the week at a glance, the brand's recent agent runs and its documents. All from live data; nothing is
 * estimated.
 */
export function BrandHomeRoute() {
  const { companyId, brandId, brand } = useBrandContext();
  const user = useSessionUser(hasCredential());
  const versions = useBrandVersions(brandId);
  const published = versions.data?.items.find((v) => v.id === brand.publishedVersionId) ?? null;
  const newerDraft =
    published && versions.data
      ? versions.data.items.find((v) => v.number > published.number && v.state !== 'retired')
      : null;
  const system = brandPath(companyId, brandId, 'system');
  const timeZone = brand.timezone || 'UTC';
  const now = new Date();
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
  const date = now.toLocaleDateString(undefined, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const firstName = user.data?.name.split(' ')[0];

  return (
    <main id="main" className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 sm:px-8 sm:py-10">
      <header>
        <p className="font-mono text-xs uppercase text-muted-foreground">
          {date} · {timeZone}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">
          {greetingFor(hour)}
          {firstName ? `, ${firstName}` : ''}.
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {brand.name}: what needs you, and where to start.
        </p>
      </header>
      {((brand.status !== 'setup' && !brand.publishedVersionId) || newerDraft) && (
        <div className="flex flex-col gap-2">
          {brand.status !== 'setup' && !brand.publishedVersionId && (
            <StatusBanner
              tone="warning"
              title="No published standards"
              description="No brand standards have been published. Documents cannot be created until a brand version is published."
              actions={
                <Button asChild size="sm">
                  <Link to={system}>Open brand system</Link>
                </Button>
              }
            />
          )}
          {newerDraft && (
            <StatusBanner
              tone="info"
              title="Outdated standards"
              description={`Version ${newerDraft.number} (${newerDraft.state === 'in_review' ? 'in review' : 'proposed'}) is newer than the published version ${published?.number}. Documents keep the published version until the new one is published.`}
              actions={
                <Button asChild size="sm">
                  <Link to={`${system}?section=versions`}>Review</Link>
                </Button>
              }
            />
          )}
        </div>
      )}
      {brand.status === 'setup' && <SetupChecklist />}
      <NeedsYou />
      <WeekStrip />
      <div className="grid gap-8 md:grid-cols-2">
        <AgentActivity />
        <Section id="documents" title="Documents">
          <Documents />
          <NewDocument
            disabledReason={brand.publishedVersionId ? undefined : 'Publish brand standards first'}
          />
        </Section>
      </div>
    </main>
  );
}
