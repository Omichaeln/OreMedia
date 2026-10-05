import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { ASSIST_SECTION_LABEL, type AssistSection } from '@oremedia/contracts/brand-assist';
import {
  Button,
  Chip,
  EmptyState,
  Field,
  Input,
  Skeleton,
  StatusBanner,
  StatusDot,
  cn,
  type Tone,
} from '@oremedia/ui';
import { RequestError } from '../../../../../../components/request-state';
import { Section } from '../../../../../../components/section';
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
import { BrandHistory } from '../../../../../../features/brand/brand-history';
import { AssistJobBlock, AssistSetup, useStartAssist } from '../../../../../../features/brand/assist-setup';
import { AssistantDialog } from '../../../../../../features/brand/section-assistant';
import { useAssistJobs } from '../../../../../../features/brand/use-assist';
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
  type ObjectiveDto,
} from '../../../../../../features/brand/use-brand';
import { useTRPC } from '../../../../../../lib/trpc';
import { mutationIntent, useIntentKey } from '../../../../../../lib/intent-key';
import { toUiError } from '../../../../../../lib/errors';

type Doc = BrandSystemDocumentV1;

/** The secondary navigation's eleven headings, as the interface lists them. */
type GroupKey =
  | 'overview'
  | 'logo'
  | 'colour'
  | 'typography'
  | 'voice'
  | 'imagery'
  | 'patterns'
  | 'channels'
  | 'facts'
  | 'objectives'
  | 'history';

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
  | 'objectives'
  | 'history';

/**
 * The interface's headings. The last one reads "History" where the interface says "Versions": D-22 keeps versions
 * internal, so what the application shows there is each state the brand system was applied in, not versions to
 * manage.
 */
const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'logo', label: 'Logo' },
  { key: 'colour', label: 'Colour' },
  { key: 'typography', label: 'Typography & layout' },
  { key: 'voice', label: 'Voice & writing' },
  { key: 'imagery', label: 'Imagery' },
  { key: 'patterns', label: 'Patterns & templates' },
  { key: 'channels', label: 'Channel guidance' },
  { key: 'facts', label: 'Facts' },
  { key: 'objectives', label: 'Objectives' },
  { key: 'history', label: 'History' },
];

/**
 * The system's parts, each at its own `?section=`, grouped under the interface's headings: Messaging, Vocabulary,
 * Writing patterns and Examples sit under Voice & writing; Templates and Visual patterns under Patterns & templates;
 * Guidelines under Channel guidance. A heading with several parts shows them as a row of pills.
 */
const SECTIONS: Array<{
  key: SectionKey;
  group: GroupKey;
  label: string;
  description: string;
  kit?: KitSection;
  /** BSC-5: the section the "Ask AI" assistant proposes for. */
  assist?: AssistSection;
}> = [
  {
    key: 'overview',
    group: 'overview',
    label: 'Overview',
    description: 'The brand at a glance: voice, palette and what each part holds.',
  },
  {
    key: 'logo',
    group: 'logo',
    label: 'Logo',
    description: 'Variants with their grounds, clear space and minimum width.',
    kit: 'logos',
  },
  {
    key: 'colour',
    group: 'colour',
    label: 'Colour',
    description: 'Tokens by role, and every text pairing against the contrast target.',
    kit: 'palette',
  },
  {
    key: 'typography',
    group: 'typography',
    label: 'Typography & layout',
    description: 'Type roles bound to font files, spacing and radii.',
    kit: 'typography',
  },
  {
    key: 'voice',
    group: 'voice',
    label: 'Voice & personality',
    description: 'How the brand sounds. Copywriting agents and claim checks read this directly.',
    kit: 'voice',
    assist: 'voice',
  },
  {
    key: 'messaging',
    group: 'voice',
    label: 'Messaging',
    description:
      'Positioning, value proposition, pillars proved by approved facts, key messages and audiences.',
    kit: 'messaging',
    assist: 'messaging',
  },
  {
    key: 'vocabulary',
    group: 'voice',
    label: 'Vocabulary',
    description: 'Terms the brand prefers, allows, avoids or never uses, with what to write instead.',
    kit: 'vocabulary',
    assist: 'vocabulary',
  },
  {
    key: 'writing',
    group: 'voice',
    label: 'Writing patterns',
    description: 'How headlines, introductions, body copy, calls to action and long-form pieces are written.',
    kit: 'writing',
    assist: 'writing',
  },
  {
    key: 'examples',
    group: 'voice',
    label: 'Examples',
    description: 'On-brand and off-brand copy with why, and the on-brand rewrite.',
    kit: 'examples',
    assist: 'examples',
  },
  {
    key: 'imagery',
    group: 'imagery',
    label: 'Imagery',
    description: 'Reference images that show what on-brand photography looks like.',
    kit: 'imagery',
  },
  {
    key: 'patterns',
    group: 'patterns',
    label: 'Visual patterns',
    description: 'Reusable layouts. The layout agent only uses eligible template versions listed here.',
    kit: 'patterns',
  },
  {
    key: 'templates',
    group: 'patterns',
    label: 'Templates',
    description: 'Copy templates: the parts a piece of copy follows, in order, per content type and channel.',
    kit: 'templates',
    assist: 'templates',
  },
  {
    key: 'channels',
    group: 'channels',
    label: 'Channel guidance',
    description: "How the voice adapts per channel, beside each platform's limits.",
    kit: 'channels',
    assist: 'channels',
  },
  {
    key: 'guidelines',
    group: 'channels',
    label: 'Guidelines',
    description: 'The brand skill text agents read with the brand system.',
    kit: 'guidelines',
  },
  {
    key: 'facts',
    group: 'facts',
    label: 'Facts',
    description:
      'Anything copy can assert — offers, prices, claims — must be an approved fact with evidence. Proposed by anyone, approved by a brand manager.',
    assist: 'facts',
  },
  {
    key: 'objectives',
    group: 'objectives',
    label: 'Objectives',
    description:
      'One objective is active at a time. Recommendations are ranked against it — not against likes.',
  },
  {
    key: 'history',
    group: 'history',
    label: 'History',
    description: 'Each time the brand system was applied: who, when and what changed; compare and restore.',
  },
];

