import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { Button, Field, Input, StatusBanner } from '@oremedia/ui';
import { brandPath, useBrandContext } from '../../../../../../features/brand/brand-context';
import { useBrandVersions } from '../../../../../../features/brand/use-brand';
import { AgentActivity } from '../../../../../../features/home/agent-activity';
import { NeedsYou } from '../../../../../../features/home/needs-you';
import { Section } from '../../../../../../components/section';
import { WeekStrip } from '../../../../../../features/home/week-strip';
import { useSessionUser } from '../../../../../../features/session/use-session-user';
import { hasCredential } from '../../../../../../lib/session';
import { readRecentDocuments, rememberDocument } from '../../../../../../lib/recent-documents';
import { useTRPC } from '../../../../../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../../../../../lib/intent-key';
import { toUiError } from '../../../../../../lib/errors';

const greetingFor = (hour: number) =>
  hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

/**
 * Spec 21.2 brand home: the day in the brand's timezone, the standards banners, then one list of what needs a
 * person, the week at a glance, recent agent runs and documents. All from live data; nothing is estimated.
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
      {(brand.status === 'setup' || !brand.publishedVersionId || newerDraft) && (
        <div className="flex flex-col gap-2">
          {(brand.status === 'setup' || !brand.publishedVersionId) && (
            <StatusBanner
              tone="warning"
              title="Setup incomplete"
              description={
                brand.publishedVersionId
                  ? 'The brand is still marked as in setup.'
                  : 'No brand standards have been published. Documents cannot be created until a brand version is published.'
              }
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
      <NeedsYou />
      <WeekStrip />
      <div className="grid gap-8 md:grid-cols-2">
        <AgentActivity />
        <Section id="documents" title="Documents">
          <RecentDocuments />
          <NewDocument
            disabledReason={brand.publishedVersionId ? undefined : 'Publish brand standards first'}
          />
        </Section>
      </div>
    </main>
  );
}

function NewDocument({ disabledReason }: { disabledReason?: string }) {
  const { companyId, brandId } = useBrandContext();
  const trpc = useTRPC();
  const navigate = useNavigate();
  const intent = useIntentKey();
  const [title, setTitle] = useState('');
  const [openId, setOpenId] = useState('');
  const create = useMutation(
    trpc.creative.documents.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        rememberDocument({ companyId, brandId, documentId: res.documentId, title: title.trim() });
        navigate(brandPath(companyId, brandId, `studio/${encodeURIComponent(res.documentId)}`));
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) create.mutate({ brandId, title: title.trim() });
  };
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Field
          label="New document title"
          htmlFor="doc-title"
          error={create.isError ? toUiError(create.error).message : undefined}
        >
          <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || !title.trim()}
            disabledReason={disabledReason}
          >
            {create.isPending ? 'Creating…' : 'Create and open'}
          </Button>
        </div>
      </form>
      <form
        className="mt-4 flex items-end gap-2 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (openId.trim())
            navigate(brandPath(companyId, brandId, `studio/${encodeURIComponent(openId.trim())}`));
        }}
      >
        <Field label="Open a document by id" htmlFor="doc-id" className="flex-1" hint="doc_…">
          <Input id="doc-id" value={openId} onChange={(e) => setOpenId(e.target.value)} />
        </Field>
        <Button type="submit" disabled={!openId.trim()}>
          Open
        </Button>
      </form>
    </div>
  );
}

function RecentDocuments() {
  const { companyId, brandId } = useBrandContext();
  const recent = readRecentDocuments(companyId, brandId);
  if (recent.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No documents opened on this device yet. The list is per browser; campaigns hold every package.
      </p>
    );
  return (
    <ul className="flex flex-col divide-y divide-border" aria-label="Recently opened on this device">
      {recent.map((d) => (
        <li key={d.documentId} className="flex items-center justify-between gap-2 py-2.5">
          <Link
            to={brandPath(companyId, brandId, `studio/${encodeURIComponent(d.documentId)}`)}
            className="min-w-0 truncate text-sm font-medium underline-offset-2 hover:underline"
          >
            {d.title || d.documentId}
          </Link>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {new Date(d.openedAt).toLocaleDateString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
