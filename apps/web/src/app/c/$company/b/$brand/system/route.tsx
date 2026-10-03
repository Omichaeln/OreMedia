import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { Badge, Button, EmptyState, Field, Input, Panel, Skeleton, StatusBanner, cn } from '@oremedia/ui';
import { RequestError } from '../../../../../../components/request-state';
import { useToast } from '../../../../../../components/toast';
import { Dialog, DialogActions, DialogClose, DialogContent } from '../../../../../../components/dialog';
import { useBrandContext } from '../../../../../../features/brand/brand-context';
import { BrandKitEditor, type KitSection } from '../../../../../../features/brand/brand-kit-editor';
import {
  ChannelsView,
  changedSections,
  ColourView,
  ExamplesView,
  GuidelinesView,
  ImageryView,
  LogoView,
  MessagingView,
  OverviewView,
  PatternsView,
  TemplatesView,
  TypographyView,
  VocabularyView,
  VoiceView,
  WritingView,
} from '../../../../../../features/brand/brand-read-views';
import { BrandSkillImport } from '../../../../../../features/brand/brand-skill-import';
import { FactsWorkspace } from '../../../../../../features/brand/facts-workspace';
import { VoiceExtraction } from '../../../../../../features/brand/voice-extraction';
import {
  pendingProposal,
  useBrandVersion,
  useBrandVersions,
  useCanSaveBrandSystem,
  useFacts,
  useObjectives,
  type BrandVersionSummary,
} from '../../../../../../features/brand/use-brand';
import { useTRPC } from '../../../../../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../../../../../lib/intent-key';
import { toUiError } from '../../../../../../lib/errors';

type Doc = BrandSystemDocumentV1;

type SectionKey =
  | 'overview'
  | 'logo'
  | 'colour'
  | 'typography'
  | 'voice'
  | 'messaging'
  | 'vocabulary'
  | 'writing'
  | 'examples'
  | 'templates'
  | 'imagery'
  | 'patterns'
  | 'channels'
  | 'guidelines'
  | 'facts'
  | 'objectives';

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
    kit: 'typography',
  },
  {
    key: 'voice',
    label: 'Voice & personality',
    description:
      'How the brand sounds: tone, personality, principles, terms, banned phrases, spelling and style rules.',
    kit: 'voice',
  },
  {
    key: 'messaging',
    label: 'Messaging',
    description:
      'Positioning, value proposition, pillars proved by approved facts, key messages and audiences.',
    kit: 'messaging',
  },
  {
    key: 'vocabulary',
    label: 'Vocabulary',
    description: 'Terms the brand prefers, allows, avoids or never uses, with what to write instead.',
    kit: 'vocabulary',
  },
  {
    key: 'writing',
    label: 'Writing patterns',
    description: 'How headlines, introductions, body copy, calls to action and long-form pieces are written.',
    kit: 'writing',
  },
  {
    key: 'examples',
    label: 'Examples',
    description: 'On-brand and off-brand copy with why, and the on-brand rewrite.',
    kit: 'examples',
  },
  {
    key: 'templates',
    label: 'Templates',
    description: 'Copy templates: the parts a piece of copy follows, in order, per content type and channel.',
    kit: 'templates',
  },
  {
    key: 'imagery',
    label: 'Imagery',
    description: 'Reference images that show what on-brand photography looks like.',
    kit: 'imagery',
  },
  {
    key: 'patterns',
    label: 'Visual patterns',
    description: 'Named visual layouts and the creative templates that implement them.',
    kit: 'patterns',
  },
  {
    key: 'channels',
    label: 'Channel guidance',
    description: "Defaults for every channel and what changes per channel, beside each platform's limits.",
    kit: 'channels',
  },
  {
    key: 'guidelines',
    label: 'Guidelines',
    description: 'The brand skill text agents read with the brand system.',
    kit: 'guidelines',
  },
  {
    key: 'facts',
    label: 'Facts',
    description:
      'What copy may state, by category, with sources and review dates: proposed by anyone, approved by a brand manager.',
  },
  {
    key: 'objectives',
    label: 'Objectives',
    description: 'The metric the brand is steering by, with its guardrails.',
  },
];

