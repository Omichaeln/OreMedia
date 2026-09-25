import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FactKind, type FactState } from '@oremedia/contracts/brand';
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
  cn,
  type Tone,
} from '@oremedia/ui';
import { RequestError } from '../../../../../../components/request-state';
import { Select } from '../../../../../../components/select';
import { useToast } from '../../../../../../components/toast';
import { useBrandContext } from '../../../../../../features/brand/brand-context';
import { BrandKitEditor, type KitSection } from '../../../../../../features/brand/brand-kit-editor';
import {
  ChannelsView,
  ColourView,
  GuidelinesView,
  ImageryView,
  LogoView,
  OverviewView,
  PatternsView,
  TypographyView,
  VoiceView,
} from '../../../../../../features/brand/brand-read-views';
import { BrandSkillImport } from '../../../../../../features/brand/brand-skill-import';
import {
  useBrandVersion,
  useBrandVersions,
  useFacts,
  useObjectives,
  versionStateLabel,
  type BrandVersionDto,
  type BrandVersionSummary,
} from '../../../../../../features/brand/use-brand';
import { useTRPC } from '../../../../../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../../../../../lib/intent-key';
import { toUiError, type UiError } from '../../../../../../lib/errors';

const VERSION_TONE: Record<BrandVersionSummary['state'], Tone> = {
  draft: 'info',
  in_review: 'warning',
  published: 'good',
  retired: 'neutral',
};

type SectionKey =
  | 'overview'
  | 'logo'
  | 'colour'
  | 'typography'
  | 'voice'
  | 'imagery'
  | 'patterns'
  | 'channels'
  | 'guidelines'
  | 'facts'
  | 'objectives'
  | 'versions';

/** The system's parts in the order the prototype reads them; each lives at `?section=`. */
const SECTIONS: Array<{ key: SectionKey; label: string; description: string; kit?: KitSection }> = [
  {
    key: 'overview',
    label: 'Overview',
    description: 'The brand at a glance: voice, palette and what each part holds.',
  },
  {
    key: 'logo',
    label: 'Logo',
    description: 'Variants with their grounds, clear space and minimum width.',
    kit: 'logos',
  },
  {
    key: 'colour',
    label: 'Colour',
    description: 'Tokens by role, and every text pairing against the contrast target.',
    kit: 'palette',
  },
  {
    key: 'typography',
    label: 'Typography & layout',
    description: 'Type roles bound to font files, spacing and radii.',
  },
  {
    key: 'voice',
    label: 'Voice & writing',
    description: 'How the brand sounds: tone, audiences, terms, banned phrases and examples.',
    kit: 'voice',
  },
  {
    key: 'imagery',
    label: 'Imagery',
    description: 'Reference images that show what on-brand photography looks like.',
    kit: 'imagery',
  },
  {
    key: 'patterns',
    label: 'Patterns & templates',
    description: 'Named layouts and the templates that implement them.',
  },
  {
    key: 'channels',
    label: 'Channel guidance',
    description: 'Caption style, formats and calls to action per channel.',
  },
  {
    key: 'guidelines',
    label: 'Guidelines',
    description: 'The brand skill text agents read with the published version.',
    kit: 'guidelines',
  },
  {
    key: 'facts',
    label: 'Facts',
    description: 'What copy may state: proposed with evidence, approved by a brand manager.',
  },
  {
    key: 'objectives',
    label: 'Objectives',
    description: 'The metric the brand is steering by, with its guardrails.',
  },
  {
    key: 'versions',
    label: 'Versions',
    description: 'Draft → in review → published → retired. Publishing never changes approved work.',
  },
];

const OVERVIEW = SECTIONS[0] as (typeof SECTIONS)[number];

/**
 * Spec 21.2 brand system (proposed extraction; published; conflict; retired version) in the prototype's layout: the
 * parts of the system in a side list, the version being read in the header. The published version reads; a draft or
 * a version in review opens the same part in the kit editor. Facts, objectives and versions are their own panels.
 */
