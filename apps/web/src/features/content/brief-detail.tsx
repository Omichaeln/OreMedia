import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  Skeleton,
  StatusBanner,
  Textarea,
} from '@oremedia/ui';
import { Drawer, DrawerContent } from '../../components/drawer';
import { LoadMore } from '../../components/load-more';
import { RequestError } from '../../components/request-state';
import { ContentWriteError } from './campaign-actions';
import { Select } from '../../components/select';
import { toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { useFacts } from '../brand/use-brand';
import { StartRunForm } from '../agents/start-run-form';
import { dayKey } from '../publishing/publication-state';
import type { ChannelDto } from '../publishing/use-publishing';
import { briefChip, briefGaps, isSuggested, packageChip } from './content-helpers';
import { ArticleEditor, emptyArticleDraft, parseArticleDraft } from './article-editor';
import { DocumentPicker } from './document-picker';
import { PlanGrid } from './plan-grid';
import { useBrief, usePlanItems, type BriefDto, type PackagesQuery } from './use-content';

export interface BriefDetailProps {
  brandId: string;
  briefId: string;
  channels: ReadonlyMap<string, ChannelDto>;
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
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border pt-3" noValidate>
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
          size="sm"
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

/** Spec 21.2 campaign planner: incomplete brief, suggested plan awaiting acceptance, accepted plan, and its packages. */
export function BriefDetail({
  brandId,
  briefId,
  channels,
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
  const [planning, setPlanning] = useState(false);
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

  return (
    <Panel title="Brief" data-testid="brief-detail">
      {brief.isPending && <Skeleton label="Loading brief" />}
      {brief.isError && (
        <RequestError
          error={brief.error}
          onRetry={() => void brief.refetch()}
          title={toUiError(brief.error).kind === 'forbidden' ? 'Permission denied' : undefined}
        />
      )}
      {b && chip && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={chip.tone} data-testid="brief-state">
              {chip.label}
            </Badge>
            {isSuggested(b) && (
              <Badge tone="info" glyph={false}>
                Suggested plan
              </Badge>
            )}
            {gaps.length > 0 && <Badge tone="warning">Incomplete</Badge>}
            <code className="text-xs text-muted-foreground">{b.id}</code>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Audience</dt>
            <dd>{b.audience || 'not set'}</dd>
            <dt className="text-muted-foreground">Message</dt>
            <dd className="whitespace-pre-wrap break-words">{b.message || 'not set'}</dd>
            <dt className="text-muted-foreground">Channels</dt>
            <dd>
              {b.channelConnectionIds.length
                ? b.channelConnectionIds
                    .map((id) => {
                      const c = channels.get(id);
                      return c ? `${c.displayName} (${c.providerKey})` : id;
                    })
                    .join(', ')
                : 'none planned'}
            </dd>
            <dt className="text-muted-foreground">Offer facts</dt>
            <dd>
              {b.offerFactIds.length ? <OfferFacts brandId={brandId} factIds={b.offerFactIds} /> : 'none'}
            </dd>
            <dt className="text-muted-foreground">Constraints</dt>
            <dd>{b.constraints.length ? b.constraints.join('; ') : 'none'}</dd>
            {b.recommendationId && (
              <>
                <dt className="text-muted-foreground">From recommendation</dt>
                <dd>
                  <code>{b.recommendationId}</code>
                </dd>
              </>
            )}
          </dl>
          {gaps.length > 0 && (
            <StatusBanner
              tone="warning"
              title="Incomplete brief"
              description={`Missing: ${gaps.join(', ')}. A plan produced from it will have to guess these.`}
              data-testid="brief-incomplete"
            />
          )}
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
          <section aria-labelledby="brief-packages" className="flex flex-col gap-2">
            <h3 id="brief-packages" className="text-sm font-semibold">
              Content packages
            </h3>
            {packages.isPending && <Skeleton label="Loading packages" lines={2} />}
            {packages.isSuccess && mine.length === 0 ? (
              <EmptyState
                title="No packages for this brief"
                description={
                  b.state === 'draft'
                    ? 'Accept the brief, then create its first content package.'
                    : 'Create the first content package below.'
                }
              />
            ) : (
              <ul className="flex flex-col gap-1" aria-label="Content packages">
                {mine.map((p) => {
                  const pc = packageChip(p.state);
                  const selected = p.id === selectedPackageId;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelectPackage(p.id)}
                        data-testid={`package-${p.id}`}
                        className={`flex w-full flex-wrap items-center gap-2 rounded-md border p-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-accent bg-secondary' : 'border-border hover:bg-muted'}`}
                      >
                        <span className="font-medium">{p.title}</span>
                        <Badge tone={pc.tone}>{pc.label}</Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <LoadMore
              shown={packages.items.length}
              hasNextPage={packages.hasNextPage}
              isFetchingNextPage={packages.isFetchingNextPage}
              onLoadMore={() => void packages.fetchNextPage()}
              noun="brand packages"
              className="px-0"
            />
            {b.state !== 'draft' && b.state !== 'cancelled' && (
              <CreatePackageForm brandId={brandId} briefId={b.id} onCreated={onSelectPackage} />
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}
