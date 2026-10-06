import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Skeleton,
  StatusBanner,
  StatusDot,
  toneGlyph,
} from '@oremedia/ui';
import { Drawer, DrawerContent, DrawerTrigger } from '../../components/drawer';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { Select } from '../../components/select';
import { Tab, TabList, TabPanel, Tabs } from '../../components/tabs';
import { denialOf, toUiError } from '../../lib/errors';
import { mutationIntent, useIntentKey } from '../../lib/intent-key';
import { useTRPC } from '../../lib/trpc';
import { EffectiveLimits } from '../agents/effective-limits';
import { useAgentPrincipals } from '../agents/use-agent-runs';
import { brandPath, useBrandContext } from '../brand/brand-context';
import { modeLabel } from '../experiments/experiment-helpers';
import { useCompanies } from '../portfolio/use-companies';
import { FreshnessLine } from './freshness-line';
import {
  anomalyText,
  canApprovePlaybook,
  clusterKindChip,
  EXPERIMENT_GROUPS,
  hasCoverageGaps,
  insightLabel,
  severityChip,
  STRENGTH_CHIP,
  workspaceExperimentChip,
} from './intelligence-helpers';
import { PlaybookPanel } from './playbook-panel';
import { RecommendationCard } from './recommendation-card';
import {
  useAnomalies,
  useVoiceClusters,
  useWorkspace,
  type AnalystRunDto,
  type InsightDto,
  type RecommendationDto,
  type WorkspaceDto,
} from './use-intelligence';

const VIEW_PARAM = 'view';
/** The interface's tab order; it opens on "What to do next". */
const VIEWS = ['changed', 'learned', 'next', 'voice', 'experiments', 'playbook'] as const;
type View = (typeof VIEWS)[number];
const DEFAULT_VIEW: View = 'next';
const VIEW_LABEL: Record<View, string> = {
  changed: 'What changed',
  learned: 'What we learned',
  next: 'What to do next',
  voice: 'Customer voice',
  experiments: 'Experiments',
  playbook: 'Brand playbook',
};

/** A view's opening line: what it holds and what it may claim (the server's statement). */
function Statement({ children }: { children: ReactNode }) {
  return <p className="text-pretty text-sm text-muted-foreground">{children}</p>;
}

/**
 * Insights as the interface lists what was learned: a dot and the statement on a ruled row. Under it, in muted
 * text, the label that says what kind of claim it is (so the dot is never the only carrier), the period and the
 * evidence it rests on.
 */