const OVERVIEW = SECTIONS[0] as (typeof SECTIONS)[number];

/** What is open in the editor: one section of the brand system, or a proposed update with every section. */
type Editing = { kind: 'section'; section: SectionKey } | { kind: 'proposal' } | null;

/**
 * Spec 21.2 brand system, D-22: one brand system per brand, edited in place. The parts of the system in a side list,
 * the applied brand system read section by section; a person who may save it edits a section in place and the save
 * applies at once. A proposed update (an imported brand skill, an agent's suggestion) waits at the top until a person
 * reviews and saves it, or discards it. Facts and objectives are their own panels.
 */
export function BrandSystemRoute() {
  const { companyId, brand, brandId } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const canSave = useCanSaveBrandSystem(companyId);
  const versions = useBrandVersions(brandId);
  const effectiveFacts = useFacts(brandId, { effective: true });
  const proposedFacts = useFacts(brandId, 'proposed');
  const section = SECTIONS.find((x) => x.key === params.get('section')) ?? OVERVIEW;
  const appliedId = brand.publishedVersionId ?? null;
  const applied = useBrandVersion(brandId, appliedId);
  const proposal = pendingProposal(versions.data?.items ?? [], appliedId);
  const proposed = useBrandVersion(brandId, proposal?.id ?? null);
  const [editing, setEditing] = useState<Editing>(null);
  // Bumped by a conflict's Reload so the editor reopens on the brand system as it is now.
  const [generation, setGeneration] = useState(0);
  const set = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value === null) p.delete(key);
    else p.set(key, value);
    setParams(p, { replace: true });
  };
  const open = (key: string) => {
    setEditing(null);
    set('section', key === 'overview' ? null : key);
  };
  const reload = () => {
    void queryClient.invalidateQueries(trpc.brand.pathFilter()).then(() => setGeneration((g) => g + 1));
  };
  const proposedCount = proposedFacts.data?.items.length ?? 0;
  const appliedDoc: Doc | null = applied.data?.document ?? null;
  // The editor starts from the applied brand system, or an empty one before the first save.
  const startDoc = appliedId === null ? emptyBrandSystemDocument() : appliedDoc;
  const contentSection = section.key !== 'facts' && section.key !== 'objectives';
  const editingSection = editing?.kind === 'section' && editing.section === section.key;
  const reviewing = editing?.kind === 'proposal' && proposal !== null;
  // Guidelines are imported, not written here: the section is editable (to remove them) once there are some.
  const editable =
    canSave &&
    section.kit !== undefined &&
    (section.kit !== 'guidelines' || appliedDoc?.guidelines !== undefined);
  const editorKey = `${appliedId ?? 'none'}:${generation}`;
  // The agent writes into the pending proposal when there is one, so it reads that proposal's guidelines. While that
  // proposal loads the extraction stays (it may have just made the proposal and be starting the run on it).
  const extractable = proposal
    ? proposed.isPending || proposed.data?.document.guidelines !== undefined
    : appliedDoc?.guidelines !== undefined;

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
                onClick={() => open(x.key)}
                className={cn(
                  // relative: the sr-only count is positioned inside the scrolling strip, not past the page edge
                  'relative flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-sm',
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
          <h1 className="text-xl font-semibold">{brand.name}</h1>
        </header>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8">
          {proposal && !reviewing && (
            <ProposalBanner
              brandId={brandId}
              proposal={proposal}
              appliedDoc={appliedId === null ? emptyBrandSystemDocument() : appliedDoc}
              canSave={canSave}
              onReview={() => setEditing({ kind: 'proposal' })}
            />
          )}
          {reviewing && proposal && (
            <ProposalReview
              key={`${proposal.id}:${editorKey}`}
              brandId={brandId}
              proposal={proposal}
              basedOnVersionId={appliedId}
              appliedDoc={appliedId === null ? emptyBrandSystemDocument() : appliedDoc}
              onClose={() => setEditing(null)}
              onReload={reload}
            />
          )}
          {!reviewing && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{section.label}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
                </div>
                {editable && !editingSection && startDoc && (
                  <Button size="sm" onClick={() => setEditing({ kind: 'section', section: section.key })}>
                    Edit<span className="sr-only"> {section.label}</span>
                  </Button>
                )}
              </div>
              {section.key === 'facts' && <FactsWorkspace />}
              {section.key === 'objectives' && <Objectives />}
              {contentSection && (
                <>
                  {appliedId === null && !editingSection && (
                    <EmptyState
                      title="Set up your brand system"
                      description={
                        canSave
                          ? 'Set the palette, typography, voice, logos and imagery, or import a brand skill under Guidelines. Saving applies it at once.'
                          : 'Nothing has been saved yet. A brand manager, admin or owner sets it up.'
                      }
                      action={
                        canSave && (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => setEditing({ kind: 'section', section: section.key })}
                          >
                            Set up the brand system
                          </Button>
                        )
                      }
                    />
                  )}
                  {appliedId !== null && applied.isPending && (
                    <Skeleton label="Loading the brand system" lines={4} />
                  )}
                  {applied.isError && (
                    <RequestError error={applied.error} onRetry={() => void applied.refetch()} />
                  )}
                  {editingSection && startDoc && (
                    <BrandKitEditor
                      key={editorKey}
                      document={startDoc}
                      basedOnVersionId={appliedId}
                      only={section.kit}
                      onClose={() => setEditing(null)}
                      onReload={reload}
                    />
                  )}
                  {appliedDoc && !editingSection && (
                    <SectionView
                      section={section.key}
                      doc={appliedDoc}
                      brandName={brand.name}
                      facts={effectiveFacts.data?.items}
                      onOpen={open}
                    />
                  )}
                  {section.key === 'guidelines' && canSave && !editingSection && (
                    <>
                      {extractable && <VoiceExtraction proposal={proposal} />}
                      <BrandSkillImport />
                    </>
                  )}
                </>
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
  facts,
  onOpen,
}: {
  section: SectionKey;
  doc: Doc;
  brandName: string;
  facts: Array<{ id: string; statement: string }> | undefined;
  onOpen: (key: string) => void;
}) {
  switch (section) {
    case 'overview':
      return <OverviewView doc={doc} brandName={brandName} factCount={facts?.length} onOpen={onOpen} />;
    case 'logo':
      return <LogoView doc={doc} />;
    case 'colour':
      return <ColourView doc={doc} />;
    case 'typography':
      return <TypographyView doc={doc} />;
    case 'voice':
      return <VoiceView doc={doc} />;
    case 'messaging':
      return <MessagingView doc={doc} facts={facts} />;
    case 'vocabulary':
      return <VocabularyView doc={doc} />;
    case 'writing':
      return <WritingView doc={doc} />;
    case 'examples':
      return <ExamplesView doc={doc} />;
    case 'templates':
      return <TemplatesView doc={doc} />;
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

/** Where a proposed update came from, when its document says: a brand skill whose guidelines differ from the applied ones. */
const proposalOrigin = (next: Doc, applied: Doc | null): string | null =>
  next.guidelines && next.guidelines.source.packageHash !== applied?.guidelines?.source.packageHash
    ? `Imported from the brand skill ${next.guidelines.source.name}.`
    : null;

/**
 * D-22: the one banner for a pending proposal: what it changes against the applied brand system and where it came
 * from, with Review (the full editor on the proposal) and Discard (confirmed first) for those who may save.
 */
function ProposalBanner({
  brandId,
  proposal,
  appliedDoc,
  canSave,
  onReview,
}: {
  brandId: string;
  proposal: BrandVersionSummary;
  appliedDoc: Doc | null;
  canSave: boolean;
  onReview: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const next = useBrandVersion(brandId, proposal.id);
  const [discarding, setDiscarding] = useState(false);
  const intent = useIntentKey();
  const discard = useMutation(
    trpc.brand.system.discardProposal.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: () => {
        intent.renew();
        setDiscarding(false);
        void queryClient.invalidateQueries(trpc.brand.pathFilter());
        toast({ tone: 'good', title: 'Proposed update discarded' });
      },
      onError: (err) => {
        intent.renew();
        setDiscarding(false);
        void queryClient.invalidateQueries(trpc.brand.pathFilter());
        toast({ tone: 'critical', title: 'Not discarded', description: toUiError(err).message });
      },
    }),
  );
  const doc = next.data?.document ?? null;
  const changes = doc && appliedDoc ? changedSections(doc, appliedDoc) : null;
  const origin = doc ? proposalOrigin(doc, appliedDoc) : null;
  return (
    <>
      <StatusBanner
        tone="info"
        title="A proposed update is waiting"
        description={
          <>
            {origin && <span className="block">{origin}</span>}
            {changes && changes.length > 0 && (
              <span className="block">It changes {changes.map((c) => c.label).join(', ')}.</span>
            )}
            {changes && changes.length === 0 && (
              <span className="block">It has the same content as the brand system.</span>
            )}
            <span className="block">
              {canSave
                ? 'Nothing applies until you review and save it.'
                : 'Nothing applies until a brand manager, admin or owner saves it.'}
            </span>
          </>
        }
        actions={
          canSave && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={onReview}>
                Review
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDiscarding(true)}>
                Discard
              </Button>
            </div>
          )
        }
        data-testid="proposed-update"
      />
      <Dialog open={discarding} onOpenChange={(o) => !o && setDiscarding(false)}>
        {discarding && (
          <DialogContent
            role="alertdialog"
            title="Discard the proposed update?"
            description="The brand system stays as it is. The proposal is closed and cannot be applied later."
          >
            <DialogActions>
              <DialogClose asChild>
                <Button size="sm" variant="ghost">
                  Keep it
                </Button>
              </DialogClose>
              <Button
                size="sm"
                variant="danger"
                disabled={discard.isPending}
                onClick={() =>
                  discard.mutate({ brandId, versionId: proposal.id, expectedVersion: proposal.version })
                }
              >
                {discard.isPending ? 'Discarding…' : 'Discard'}
              </Button>
            </DialogActions>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

/** D-22: a proposed update opened in the full editor; saving applies it (with any edits) and closes the proposal. */
function ProposalReview({
  brandId,
  proposal,
  basedOnVersionId,
  appliedDoc,
  onClose,
  onReload,
}: {
  brandId: string;
  proposal: BrandVersionSummary;
  basedOnVersionId: string | null;
  appliedDoc: Doc | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const next = useBrandVersion(brandId, proposal.id);
  const changes = next.data && appliedDoc ? changedSections(next.data.document, appliedDoc) : null;
  return (
    <section aria-labelledby="proposal-review" className="flex flex-col gap-3" data-testid="proposal-review">
      <div>
        <h2 id="proposal-review" className="text-lg font-semibold">
          Proposed update
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {changes && changes.length > 0 ? `Changes ${changes.map((c) => c.label).join(', ')}. ` : ''}
          Review every section, edit what is not right, then save to apply it.
        </p>
      </div>
      {next.isPending && <Skeleton label="Loading the proposed update" lines={4} />}
      {next.isError && <RequestError error={next.error} onRetry={() => void next.refetch()} />}
      {next.data && (
        <BrandKitEditor
          document={next.data.document}
          basedOnVersionId={basedOnVersionId}
          proposal={{ versionId: next.data.id, expectedVersion: next.data.version }}
          onClose={onClose}
          onReload={onReload}
        />
      )}
    </section>
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