export function BrandSystemRoute() {
  const { brand, brandId } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const versions = useBrandVersions(brandId);
  const approvedFacts = useFacts(brandId, 'approved');
  const proposedFacts = useFacts(brandId, 'proposed');
  const section = SECTIONS.find((x) => x.key === params.get('section')) ?? OVERVIEW;
  const items = versions.data?.items ?? [];
  const published = items.find((v) => v.id === brand.publishedVersionId) ?? null;
  const working =
    items.find(
      (v) => (v.state === 'draft' || v.state === 'in_review') && (!published || v.number > published.number),
    ) ?? null;
  const viewingId = params.get('version') ?? published?.id ?? working?.id ?? null;
  const viewing = useBrandVersion(
    brandId,
    section.key === 'facts' || section.key === 'objectives' || section.key === 'versions' ? null : viewingId,
  );
  const set = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value === null) p.delete(key);
    else p.set(key, value);
    setParams(p, { replace: true });
  };
  const proposedCount = proposedFacts.data?.items.length ?? 0;
  const editable = viewing.data && (viewing.data.state === 'draft' || viewing.data.state === 'in_review');

  return (
    <main id="main" className="flex min-h-full flex-col lg:flex-row">
      <nav aria-label="Brand system sections" className="shrink-0 border-border lg:w-56 lg:border-r">
        <p className="hidden px-6 pb-2 pt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground lg:block">
          Brand system
        </p>
        <ul className="flex gap-1 overflow-x-auto px-4 py-2 lg:flex-col lg:gap-0.5 lg:px-3 lg:py-0">
          {SECTIONS.map((x) => (
            <li key={x.key} className="shrink-0">
              <button
                type="button"
                aria-current={x.key === section.key ? 'page' : undefined}
                onClick={() => set('section', x.key === 'overview' ? null : x.key)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-sm',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  x.key === section.key
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                {x.label}
                {x.key === 'facts' && proposedCount > 0 && (
                  <span className="text-xs tabular-nums text-status-critical">
                    {proposedCount}
                    <span className="sr-only"> proposed</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-8">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{brand.name}</h1>
            {viewing.data && (
              <>
                <Badge tone={VERSION_TONE[viewing.data.state]}>
                  Version {viewing.data.number} · {versionStateLabel[viewing.data.state]}
                </Badge>
                <code className="text-xs text-muted-foreground">{viewing.data.contentHash.slice(0, 12)}</code>
              </>
            )}
          </div>
          {(published || working) && (
            <div role="group" aria-label="Version shown" className="flex gap-1">
              {[published, working].flatMap((v) =>
                v
                  ? [
                      <Button
                        key={v.id}
                        size="sm"
                        variant={v.id === viewingId ? 'secondary' : 'ghost'}
                        aria-pressed={v.id === viewingId}
                        onClick={() => set('version', v.id === published?.id ? null : v.id)}
                      >
                        v{v.number} · {versionStateLabel[v.state].toLowerCase()}
                      </Button>,
                    ]
                  : [],
              )}
            </div>
          )}
        </header>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8">
          <div>
            <h2 className="text-lg font-semibold">{section.label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
          </div>
          {section.key === 'versions' && (
            <>
              <BrandSkillImport />
              <Versions publishedVersionId={brand.publishedVersionId} />
            </>
          )}
          {section.key === 'facts' && <Facts />}
          {section.key === 'objectives' && <Objectives />}
          {section.key !== 'versions' && section.key !== 'facts' && section.key !== 'objectives' && (
            <>
              {versions.isSuccess && !viewingId && (
                <EmptyState
                  title="No brand version yet"
                  description="Create a draft or import a brand skill in Versions; nothing is published until a brand manager publishes it."
                />
              )}
              {viewingId && viewing.isPending && <Skeleton label="Loading brand version" lines={4} />}
              {viewing.isError && (
                <RequestError error={viewing.error} onRetry={() => void viewing.refetch()} />
              )}
              {viewing.data && editable && section.kit && (
                <BrandKitEditor
                  key={`${viewing.data.id}:${viewing.data.version}`}
                  version={viewing.data}
                  only={section.kit}
                />
              )}
              {viewing.data && !(editable && section.kit) && (
                <SectionView
                  section={section.key}
                  doc={viewing.data.document}
                  brandName={brand.name}
                  factCount={approvedFacts.data?.items.length}
                  onOpen={(key) => set('section', key)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function SectionView({
  section,
  doc,
  brandName,
  factCount,
  onOpen,
}: {
  section: SectionKey;
  doc: BrandVersionDto['document'];
  brandName: string;
  factCount: number | undefined;
  onOpen: (key: string) => void;
}) {
  switch (section) {
    case 'overview':
      return <OverviewView doc={doc} brandName={brandName} factCount={factCount} onOpen={onOpen} />;
    case 'logo':
      return <LogoView doc={doc} />;
    case 'colour':
      return <ColourView doc={doc} />;
    case 'typography':
      return <TypographyView doc={doc} />;
    case 'voice':
      return <VoiceView doc={doc} />;
    case 'imagery':
      return <ImageryView doc={doc} />;
    case 'patterns':
      return <PatternsView doc={doc} />;
    case 'channels':
      return <ChannelsView doc={doc} />;
    case 'guidelines':
      return <GuidelinesView doc={doc} />;
    default:
      return null;
  }
}

/** A CONFLICT from an optimistic-concurrency check is the "conflict" state: shown with the reload action. */
function useConflict() {
  const [conflict, setConflict] = useState<UiError | null>(null);
  const onError = (err: unknown) => {
    const ui = toUiError(err);
    setConflict(ui.kind === 'conflict' ? ui : null);
    return ui;
  };
  return { conflict, onError, clear: () => setConflict(null) };
}

function Versions({ publishedVersionId }: { publishedVersionId: string | null }) {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const versions = useBrandVersions(brandId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useBrandVersion(brandId, selectedId);
  const { conflict, onError, clear } = useConflict();
  const invalidate = () => {
    clear();
    void queryClient.invalidateQueries(trpc.brand.pathFilter());
  };
  const fail = (err: unknown) => {
    const ui = onError(err);
    if (ui.kind !== 'conflict')
      toast({ tone: 'critical', title: 'Version change failed', description: ui.message });
  };
  const draftIntent = useIntentKey();
  const createDraft = useMutation(
    trpc.brand.versions.createDraft.mutationOptions({
      ...mutationIntent(draftIntent.key),
      onSuccess: () => {
        draftIntent.renew();
        invalidate();
      },
      onError: fail,
    }),
  );
  const submitIntent = useIntentKey();
  const submitForReview = useMutation(
    trpc.brand.versions.submitForReview.mutationOptions({
      ...mutationIntent(submitIntent.key),
      onSuccess: () => {
        submitIntent.renew();
        invalidate();
      },
      onError: fail,
    }),
  );
  const publishIntent = useIntentKey();
  const publish = useMutation(
    trpc.brand.versions.publish.mutationOptions({
      ...mutationIntent(publishIntent.key),
      onSuccess: () => {
        publishIntent.renew();
        invalidate();
        toast({ tone: 'good', title: 'Version published' });
      },
      onError: fail,
    }),
  );

  return (
    <Panel
      title="Versions"
      actions={
        <Button
          size="sm"
          variant="primary"
          onClick={() => createDraft.mutate({ brandId })}
          disabled={createDraft.isPending}
        >
          New draft
        </Button>
      }
    >
      {conflict && (
        <StatusBanner
          tone="warning"
          title="Conflict: this version changed since you loaded it"
          description={conflict.message}
          actions={
            <Button size="sm" onClick={invalidate}>
              Reload
            </Button>
          }
          className="mb-3"
        />
      )}
      {versions.isPending && <Skeleton label="Loading versions" />}
      {versions.isError && <RequestError error={versions.error} onRetry={() => void versions.refetch()} />}
      {versions.isSuccess && versions.data.items.length === 0 && (
        <EmptyState
          title="No brand versions yet"
          description="Create a draft, then open it to set the palette, voice, logos and reference imagery. Submit it for review and publish it when it is right."
        />
      )}
      {versions.isSuccess && versions.data.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-3">
                  Version
                </th>
                <th scope="col" className="py-1 pr-3">
                  State
                </th>
                <th scope="col" className="py-1 pr-3">
                  Updated
                </th>
                <th scope="col" className="py-1">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.data.items.map((v) => (
                <tr key={v.id} className="border-t border-border">
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() => setSelectedId(v.id)}
                      aria-expanded={selectedId === v.id}
                    >
                      Version {v.number}
                    </button>
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={VERSION_TONE[v.state]}>{versionStateLabel[v.state]}</Badge>{' '}
                    {v.id === publishedVersionId && <Badge tone="good">Current</Badge>}
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {new Date(v.updatedAt).toLocaleString()}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {(v.state === 'draft' || v.state === 'in_review') && (
                        <Button size="sm" onClick={() => setSelectedId(v.id)}>
                          Edit brand kit
                        </Button>
                      )}
                      {v.state === 'draft' && (
                        <Button
                          size="sm"
                          onClick={() =>
                            submitForReview.mutate({ brandId, versionId: v.id, expectedVersion: v.version })
                          }
                          disabled={submitForReview.isPending}
                        >
                          Submit for review
                        </Button>
                      )}
                      {v.state === 'in_review' && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            publish.mutate({ brandId, versionId: v.id, expectedVersion: v.version })
                          }
                          disabled={publish.isPending}
                        >
                          Publish
                        </Button>
                      )}
                      {v.state === 'retired' && (
                        <span className="text-xs text-muted-foreground">Read only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selectedId && (
        <div className="mt-3 rounded-md border border-border bg-muted p-3" aria-live="polite">
          {selected.isPending && <Skeleton label="Loading version" lines={2} />}
          {selected.isError && <RequestError error={selected.error} />}
          {selected.isSuccess && (selected.data.state === 'draft' || selected.data.state === 'in_review') && (
            <BrandKitEditor key={`${selected.data.id}:${selected.data.version}`} version={selected.data} />
          )}
          {selected.isSuccess &&
            (selected.data.state === 'published' || selected.data.state === 'retired') && (
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Voice</dt>
                <dd>{selected.data.document.voice.summary || <em>not written</em>}</dd>
                <dt className="text-muted-foreground">Colours</dt>
                <dd>
                  {selected.data.document.tokens.colours.length === 0 ? (
                    <em>none</em>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {selected.data.document.tokens.colours.map((c) => (
                        <li key={c.key} className="flex items-center gap-1">
                          <span
                            aria-hidden="true"
                            className="inline-block h-3 w-3 rounded-sm border border-border"
                            style={{ background: c.value }}
                          />
                          <code className="text-xs">
                            {c.key} {c.value}
                          </code>
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
                <dt className="text-muted-foreground">Type roles</dt>
                <dd>
                  {selected.data.document.tokens.typeRoles
                    .map((t) => `${t.role} ≥ ${t.minSizePx}px`)
                    .join(', ') || <em>none</em>}
                </dd>
                <dt className="text-muted-foreground">Content hash</dt>
                <dd>
                  <code className="text-xs">{selected.data.contentHash}</code>
                </dd>
              </dl>
            )}
        </div>
      )}
    </Panel>
  );
}

const FACT_TONE: Record<FactState, Tone> = { proposed: 'warning', approved: 'good', revoked: 'neutral' };

function Facts() {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [state, setState] = useState<FactState | 'all'>('all');
  const facts = useFacts(brandId, state === 'all' ? undefined : state);
  const { conflict, onError, clear } = useConflict();
  const invalidate = () => {
    clear();
    void queryClient.invalidateQueries(trpc.brand.facts.pathFilter());
  };
  const fail = (err: unknown) => {
    const ui = onError(err);
    if (ui.kind !== 'conflict')
      toast({ tone: 'critical', title: 'Fact change failed', description: ui.message });
  };
  const approveIntent = useIntentKey();
  const approve = useMutation(
    trpc.brand.facts.approve.mutationOptions({
      ...mutationIntent(approveIntent.key),
      onSuccess: () => {
        approveIntent.renew();
        invalidate();
      },
      onError: fail,
    }),
  );
  const revokeIntent = useIntentKey();
  const revoke = useMutation(
    trpc.brand.facts.revoke.mutationOptions({
      ...mutationIntent(revokeIntent.key),
      onSuccess: () => {
        revokeIntent.renew();
        invalidate();
      },
      onError: fail,
    }),
  );
  const proposeIntent = useIntentKey();
  const [kind, setKind] = useState<string>('claim');
  const [statement, setStatement] = useState('');
  const [evidence, setEvidence] = useState('');
  const propose = useMutation(
    trpc.brand.facts.propose.mutationOptions({
      ...mutationIntent(proposeIntent.key),
      onSuccess: () => {
        proposeIntent.renew();
        setStatement('');
        setEvidence('');
        invalidate();
      },
      onError: fail,
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!statement.trim() || !evidence.trim()) return;
    propose.mutate({
      brandId,
      kind: FactKind.parse(kind),
      statement: statement.trim(),
      evidence: [{ kind: 'other', ref: evidence.trim() }],
    });
  };

  return (
    <Panel
      title="Approved facts"
      id="facts"
      actions={
        <label className="flex items-center gap-2 text-xs">
          <span>Show</span>
          <Select
            size="sm"
            value={state}
            onValueChange={(v) => setState(v as FactState | 'all')}
            aria-label="Filter facts by state"
            options={[
              { value: 'all', label: 'All' },
              { value: 'proposed', label: 'Proposed' },
              { value: 'approved', label: 'Approved' },
              { value: 'revoked', label: 'Revoked' },
            ]}
          />
        </label>
      }
    >
      {conflict && (
        <StatusBanner
          tone="warning"
          title="Conflict: this fact changed since you loaded it"
          description={conflict.message}
          actions={
            <Button size="sm" onClick={invalidate}>
              Reload
            </Button>
          }
          className="mb-3"
        />
      )}
      {facts.isPending && <Skeleton label="Loading facts" />}
      {facts.isError && <RequestError error={facts.error} onRetry={() => void facts.refetch()} />}
      {facts.isSuccess && facts.data.items.length === 0 && (
        <EmptyState
          title="No facts"
          description="Facts a text can assert (offers, prices, claims) are proposed with evidence and approved by a brand manager."
        />
      )}
      {facts.isSuccess && facts.data.items.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {facts.data.items.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <Badge tone={FACT_TONE[f.state]}>{f.state}</Badge> <Badge glyph={false}>{f.kind}</Badge>{' '}
                <span>{f.statement}</span>
              </div>
              <div className="flex gap-1">
                {f.state === 'proposed' && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => approve.mutate({ brandId, factId: f.id, expectedVersion: f.version })}
                  >
                    Approve
                  </Button>
                )}
                {f.state !== 'revoked' && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => revoke.mutate({ brandId, factId: f.id, expectedVersion: f.version })}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={submit}
        className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-[10rem_1fr]"
        noValidate
      >
        <Field label="Kind" htmlFor="fact-kind">
          <Select
            id="fact-kind"
            value={kind}
            onValueChange={setKind}
            options={FactKind.options.map((k) => ({ value: k, label: k }))}
          />
        </Field>
        <Field
          label="Statement"
          htmlFor="fact-statement"
          error={propose.isError ? toUiError(propose.error).message : undefined}
        >
          <Textarea
            id="fact-statement"
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            maxLength={4000}
            rows={2}
          />
        </Field>
        <Field
          label="Evidence reference"
          htmlFor="fact-evidence"
          className="sm:col-span-2"
          hint="A URL, document or asset reference that supports the statement."
        >
          <Input
            id="fact-evidence"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            maxLength={1000}
          />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={propose.isPending || !statement.trim() || !evidence.trim()}>
            Propose fact
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function Objectives() {
  const { brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const objectives = useObjectives(brandId);
  const intent = useIntentKey();
  const [name, setName] = useState('');
  const [metric, setMetric] = useState('');
  const set = useMutation(
    trpc.brand.objectives.set.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setName('');
        setMetric('');
        void queryClient.invalidateQueries(trpc.brand.objectives.pathFilter());
      },
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !metric.trim()) return;
    set.mutate({
      brandId,
      name: name.trim(),
      primaryMetricKey: metric.trim(),
      guardrailMetricKeys: [],
      activeFrom: new Date().toISOString(),
    });
  };
  return (
    <Panel title="Objectives">
      {objectives.isPending && <Skeleton label="Loading objectives" lines={2} />}
      {objectives.isError && (
        <RequestError error={objectives.error} onRetry={() => void objectives.refetch()} />
      )}
      {objectives.isSuccess && objectives.data.items.length === 0 && (
        <EmptyState
          title="No objective set"
          description="One objective is active at a time; setting a new one closes the previous."
        />
      )}
      {objectives.isSuccess && objectives.data.items.length > 0 && (
        <ul className="flex flex-col divide-y divide-border text-sm">
          {objectives.data.items.map((o) => {
            const active = !o.activeUntil || new Date(o.activeUntil).getTime() > Date.now();
            return (
              <li key={o.id} className="flex flex-wrap items-center gap-2 py-2">
                <Badge tone={active ? 'good' : 'neutral'}>{active ? 'Active' : 'Closed'}</Badge>
                <span className="font-medium">{o.name}</span>
                <span className="text-muted-foreground">primary metric {o.primaryMetricKey}</span>
              </li>
            );
          })}
        </ul>
      )}
      <form
        onSubmit={submit}
        className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-2"
        noValidate
      >
        <Field
          label="Objective"
          htmlFor="obj-name"
          error={set.isError ? toUiError(set.error).message : undefined}
        >
          <Input id="obj-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Primary metric key" htmlFor="obj-metric" hint="e.g. qualified_enquiries">
          <Input id="obj-metric" value={metric} onChange={(e) => setMetric(e.target.value)} maxLength={80} />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={set.isPending || !name.trim() || !metric.trim()}>
            Set objective
          </Button>
        </div>
      </form>
    </Panel>
  );
}
