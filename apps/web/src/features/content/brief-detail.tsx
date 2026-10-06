import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Field,
  Input,
  Skeleton,
  StatusBanner,
  StatusDot,
  Textarea,
  toneGlyph,
} from '@oremedia/ui';
import { Drawer, DrawerContent } from '../../components/drawer';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { ContentWriteError } from './campaign-actions';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { brandPath } from '../brand/brand-context';
import { useFacts } from '../brand/use-brand';
import { StartRunForm } from '../agents/start-run-form';
import type { BriefValues } from '../agents/schema-fields';
import { destinationLabel, type DestinationDto } from '../destinations/use-destinations';
import { dayKey } from '../publishing/publication-state';
import type { ChannelDto } from '../publishing/use-publishing';
import {
  briefChip,
  briefGaps,
  isSuggested,
  packageChip,
  revisionChip,
  variantFindings,
  variantStatusText,
} from './content-helpers';
import { ArticleEditor, emptyArticleDraft, parseArticleDraft } from './article-editor';
import { DocumentPicker } from './document-picker';
import { PlanGrid } from './plan-grid';
import { RequestReview } from './request-review';
import {
  useBrief,
  usePackage,
  usePlanItems,
  type BriefDto,
  type PackageSummaryDto,
  type PackagesQuery,
} from './use-content';

export interface BriefDetailProps {
  companyId: string;
  brandId: string;
  briefId: string;
  channels: ReadonlyMap<string, ChannelDto>;
  /** R2-3: the brand's websites, named on the variant lines beside the channels. */
  destinations: ReadonlyMap<string, DestinationDto>;
  /** The brand's packages, newest first and paged; this brief's are the ones pointing at it. */
  packages: PackagesQuery;
  selectedPackageId: string | null;
  onSelectPackage: (contentPackageId: string) => void;
  /** Where a run started from "Plan with agent" is followed (the brand's agents screen). */
  brandName: string;
  /** The brand's zone: the planning window is prefilled in brand-zone dates. */
  timeZone: string;
  agentRunHref: (runId: string) => string;
}

/** The campaign_planning brief prefilled from the brief being planned (UX-09); a person edits it before starting. */
function planningValues(
  b: BriefDto,
  channels: ReadonlyMap<string, ChannelDto>,
  timeZone: string,
): Record<string, string> {
  const today = new Date();
  const end = new Date(today.getTime() + 28 * 86_400_000);
  return {
    briefId: b.id,
    objective: b.message,
    audience: b.audience,
    offerFactIds: b.offerFactIds.join(', '),
    startDate: dayKey(today, timeZone),
    endDate: dayKey(end, timeZone),
    channels: [...new Set(b.channelConnectionIds.map((id) => channels.get(id)?.providerKey ?? id))].join(
      ', ',
    ),
    notes: b.constraints.join('\n'),
  };
}

/**
 * The copywriting brief prefilled from this brief ("Draft variants with agent"): the message as objective and
 * key message, the audience, the first planned channel; the person completes the rest before starting the run.
 */
function copywritingValues(b: BriefDto, channels: ReadonlyMap<string, ChannelDto>): BriefValues {
  const first = b.channelConnectionIds[0];
  return {
    briefId: b.id,
    brief: {
      objective: b.message,
      audience: b.audience,
      keyMessages: b.message,
      channelKey: first ? (channels.get(first)?.providerKey ?? first) : '',
      contentType: 'social_post',
    },
    variantCount: '3',
  };
}