const OVERVIEW = SECTIONS[0] as (typeof SECTIONS)[number];
const OVERVIEW_GROUP = GROUPS[0] as (typeof GROUPS)[number];

/** The applied brand system's record, shortened as the interface shows it (the full id is the title). */
const shortId = (id: string) => (id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id);

/** What is open in the editor: one section of the brand system, or a proposed update with every section. */
type Editing = { kind: 'section'; section: SectionKey } | { kind: 'proposal' } | null;

/** The header's state pill: a dot beside the word, as the interface sets states. */
function StatePill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-[3px] text-xs">
      <StatusDot tone={tone} size="sm" />
      {children}
    </span>
  );
}

/**
 * Spec 21.2 brand system, D-22: one brand system per brand, edited in place. The interface's secondary navigation
 * on the left, the brand's name with its state in the header, the applied brand system read section by section; a
 * person who may save it edits a section in place and the save applies at once. A proposed update (an imported
 * brand skill, an agent's suggestion) waits at the top until a person reviews and saves it, or discards it. Facts,
 * objectives and the history are their own sections.
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
  const group = GROUPS.find((g) => g.key === section.group) ?? OVERVIEW_GROUP;
  const siblings = SECTIONS.filter((x) => x.group === section.group);
  const appliedId = brand.publishedVersionId ?? null;
  const applied = useBrandVersion(brandId, appliedId);
  const proposal = pendingProposal(versions.data?.items ?? [], appliedId);
  const proposed = useBrandVersion(brandId, proposal?.id ?? null);
  const [editing, setEditing] = useState<Editing>(null);
  // BSC-4/5: the guided setup (`?assist=setup`, with the job to show), the assistant dialog and the jobs it started.
  const assistJobs = useAssistJobs(brandId);
  const [assistant, setAssistant] = useState<AssistSection | 'all' | null>(null);
  const [sectionJobs, setSectionJobs] = useState<
    Array<{ jobId: string; scope: AssistSection | 'all'; sections: AssistSection[] }>
  >([]);
  // Bumped by a conflict's Reload so the editor reopens on the brand system as it is now.
  const [generation, setGeneration] = useState(0);
  const open = (key: string) => {
    setEditing(null);
    const p = new URLSearchParams(params);
    p.delete('assist');
    if (key === 'overview') p.delete('section');
    else p.set('section', key);
    setParams(p, { replace: true });
  };
  const setupOpen = params.get('assist') === 'setup';
  const openSetup = (jobId?: string) => {
    setEditing(null);
    const p = new URLSearchParams(params);
    p.set('assist', 'setup');
    if (jobId) p.set('job', jobId);
    else p.delete('job');
    setParams(p, { replace: true });
  };
  const closeSetup = () => {
    const p = new URLSearchParams(params);
    p.delete('assist');
    p.delete('job');
    setParams(p, { replace: true });
  };
  // A setup job that is still running or has suggestions waiting for a person.
  const waitingJob =
    assistJobs.data?.items.find(
      (j) =>
        j.kind === 'setup' &&
        (!['ready', 'partially_ready', 'failed', 'cancelled'].includes(j.state) ||
          j.suggestionCounts.pending > 0),
    ) ?? null;
  // "Request alternatives" from the section assistant: the same sources, the rejected suggestions not repeated.
  const pendingScope = useRef<{ scope: AssistSection | 'all'; sections: AssistSection[] } | null>(null);
  const startAlt = useStartAssist((jobId) => {
    const p = pendingScope.current;
    if (p) setSectionJobs((all) => [{ jobId, ...p }, ...all]);
  });
  const startAlternatives = async (fromJobId: string, sec: AssistSection) => {
    const from = sectionJobs.find((j) => j.jobId === fromJobId);
    pendingScope.current = { scope: from?.scope ?? sec, sections: [sec] };
    const job = await queryClient.fetchQuery(
      trpc.brand.assist.get.queryOptions({ brandId, jobId: fromJobId }),
    );
    startAlt.mutate({
      brandId,
      kind: 'section',
      sections: [sec],
      sourceIds: job.sourceIds,
      alternativesForJobId: fromJobId,
      instruction: 'Offer different alternatives to the suggestions that were rejected.',
    });
  };
  const reviewProposal = () => {
    closeSetup();
    void queryClient.invalidateQueries(trpc.brand.pathFilter()).then(() => setEditing({ kind: 'proposal' }));
  };
  const reload = () => {
    void queryClient.invalidateQueries(trpc.brand.pathFilter()).then(() => setGeneration((g) => g + 1));
  };
  const proposedCount = proposedFacts.data?.items.length ?? 0;
  const appliedDoc: Doc | null = applied.data?.document ?? null;
  // The editor starts from the applied brand system, or an empty one before the first save.
  const startDoc = appliedId === null ? emptyBrandSystemDocument() : appliedDoc;
  const contentSection = section.key !== 'facts' && section.key !== 'objectives' && section.key !== 'history';
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
    <main id="main" className="om-in grid min-h-full md:grid-cols-[200px_minmax(0,1fr)]">
      <nav
        aria-label="Brand system sections"
        className={cn(
          'sticky top-0 z-10 flex gap-px overflow-x-auto whitespace-nowrap border-b border-border bg-background px-3 py-2.5',
          'md:h-[calc(100vh-52px)] md:flex-col md:self-start md:overflow-y-auto md:border-b-0 md:border-r md:py-8 wide:h-screen',
        )}
      >
        <p className="om-label shrink-0 px-2.5 py-[7px] md:py-0 md:pb-3">Brand system</p>
        <ul className="flex gap-px md:flex-col">
          {GROUPS.map((g) => {
            const first = SECTIONS.find((x) => x.group === g.key) ?? OVERVIEW;
            const current = g.key === section.group;
            return (
              <li key={g.key} className="shrink-0">
                <button
                  type="button"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => open(first.key)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-[7px] text-left text-sm',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    current
                      ? 'bg-secondary font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span>{g.label}</span>
                  {g.key === 'facts' && proposedCount > 0 && (
                    <span className="text-xs tabular-nums text-accent-ink">
                      {proposedCount}
                      <span className="sr-only"> proposed</span>
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-5 sm:px-10 sm:py-6">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold tracking-[-0.01em]">{brand.name}</h1>
            {appliedId !== null ? (
              <StatePill tone="good">Published</StatePill>
            ) : (
              <StatePill tone="neutral">Not saved yet</StatePill>
            )}
            {proposal && <StatePill tone="info">Proposed update</StatePill>}
            {appliedId !== null && (
              <span className="text-xs tabular-nums text-muted-foreground" title={appliedId}>
                {shortId(appliedId)}
              </span>
            )}
          </div>
          {canSave && (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => setAssistant('all')} disabled={!startDoc}>
                Ask AI
              </Button>
              <Button size="sm" onClick={() => openSetup()}>
                Import sources
              </Button>
            </div>
          )}
        </header>
        <div className="flex w-full max-w-[960px] flex-col gap-9 px-4 pb-20 pt-6 sm:px-10 sm:pt-8">
          {waitingJob && !setupOpen && !reviewing && (
            <StatusBanner
              tone="info"
              title="Suggestions from your sources"
              description={
                waitingJob.suggestionCounts.pending > 0
                  ? `${waitingJob.suggestionCounts.pending} suggestion${waitingJob.suggestionCounts.pending === 1 ? ' is' : 's are'} waiting for review.`
                  : 'Your sources are being read.'
              }
              actions={
                <Button size="sm" variant="primary" onClick={() => openSetup(waitingJob.id)}>
                  Review suggestions
                </Button>
              }
              data-testid="assist-waiting"
            />
          )}
          {setupOpen && !reviewing && (
            <AssistSetup
              key={params.get('job') ?? 'new'}
              initialJobId={params.get('job')}
              canDecide={canSave}
              onApply={reviewProposal}
              onClose={closeSetup}
            />
          )}
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
          {!reviewing && !setupOpen && (
            <div key={section.key} className="om-in flex flex-col gap-9">
              {section.key !== 'overview' && (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-end justify-between gap-4">
                    <div className="flex min-w-[280px] flex-1 flex-col gap-1">
                      <h2 className="text-xl font-bold tracking-[-0.01em]">{group.label}</h2>
                      <p className="text-pretty text-sm text-muted-foreground">{section.description}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {canSave && section.assist && !editingSection && startDoc && (
                        <Button onClick={() => setAssistant(section.assist ?? null)}>
                          Ask AI<span className="sr-only"> about {section.label}</span>
                        </Button>
                      )}
                      {editable && !editingSection && startDoc && (
                        <Button onClick={() => setEditing({ kind: 'section', section: section.key })}>
                          Edit<span className="sr-only"> {section.label}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                  {siblings.length > 1 && (
                    <nav aria-label={`${group.label} parts`} className="flex flex-wrap gap-1">
                      {siblings.map((x) => (
                        <Chip key={x.key} selected={x.key === section.key} onClick={() => open(x.key)}>
                          {x.label}
                        </Chip>
                      ))}
                    </nav>
                  )}
                </div>
              )}
              {sectionJobs
                .filter((j) => j.scope === 'all' || j.scope === section.assist)
                .map((j) => (
                  <section
                    key={j.jobId}
                    aria-label={
                      j.scope === 'all'
                        ? 'AI suggestions'
                        : `AI suggestions for ${ASSIST_SECTION_LABEL[j.scope]}`
                    }
                    className="rounded-xl border border-border bg-card p-4"
                    data-testid="section-assistant-results"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="text-base font-bold">AI suggestions</h3>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSectionJobs((all) => all.filter((x) => x.jobId !== j.jobId))}
                      >
                        Hide
                      </Button>
                    </div>
                    <AssistJobBlock
                      jobId={j.jobId}
                      canDecide={canSave}
                      sections={j.scope === 'all' ? j.sections : [j.scope]}
                      onFollowUp={(next) => setSectionJobs((all) => [{ ...j, jobId: next }, ...all])}
                      onAlternatives={(sec) => void startAlternatives(j.jobId, sec)}
                      onApply={reviewProposal}
                    />
                  </section>
                ))}
              {section.key === 'history' && (
                <BrandHistory canRestore={canSave} appliedVersionId={appliedId} />
              )}
              {section.key === 'facts' && <FactsWorkspace />}
              {section.key === 'objectives' && <Objectives />}
              {assistant !== null && startDoc && (
                <AssistantDialog
                  scope={assistant}
                  doc={startDoc}
                  onClose={() => setAssistant(null)}
                  onStarted={(jobId, sections) => {
                    const scope = assistant;
                    setAssistant(null);
                    setSectionJobs((all) => [{ jobId, scope, sections }, ...all]);
                  }}
                />
              )}
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
                          <div className="flex flex-wrap justify-center gap-2">
                            <Button size="sm" variant="primary" onClick={() => openSetup()}>
                              Set up from your website and documents
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => setEditing({ kind: 'section', section: section.key })}
                            >
                              Set up the brand system
                            </Button>
                          </div>
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
                      proposedFacts={proposedFacts.data ? proposedCount : undefined}
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
            </div>
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
  proposedFacts,
  onOpen,
}: {
  section: SectionKey;
  doc: Doc;
  brandName: string;
  facts: Array<{ id: string; statement: string }> | undefined;
  proposedFacts: number | undefined;
  onOpen: (key: string) => void;
}) {
  switch (section) {
    case 'overview':
      return (
        <OverviewView
          doc={doc}
          brandName={brandName}
          factCount={facts?.length}
          proposedFactCount={proposedFacts}
          onOpen={onOpen}
        />
      );
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
 * D-22: the one strip for a pending proposal, as the interface notes a draft in view: what it changes against the
 * applied brand system and where it came from, with Review (the full editor on the proposal) and Discard (confirmed
 * first) for those who may save.
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
      <div
        role="status"
        className="om-in flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-accent-tint px-3.5 py-2.5 text-sm"
        data-testid="proposed-update"
      >
        <p className="min-w-0 flex-1 text-pretty">
          <span className="font-medium">A proposed update is waiting.</span>
          {origin && <> {origin}</>}
          {changes && changes.length > 0 && <> It changes {changes.map((c) => c.label).join(', ')}.</>}
          {changes && changes.length === 0 && <> It has the same content as the brand system.</>}{' '}
          {canSave
            ? 'Nothing applies until you review and save it.'
            : 'Nothing applies until a brand manager, admin or owner saves it.'}
        </p>
        {canSave && (
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              className="rounded-md font-medium hover:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onReview}
            >
              Review <span aria-hidden="true">→</span>
            </button>
            <button
              type="button"
              className="rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setDiscarding(true)}
            >
              Discard
            </button>
          </div>
        )}
      </div>
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
    <section aria-labelledby="proposal-review" className="flex flex-col gap-4" data-testid="proposal-review">
      <div className="flex flex-col gap-1">
        <h2 id="proposal-review" className="text-xl font-bold tracking-[-0.01em]">
          Proposed update
        </h2>
        <p className="text-pretty text-sm text-muted-foreground">
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

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const isActive = (o: ObjectiveDto) => !o.activeUntil || new Date(o.activeUntil).getTime() > Date.now();

/**
 * Objectives as the interface lays them out: the active one as a card (since when, its name, metric and guardrails),
 * the closed ones as a ruled history, then the form that sets a new one and closes the current.
 */
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
  const items = objectives.data?.items ?? [];
  const active = items.filter(isActive);
  const closed = items.filter((o) => !isActive(o));
  return (
    <div className="flex flex-col gap-7">
      {objectives.isPending && <Skeleton label="Loading objectives" lines={2} />}
      {objectives.isError && (
        <RequestError error={objectives.error} onRetry={() => void objectives.refetch()} />
      )}
      {objectives.isSuccess && items.length === 0 && (
        <EmptyState
          title="No objective set"
          description="One objective is active at a time; setting a new one closes the previous."
        />
      )}
      {active.map((o) => (
        <div
          key={o.id}
          className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-5"
          data-testid="objective-active"
        >
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusDot tone="good" size="sm" />
            Active since {day(o.activeFrom)}
          </p>
          <p className="text-xl font-bold tracking-[-0.01em]">{o.name}</p>
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[140px_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Primary metric</dt>
            <dd className="text-xs tabular-nums">{o.primaryMetricKey}</dd>
            {o.guardrailMetricKeys.length > 0 && (
              <>
                <dt className="text-muted-foreground">Guardrails</dt>
                <dd className="text-xs tabular-nums">{o.guardrailMetricKeys.join(' · ')}</dd>
              </>
            )}
          </dl>
        </div>
      ))}
      {closed.length > 0 && (
        <Section id="objective-history" title="History">
          <ul className="flex flex-col">
            {closed.map((o) => (
              <li
                key={o.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-border py-[11px] text-sm first:border-t-0"
              >
                <span>
                  {o.name}{' '}
                  <span className="text-xs tabular-nums text-muted-foreground">{o.primaryMetricKey}</span>
                </span>
                <span className="text-muted-foreground">
                  {day(o.activeFrom)}
                  {o.activeUntil ? ` – ${day(o.activeUntil)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <form
        onSubmit={submit}
        className="grid gap-2.5 border-t border-border pt-4 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))] sm:items-end"
        noValidate
      >
        <Field
          label="New objective"
          htmlFor="obj-name"
          error={set.isError ? toUiError(set.error).message : undefined}
        >
          <Input id="obj-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Primary metric key" htmlFor="obj-metric">
          <Input
            id="obj-metric"
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            maxLength={80}
            placeholder="e.g. qualified_enquiries"
            className="tabular-nums"
          />
        </Field>
        <div>
          <Button type="submit" disabled={set.isPending || !name.trim() || !metric.trim()}>
            Set objective{active.length > 0 ? ' (closes current)' : ''}
          </Button>
        </div>
      </form>
    </div>
  );
}