function InsightRows({ items, label, emptyText }: { items: InsightDto[]; label: string; emptyText: string }) {
  if (items.length === 0) return <p className="py-2.5 text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <ul className="divide-y divide-border" aria-label={label}>
      {items.map((i) => {
        const strength = STRENGTH_CHIP[i.strength];
        return (
          <li
            key={i.id}
            className="flex gap-2.5 py-2.5 text-sm"
            data-testid="insight"
            data-insight-kind={i.kind}
          >
            <StatusDot tone={strength.tone} size="sm" className="mt-[7px]" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{i.statement}</span>
              <span className="text-xs text-muted-foreground">
                {insightLabel(i.kind, i.strength)} · {strength.label} ·{' '}
                {new Date(i.periodStart).toLocaleDateString()} to {new Date(i.periodEnd).toLocaleDateString()}
                {i.evidence.length > 0 &&
                  ` · Evidence: ${i.evidence.map((e) => `${e.kind} ${e.ref}${e.note ? ` (${e.note})` : ''}`).join('; ')}`}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The ranked list. A decided recommendation leaves the workspace's proposed list on the next read; the card is kept
 * (same key, same list) so its outcome and the link to what it created stay visible.
 */
function RecommendationList({
  companyId,
  brandId,
  view,
  evidence,
}: {
  companyId: string;
  brandId: string;
  view: WorkspaceDto['whatToDoNext'];
  evidence: Map<string, string>;
}) {
  const [decided, setDecided] = useState<RecommendationDto[]>([]);
  const current = new Set(view.items.map((r) => r.id));
  const retained = decided.filter((r) => !current.has(r.id));
  const remember = (r: RecommendationDto) => setDecided((d) => [...d.filter((x) => x.id !== r.id), r]);
  const rows = [
    ...view.items.map((r, i) => ({ r, position: view.ranked ? i + 1 : null })),
    ...retained.map((r) => ({ r, position: null })),
  ];
  if (view.items.length === 0 && retained.length === 0)
    return (
      <EmptyState
        title="No recommendations"
        description="The analyst has not proposed anything for this period, or every recommendation was decided."
      />
    );
  return (
    <>
      {view.items.length === 0 && (
        <p className="text-sm text-muted-foreground">No recommendations are waiting for a decision.</p>
      )}
      <ul className="flex flex-col gap-6" aria-label="Recommendations">
        {/* One keyed array: a card moving from waiting to decided keeps its state (and its outcome). */}
        {rows.map(({ r, position }) => (
          <RecommendationCard
            key={r.id}
            companyId={companyId}
            brandId={brandId}
            recommendation={r}
            position={position}
            evidence={r.insightIds.flatMap((id) => evidence.get(id) ?? [])}
            onDecided={remember}
          />
        ))}
      </ul>
    </>
  );
}

interface Analysis {
  run: AnalystRunDto;
  /** The "What changed" freshness before the run: the output has arrived once this changes. */
  asOfBefore: string | null;
}

/**
 * Spec 16.3 on demand: the person picks the analyst principal from those granted the brand (UX-08, as the run
 * form; never an id, RA-07) and sees what the run is held to; the workflow writes insights when it completes.
 */
export function AnalyseNowForm({
  brandId,
  onStarted,
  defaultPeriodDays = 7,
}: {
  brandId: string;
  onStarted: (run: AnalystRunDto) => void;
  /** The review window the form starts with (Performance passes its own period). */
  defaultPeriodDays?: number;
}) {
  const trpc = useTRPC();
  const intent = useIntentKey();
  const principals = useAgentPrincipals(brandId);
  const [principalId, setPrincipalId] = useState('');
  const [periodDays, setPeriodDays] = useState(String(defaultPeriodDays));
  const run = useMutation(
    trpc.intelligence.analyst.run.mutationOptions({
      ...mutationIntent(intent.key),
      onSuccess: (res) => {
        intent.renew();
        onStarted(res);
      },
    }),
  );
  const principal = principals.items.find((p) => p.id === principalId) ?? null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const days = Number(periodDays);
    if (!principal || !Number.isInteger(days) || days < 1) return;
    run.mutate({ brandId, servicePrincipalId: principal.id, periodDays: days });
  };
  const ui = run.isError ? toUiError(run.error) : null;
  const denial = ui ? denialOf(ui) : null;
  const forbidden = principals.isError && toUiError(principals.error).kind === 'forbidden';
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      {principals.isPending && <Skeleton label="Loading agent principals" lines={1} />}
      {forbidden && (
        <StatusBanner
          tone="critical"
          title="Permission denied"
          description={`${toUiError(principals.error).message} Running the analyst needs the agent.start_run permission for this brand.`}
          data-testid="analyse-denied"
        />
      )}
      {principals.isError && !forbidden && (
        <RequestError error={principals.error} onRetry={() => void principals.refetch()} />
      )}
      {principals.isSuccess && principals.items.length === 0 && (
        <StatusBanner
          tone="warning"
          title="No agent principal is granted this brand"
          description="An owner or admin creates one under Settings → Members and mandates with grants for this brand; the analyst runs under a principal's grants and autonomy ceiling."
          data-testid="analyse-no-principals"
        />
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        {principals.isSuccess && principals.items.length > 0 && (
          <Field
            label="Analyst principal"
            htmlFor="analyse-principal"
            hint={
              principal
                ? `Ceiling ${principal.maxAutonomy.replace(/_/g, ' ')}; acts on this brand with ${principal.actions.join(', ')}.`
                : 'The agent identity the analysis runs as; its grants and autonomy ceiling bound the run.'
            }
            error={ui?.details.find((d) => d.path === 'servicePrincipalId')?.issue}
          >
            <Select
              id="analyse-principal"
              value={principalId}
              onValueChange={setPrincipalId}
              placeholder="Choose a principal"
              options={principals.items.map((p) => ({
                value: p.id,
                label: `${p.name} · up to ${p.maxAutonomy.replace(/_/g, ' ')}`,
              }))}
            />
          </Field>
        )}
        <Field label="Period (days)" htmlFor="analyse-days">
          <Input
            id="analyse-days"
            type="number"
            min={1}
            max={90}
            value={periodDays}
            onChange={(e) => setPeriodDays(e.target.value)}
            className="w-24"
          />
        </Field>
      </div>
      <EffectiveLimits
        brandId={brandId}
        servicePrincipalId={principal?.id ?? null}
        taskKind="performance_review"
        requestedAutonomy="create"
      />
      {denial && (
        <StatusBanner
          tone="critical"
          title={denial.title}
          description={
            ui?.code === 'FORBIDDEN'
              ? `${denial.description} Running the analyst needs insight.manage for this brand and the brand analyst enabled for the company.`
              : denial.description
          }
          data-testid="analyse-denied"
        />
      )}
      {ui && !denial && <RequestError error={run.error} title="The analysis did not start" />}
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={run.isPending || !principal}
          disabledReason={principal ? undefined : 'Choose the analyst principal first'}
        >
          {run.isPending ? 'Starting…' : 'Analyse now'}
        </Button>
      </div>
    </form>
  );
}

function WhatChanged({ view, brandId }: { view: WorkspaceDto['whatChanged']; brandId: string }) {
  const anomalies = useAnomalies(brandId);
  const gaps = hasCoverageGaps(view.items);
  return (
    <div className="flex flex-col gap-6" data-testid="what-changed">
      {view.coverage.statement && <Statement>{view.coverage.statement}.</Statement>}
      <Section id="movements-heading" title="Movements">
        {view.items.length === 0 ? (
          <EmptyState
            title="No data yet"
            description="No analysis has run for this brand. Run the analyst once metric snapshots exist; until then nothing is shown and nothing is estimated."
          />
        ) : (
          <InsightRows items={view.items} label="Movements" emptyText="" />
        )}
      </Section>
      <Section id="anomalies-heading" title="Anomalies & data gaps" testId="anomalies">
        <ul className="divide-y divide-border" aria-label="Anomalies and data gaps">
          {gaps && (
            <li className="py-2.5 text-sm" data-testid="coverage-partial">
              <span className="sr-only">{toneGlyph.warning} </span>Coverage is partial.{' '}
              <span className="text-muted-foreground">
                Some snapshots are missing for the period; they are reported as gaps, never counted as zero.
              </span>
            </li>
          )}
          {anomalies.data?.items.map((a) => {
            const sev = severityChip(a.severity);
            return (
              <li key={a.id} className="py-2.5 text-sm" data-testid="anomaly">
                {anomalyText(a)}.{' '}
                <span className="text-muted-foreground">
                  {sev.label} · {a.state} · detected {new Date(a.detectedAt).toLocaleString()}
                </span>
              </li>
            );
          })}
        </ul>
        {anomalies.isPending && <Skeleton label="Loading anomalies" />}
        {anomalies.isError && (
          <RequestError error={anomalies.error} onRetry={() => void anomalies.refetch()} />
        )}
        {anomalies.data && anomalies.data.items.length === 0 && !gaps && (
          <p className="py-2.5 text-sm text-muted-foreground">No anomalies or data gaps recorded.</p>
        )}
      </Section>
    </div>
  );
}

/** The interface's groups, strongest first; observations and hypotheses are never findings (spec 16.3). */
function WhatWeLearned({ view }: { view: WorkspaceDto['whatWeLearned'] }) {
  return (
    <div className="flex flex-col gap-6" data-testid="what-we-learned">
      <Statement>{view.statement}.</Statement>
      <Section id="findings-heading" title="Experimentally supported" testId="findings">
        <InsightRows
          items={view.experimentallySupported}
          label="Findings"
          emptyText="No experimentally supported findings yet. Only a sound randomised experiment can add one."
        />
      </Section>
      <Section id="directional-heading" title="Directional">
        <InsightRows
          items={view.directional}
          label="Directional findings"
          emptyText="No directional results yet."
        />
      </Section>
      <Section id="hypotheses-heading" title="Observations and hypotheses — not findings">
        <InsightRows
          items={view.observations}
          label="Hypotheses"
          emptyText="No observations or hypotheses yet."
        />
      </Section>
    </div>
  );
}

/** Comment themes (spec 16.5): counts and dates only, never an author; replying happens in the Inbox. */
function CustomerVoice({ companyId, brandId }: { companyId: string; brandId: string }) {
  const clusters = useVoiceClusters(brandId);
  return (
    <section aria-labelledby="voice-heading" className="flex flex-col gap-6" data-testid="voice">
      <h2 id="voice-heading" className="sr-only">
        Customer voice
      </h2>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Statement>
          Themes from comments, by kind, with counts. Author identities are never shown here; social
          discussion is not a representative measure of market demand.
        </Statement>
        <Link
          to={brandPath(companyId, brandId, 'inbox')}
          className="inline-flex min-h-6 items-center text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Reply in the Inbox <span aria-hidden="true">&nbsp;→</span>
        </Link>
      </div>
      {clusters.isPending && <Skeleton label="Loading customer voice" />}
      {clusters.isError && <RequestError error={clusters.error} onRetry={() => void clusters.refetch()} />}
      {clusters.data && clusters.data.items.length === 0 && (
        <p className="border-t border-border py-3.5 text-sm text-muted-foreground">No themes yet.</p>
      )}
      {clusters.data && clusters.data.items.length > 0 && (
        <ul className="flex flex-col" aria-label="Customer voice clusters">
          {clusters.data.items.map((c) => {
            const kind = clusterKindChip(c.kind);
            const linked = c.linkedRecommendationIds.length;
            return (
              <li
                key={c.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-border py-3.5 sm:grid-cols-[minmax(0,1fr)_90px_90px]"
                data-testid="cluster"
              >
                <span className="col-span-2 flex min-w-0 flex-col gap-0.5 sm:col-span-1">
                  <span className="text-base font-bold">{c.label}</span>
                  <span className="text-xs text-muted-foreground">
                    First seen {new Date(c.firstSeen).toLocaleDateString()} · last seen{' '}
                    {new Date(c.lastSeen).toLocaleString()} · {c.sampleMessageRefs.length} sample
                    {c.sampleMessageRefs.length === 1 ? '' : 's'}
                    {linked > 0 && ` · ${linked} linked recommendation${linked === 1 ? '' : 's'}`}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">{kind.label}</span>
                <span className="text-right text-xs tabular-nums">
                  {c.size} message{c.size === 1 ? '' : 's'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Every experiment of the brand on one ruled row: name, mode, and its verdict or where it is in its lifecycle. */
function ExperimentsView({
  companyId,
  brandId,
  view,
}: {
  companyId: string;
  brandId: string;
  view: WorkspaceDto['experiments'];
}) {
  const rows = EXPERIMENT_GROUPS.flatMap((g) => view[g]);
  return (
    <section
      aria-labelledby="experiments-heading"
      className="flex flex-col gap-6"
      data-testid="experiments-view"
    >
      <h2 id="experiments-heading" className="sr-only">
        Experiments
      </h2>
      <Statement>{view.statement}.</Statement>
      {rows.length === 0 ? (
        <p className="border-t border-border py-3.5 text-sm text-muted-foreground">
          No experiments yet. Accept a recommendation that prepares a test, or design one under{' '}
          <Link
            to={brandPath(companyId, brandId, 'experiments')}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Experiments
          </Link>
          .
        </p>
      ) : (
        <ul className="flex flex-col" aria-label="Experiments">
          {rows.map((x) => {
            const chip = workspaceExperimentChip(x);
            return (
              <li key={x.id} className="border-t border-border">
                <Link
                  to={brandPath(companyId, brandId, `experiments?experiment=${encodeURIComponent(x.id)}`)}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-3.5 text-sm hover:text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_160px_120px]"
                >
                  <span className="col-span-2 font-medium sm:col-span-1">{x.hypothesis}</span>
                  <span className="text-muted-foreground">{modeLabel(x.mode)}</span>
                  <span className="flex items-center gap-1.5">
                    <StatusDot tone={chip.tone} size="sm" />
                    <span className="sr-only">{toneGlyph[chip.tone]} </span>
                    {chip.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Spec 21.1 `intelligence/`: the views of spec 16.9 as the interface sets them: a 960 px column with the heading
 * (ranked against the objective, learned from this brand's data only), the freshness and coverage strip, a row of
 * tabs on one rule, and the selected view under it. The selected view is in the URL. The analyst is started from a
 * side sheet so the views stay first on the page.
 */
export function IntelligenceWorkspaceScreen() {
  const { companyId, brandId, brand } = useBrandContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const raw = params.get(VIEW_PARAM);
  const view: View = (VIEWS as readonly string[]).includes(raw ?? '') ? (raw as View) : DEFAULT_VIEW;
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const workspace = useWorkspace(brandId, analysis !== null);
  const companies = useCompanies();
  const role = companies.data?.find((c) => c.tenantId === companyId)?.role ?? null;
  const ws = workspace.data;
  const asOf = ws?.whatChanged.freshness.asOf;
  const analysing = analysis !== null && ws !== undefined && asOf === analysis.asOfBefore;
  // The run is over for this screen once the "What changed" view carries newer input than before it started.
  useEffect(() => {
    if (analysis !== null && ws !== undefined && asOf !== analysis.asOfBefore) setAnalysis(null);
  }, [analysis, ws, asOf]);
  const systemHref = brandPath(companyId, brandId, 'system');
  const [analystOpen, setAnalystOpen] = useState(false);
  const insights = ws
    ? [
        ...ws.whatChanged.items,
        ...ws.whatWeLearned.observations,
        ...ws.whatWeLearned.directional,
        ...ws.whatWeLearned.experimentallySupported,
      ]
    : [];
  const evidence = new Map(insights.map((i) => [i.id, i.statement]));
  const freshness = ws
    ? {
        changed: ws.whatChanged.freshness,
        learned: ws.whatWeLearned.freshness,
        next: ws.whatToDoNext.freshness,
        // Comment themes carry their own dates; the strip shows the analysis behind the workspace.
        voice: ws.whatChanged.freshness,
        experiments: ws.experiments.freshness,
        playbook: ws.brandPlaybook.freshness,
      }[view]
    : null;

  return (
    <main
      id="main"
      className="om-in mx-auto flex w-full max-w-[960px] flex-col gap-6 px-4 py-8 sm:px-10 sm:pb-20 sm:pt-10"
    >
      <PageHeader
        title="Intelligence"
        description={
          <>
            {ws?.objective ? (
              <>
                Ranked against{' '}
                <span className="text-foreground">{ws.objective.primaryMetricKey.replace(/_/g, ' ')}</span>
              </>
            ) : (
              'No objective set'
            )}{' '}
            · learned from {brand.name}’s data only
          </>
        }
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => void queryClient.invalidateQueries(trpc.intelligence.pathFilter())}
              disabled={workspace.isFetching}
            >
              {workspace.isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
            {ws && (
              <Drawer open={analystOpen} onOpenChange={setAnalystOpen}>
                <DrawerTrigger asChild>
                  <Button>Run brand analyst now</Button>
                </DrawerTrigger>
                <DrawerContent
                  title="Run the brand analyst"
                  side="right"
                  className="w-[min(92vw,26rem)] overflow-y-auto p-5"
                >
                  <div id="analyse-now" className="flex flex-col gap-4">
                    <p className="text-sm text-muted-foreground">
                      Reviews the period’s metric snapshots and comments and writes insights and
                      recommendations. The views refresh when they land.
                    </p>
                    <AnalyseNowForm
                      brandId={brandId}
                      onStarted={(run) => {
                        setAnalysis({ run, asOfBefore: ws.whatChanged.freshness.asOf });
                        setAnalystOpen(false);
                      }}
                    />
                  </div>
                </DrawerContent>
              </Drawer>
            )}
          </>
        }
      />
      {workspace.isPending && <Skeleton label="Loading intelligence workspace" lines={4} />}
      {workspace.isError && (
        <RequestError
          error={workspace.error}
          onRetry={() => void workspace.refetch()}
          title={toUiError(workspace.error).kind === 'forbidden' ? 'Permission denied' : undefined}
        />
      )}
      {ws && freshness && (
        <>
          <FreshnessLine freshness={freshness} coverage={ws.whatChanged.coverage} />
          {ws.objective === null && (
            <StatusBanner
              tone="warning"
              title="No objective set: recommendations are not ranked"
              description={ws.whatToDoNext.statement}
              actions={
                <Button size="sm" asChild>
                  <Link to={systemHref}>Set an objective</Link>
                </Button>
              }
              data-testid="no-objective"
            />
          )}
          {analysing && analysis && (
            <StatusBanner
              tone="info"
              busy
              title="Analysis running"
              description={`Workflow ${analysis.run.workflowId} reviews ${new Date(analysis.run.periodStart).toLocaleDateString()} to ${new Date(analysis.run.periodEnd).toLocaleDateString()}. The views refresh when its insights land.`}
              data-testid="analysis-running"
            />
          )}
          <Tabs
            value={view}
            onValueChange={(v) => setParams({ [VIEW_PARAM]: v }, { replace: true })}
            className="flex flex-col gap-6"
          >
            <TabList label="Intelligence views">
              {VIEWS.map((v) => (
                <Tab key={v} value={v}>
                  {VIEW_LABEL[v]}
                </Tab>
              ))}
            </TabList>
            <TabPanel value="changed">
              <WhatChanged view={ws.whatChanged} brandId={brandId} />
            </TabPanel>
            <TabPanel value="learned">
              <WhatWeLearned view={ws.whatWeLearned} />
            </TabPanel>
            <TabPanel value="next">
              <section
                aria-labelledby="next-heading"
                className="flex flex-col gap-6"
                data-testid="what-to-do-next"
              >
                <h2 id="next-heading" className="sr-only">
                  What to do next
                </h2>
                <Statement>
                  {ws.whatToDoNext.ranked
                    ? `${ws.whatToDoNext.statement}. Ranking policy: ${ws.whatToDoNext.rankingPolicy}.`
                    : 'Unranked list.'}
                </Statement>
                <RecommendationList
                  companyId={companyId}
                  brandId={brandId}
                  view={ws.whatToDoNext}
                  evidence={evidence}
                />
              </section>
            </TabPanel>
            <TabPanel value="voice">
              <CustomerVoice companyId={companyId} brandId={brandId} />
            </TabPanel>
            <TabPanel value="experiments">
              <ExperimentsView companyId={companyId} brandId={brandId} view={ws.experiments} />
            </TabPanel>
            <TabPanel value="playbook">
              <PlaybookPanel
                brandId={brandId}
                view={ws.brandPlaybook}
                insights={insights}
                canApprove={canApprovePlaybook(role)}
              />
            </TabPanel>
          </Tabs>
        </>
      )}
    </main>
  );
}