/** A brief's offer facts by their statements (never ids), each marked when it no longer applies. */
function OfferFacts({ brandId, factIds }: { brandId: string; factIds: string[] }) {
  const facts = useFacts(brandId, { ids: factIds });
  if (facts.isPending) return <span className="text-muted-foreground">Loading…</span>;
  if (facts.isError)
    return <span className="text-muted-foreground">The offer facts could not be loaded</span>;
  const byId = new Map(facts.data.items.map((f) => [f.id, f]));
  return (
    <ul className="flex flex-col gap-0.5" data-testid="brief-offer-facts">
      {factIds.map((id) => {
        const f = byId.get(id);
        return (
          <li key={id} className="break-words">
            {f ? f.statement : 'A fact that is no longer listed'}
            {f && !f.effective && (
              <Badge tone="warning" className="ml-1.5">
                No longer in effect
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const PACKAGE_KIND_OPTIONS = [
  { value: 'text', label: 'Social post (master copy)' },
  { value: 'article', label: 'Website article' },
];

function CreatePackageForm({
  brandId,
  briefId,
  onCreated,
}: {
  brandId: string;
  briefId: string;
  onCreated: (contentPackageId: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const intent = useIntentKey();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  // R2-3: a package is a social post (master copy) or a website article (a structured document).
  const [kind, setKind] = useState<'text' | 'article'>('text');
  const [draft, setDraft] = useState(emptyArticleDraft);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const create = useMutation(
    trpc.content.packages.create.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        setTitle('');
        setText('');
        setDraft(emptyArticleDraft());
        setSelected([]);
        void queryClient.invalidateQueries(trpc.content.pathFilter());
        onCreated(res.contentPackageId);
      },
    }),
  );
  const toggle = (id: string) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (kind === 'article') {
      const parsed = parseArticleDraft(draft);
      if (!parsed.ok) {
        setIssues(parsed.issues);
        return;
      }
      setIssues({});
      create.mutate({
        brandId,
        briefId,
        title: title.trim(),
        copy: {
          schemaVersion: 1,
          master: { text: parsed.article.excerpt || parsed.article.title, factRefs: [] },
          article: parsed.article,
        },
        creativeDocumentIds: selected,
      });
      return;
    }
    create.mutate({
      brandId,
      briefId,
      title: title.trim(),
      copy: { schemaVersion: 1, master: { text, factRefs: [] } },
      creativeDocumentIds: selected,
    });
  };
  const ui = create.isError ? toUiError(create.error) : null;
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t border-border pt-3" noValidate>
      <p className="text-sm font-medium">New package</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_14rem]">
        <Field label="Package title" htmlFor="pkg-title">
          <Input
            id="pkg-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
          />
        </Field>
        <Field label="Package type" htmlFor="pkg-kind">
          <Select
            id="pkg-kind"
            value={kind}
            onValueChange={(v) => setKind(v === 'article' ? 'article' : 'text')}
            options={PACKAGE_KIND_OPTIONS}
          />
        </Field>
      </div>
      {kind === 'article' ? (
        <ArticleEditor
          brandId={brandId}
          draft={draft}
          onChange={setDraft}
          idPrefix="pkg-article"
          issues={issues}
        />
      ) : (
        <Field label="Master copy" htmlFor="pkg-copy">
          <Textarea id="pkg-copy" value={text} onChange={(e) => setText(e.target.value)} rows={3} />
        </Field>
      )}
      <DocumentPicker
        brandId={brandId}
        pinned={[]}
        selected={selected}
        onToggle={toggle}
        legend="Creative documents (revision 1 pins their current revisions)"
      />
      {ui && ui.kind === 'forbidden' && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${ui.message} Creating a package needs content.edit.`}
        />
      )}
      {ui && ui.kind !== 'forbidden' && (
        <ContentWriteError error={create.error} title="The package was not created" />
      )}
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending || !title.trim()}
          disabledReason={title.trim() ? undefined : 'Give the package a title'}
        >
          {create.isPending ? 'Creating…' : 'Create package'}
        </Button>
      </div>
    </form>
  );
}

/**
 * One content package of the brief, as the interface lists them: the title with "rev N · state" at the right,
 * then one line per channel or website variant with its validity. The list carries only the package, so the
 * revision and its variants are read per package (the same read the package detail makes, shared by the cache).
 */
function PackageRow({
  pkg,
  selected,
  onSelect,
  channels,
  destinations,
}: {
  pkg: PackageSummaryDto;
  selected: boolean;
  onSelect: () => void;
  channels: ReadonlyMap<string, ChannelDto>;
  destinations: ReadonlyMap<string, DestinationDto>;
}) {
  const detail = usePackage(pkg.id);
  const p = detail.data;
  return (
    <li className="flex flex-col gap-2 border-t border-border py-3">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        data-testid={`package-${pkg.id}`}
        className="flex items-start justify-between gap-3 rounded-sm text-left text-base hover:text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className={selected ? 'font-bold' : 'font-medium'}>{pkg.title}</span>
        <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
          {p
            ? `rev ${p.revision.number} · ${revisionChip(p.revision.state).label}`
            : packageChip(pkg.state).label}
        </span>
      </button>
      {detail.isPending && <Skeleton label={`Loading the variants of ${pkg.title}`} lines={1} />}
      {detail.isError && (
        <span className="text-xs text-muted-foreground">The variants could not be read.</span>
      )}
      {p && p.variants.length === 0 && (
        <span className="text-xs text-muted-foreground">No variants yet.</span>
      )}
      {p &&
        p.variants.map((v) => {
          const findings = variantFindings(v.validation);
          const tone = findings.ok ? 'good' : 'warning';
          const channel = v.channelConnectionId ? channels.get(v.channelConnectionId) : undefined;
          const label = v.destinationId
            ? destinationLabel(destinations.get(v.destinationId), v.destinationId)
            : (channel?.displayName ?? v.channelConnectionId ?? v.id);
          return (
            <span key={v.id} className="flex items-center gap-2 pl-0.5 text-xs text-muted-foreground">
              <StatusDot tone={tone} size="sm" />
              <span className="sr-only">{toneGlyph[tone]} </span>
              <span>
                {label} — {variantStatusText(findings)}
              </span>
            </span>
          );
        })}
    </li>
  );
}

/**
 * Spec 21.2 campaign planner, laid out as the interface's brief document: the eyebrow "BRIEF · state", the message
 * as the title, the incomplete note, Audience / Channels / Constraints, the plan, the content packages with their
 * variants, and the three actions (open in studio, draft variants with agent, send the package for review).
 * States: incomplete brief, suggested plan awaiting acceptance, accepted plan, and its packages.
 */
export function BriefDetail({
  companyId,
  brandId,
  briefId,
  channels,
  destinations,
  packages,
  selectedPackageId,
  onSelectPackage,
  brandName,
  timeZone,
  agentRunHref,
}: BriefDetailProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const brief = useBrief(briefId);
  const plan = usePlanItems(briefId);
  const selectedPackage = usePackage(selectedPackageId);
  const [planning, setPlanning] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const intent = useIntentKey();
  const accept = useMutation(
    trpc.content.briefs.accept.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        void queryClient.invalidateQueries(trpc.content.pathFilter());
      },
    }),
  );
  const b = brief.data;
  const acceptUi = accept.isError ? toUiError(accept.error) : null;
  const mine = packages.items.filter((p) => p.briefId === briefId);
  const chip = b ? briefChip(b.state) : null;
  const gaps = b ? briefGaps(b) : [];
  const proposedCount = plan.data?.items.filter((i) => i.state === 'proposed').length ?? 0;
  const pkg = selectedPackage.data;
  const studioDocument = pkg?.creativeDocuments[0];
  const reviewable = pkg && (pkg.revision.state === 'draft' || pkg.revision.state === 'changes_requested');

  return (
    <section aria-labelledby="brief-title" className="flex flex-col gap-7" data-testid="brief-detail">
      {brief.isPending && <Skeleton label="Loading brief" />}
      {brief.isError && (
        <RequestError
          error={brief.error}
          onRetry={() => void brief.refetch()}
          title={toUiError(brief.error).kind === 'forbidden' ? 'Permission denied' : undefined}
        />
      )}
      {b && chip && (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-xs uppercase tabular-nums text-muted-foreground">
              Brief · <span data-testid="brief-state">{chip.label}</span>
              {isSuggested(b) && ' · Suggested plan'}
              {gaps.length > 0 && ' · Incomplete'}
            </p>
            <h2
              id="brief-title"
              className="text-balance break-words text-xl font-bold leading-[1.25] tracking-[-0.01em]"
            >
              {b.message || b.audience || b.id}
            </h2>
          </div>
          {gaps.length > 0 && (
            <div
              role="status"
              className="rounded-lg bg-accent-tint px-3.5 py-2.5 text-sm"
              data-testid="brief-incomplete"
            >
              Incomplete brief. Missing: {gaps.join(', ')}. A plan produced from it will have to guess these.
            </div>
          )}
          <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Audience</dt>
            <dd className="break-words">{b.audience || '—'}</dd>
            <dt className="text-muted-foreground">Channels</dt>
            <dd>
              {b.channelConnectionIds.length
                ? b.channelConnectionIds
                    .map((id) => {
                      const c = channels.get(id);
                      return c ? `${c.displayName} (${c.providerKey})` : id;
                    })
                    .join(', ')
                : '—'}
            </dd>
            {b.offerFactIds.length > 0 && (
              <>
                <dt className="text-muted-foreground">Offer facts</dt>
                <dd>
                  <OfferFacts brandId={brandId} factIds={b.offerFactIds} />
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Constraints</dt>
            <dd className="break-words">{b.constraints.length ? b.constraints.join(' · ') : '—'}</dd>
            {b.recommendationId && (
              <>
                <dt className="text-muted-foreground">From</dt>
                <dd>
                  Recommendation <code className="text-xs">{b.recommendationId}</code>
                </dd>
              </>
            )}
          </dl>
          {b.state === 'draft' && (
            <StatusBanner
              tone="warning"
              title="Awaiting acceptance"
              description={`${chip.detail ?? ''}${isSuggested(b) ? ' This plan was suggested, not written by a person.' : ''}${proposedCount > 0 ? ` Accepting creates ${proposedCount} draft package${proposedCount === 1 ? '' : 's'} from the plan below.` : ''}`}
              actions={
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => accept.mutate({ briefId: b.id, expectedVersion: b.version })}
                  disabled={accept.isPending}
                >
                  {accept.isPending ? 'Accepting…' : 'Accept brief'}
                </Button>
              }
              data-testid="brief-awaiting"
            />
          )}
          {acceptUi && acceptUi.kind === 'forbidden' && (
            <StatusBanner
              tone="critical"
              title="Permission denied"
              description={`${acceptUi.message} Accepting a brief needs content.plan for this brand.`}
              data-testid="brief-denied"
            />
          )}
          {acceptUi && acceptUi.kind !== 'forbidden' && (
            <ContentWriteError error={accept.error} title="The brief was not accepted" />
          )}
          <PlanGrid
            brief={b}
            channels={channels}
            onSelectPackage={onSelectPackage}
            onPlanWithAgent={() => setPlanning(true)}
          />
          <Drawer open={planning} onOpenChange={setPlanning}>
            <DrawerContent
              title="Plan with agent"
              side="right"
              className="w-[min(92vw,34rem)] overflow-y-auto p-5"
            >
              {planning && (
                <StartRunForm
                  brandId={brandId}
                  brandName={brandName}
                  hrefFor={agentRunHref}
                  initial={{ taskKind: 'campaign_planning', values: planningValues(b, channels, timeZone) }}
                />
              )}
            </DrawerContent>
          </Drawer>
          <section aria-labelledby="brief-packages" className="flex flex-col">
            <h3 id="brief-packages" className="om-label mb-2">
              Content packages
            </h3>
            {packages.isPending && <Skeleton label="Loading packages" lines={2} />}
            {packages.isSuccess && mine.length === 0 && (
              <p className="border-t border-border py-2.5 text-sm text-muted-foreground" role="status">
                No packages yet.{' '}
                {b.state === 'draft'
                  ? 'Accept the brief to create them from its plan.'
                  : b.state === 'cancelled'
                    ? 'The brief is cancelled.'
                    : 'Create the first one below.'}
              </p>
            )}
            {mine.length > 0 && (
              <ul className="flex flex-col" aria-label="Content packages">
                {mine.map((p) => (
                  <PackageRow
                    key={p.id}
                    pkg={p}
                    selected={p.id === selectedPackageId}
                    onSelect={() => onSelectPackage(p.id)}
                    channels={channels}
                    destinations={destinations}
                  />
                ))}
              </ul>
            )}
            <LoadMore
              shown={packages.items.length}
              hasNextPage={packages.hasNextPage}
              isFetchingNextPage={packages.isFetchingNextPage}
              onLoadMore={() => void packages.fetchNextPage()}
              noun="brand packages"
              className="py-2"
            />
            {b.state !== 'draft' && b.state !== 'cancelled' && (
              <CreatePackageForm brandId={brandId} briefId={b.id} onCreated={onSelectPackage} />
            )}
          </section>
          <div className="flex flex-wrap gap-2" data-testid="brief-actions">
            {studioDocument ? (
              <Button asChild variant="primary">
                <Link
                  to={brandPath(
                    companyId,
                    brandId,
                    `studio/${encodeURIComponent(studioDocument.documentId)}`,
                  )}
                >
                  Open in studio
                </Link>
              </Button>
            ) : pkg ? (
              <Button asChild variant="primary">
                <Link
                  to={brandPath(companyId, brandId, 'studio')}
                  title="No document is pinned yet: the studio opens on its creation screen"
                >
                  Open in studio
                </Link>
              </Button>
            ) : (
              <Button
                variant="primary"
                disabledReason={
                  !selectedPackageId
                    ? 'Choose a content package first'
                    : selectedPackage.isError
                      ? 'The package could not be read'
                      : 'The package is still loading'
                }
              >
                Open in studio
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => setDrafting(true)}
              disabledReason={b.state === 'cancelled' ? 'The brief is cancelled' : undefined}
            >
              Draft variants with agent
            </Button>
            <Button
              variant="secondary"
              onClick={() => setSending(true)}
              disabledReason={
                !selectedPackageId
                  ? 'Choose a content package first'
                  : !pkg
                    ? selectedPackage.isError
                      ? 'The package could not be read'
                      : 'The package is still loading'
                    : !reviewable
                      ? `Revision ${pkg.revision.number} is ${revisionChip(pkg.revision.state).label.toLowerCase()}; only a draft revision can be sent for review`
                      : undefined
              }
            >
              Send package for review
            </Button>
          </div>
          <Drawer open={drafting} onOpenChange={setDrafting}>
            <DrawerContent
              title="Draft variants with agent"
              side="right"
              className="w-[min(92vw,34rem)] overflow-y-auto p-5"
            >
              {drafting && (
                <StartRunForm
                  brandId={brandId}
                  brandName={brandName}
                  hrefFor={agentRunHref}
                  initial={{ taskKind: 'copywriting', values: copywritingValues(b, channels) }}
                />
              )}
            </DrawerContent>
          </Drawer>
          <Drawer open={sending} onOpenChange={setSending}>
            <DrawerContent
              title="Send package for review"
              side="right"
              className="w-[min(92vw,30rem)] overflow-y-auto p-5"
            >
              {sending && pkg && reviewable && (
                <div className="flex flex-col gap-3">
                  <p className="text-lg font-bold">Send {pkg.title} for review</p>
                  <p className="text-sm text-muted-foreground">
                    Revision {pkg.revision.number} and its {pkg.variants.length} variant
                    {pkg.variants.length === 1 ? '' : 's'} are frozen into the review manifest.
                  </p>
                  <RequestReview
                    key={pkg.revision.id}
                    companyId={companyId}
                    brandId={brandId}
                    timeZone={timeZone}
                    contentPackageId={pkg.id}
                    revision={pkg.revision}
                    variantCount={pkg.variants.length}
                  />
                </div>
              )}
            </DrawerContent>
          </Drawer>
        </>
      )}
    </section>
  );
}
