import type {
  AgentActivitiesV1,
  ModelActivitiesV1,
  PlanNextStepResultV1,
  ToolResult,
} from '@oremedia/contracts/agents';
import type {
  BrandAssistActivitiesV1,
  BrandAssistPlanV1,
  BrandAssistPrepareResultV1,
  BrandSourceCaptureActivitiesV1,
  BrandSourceExtractActivitiesV1,
} from '@oremedia/contracts/brand-assist';
import type { StudioGenerationActivitiesV1 } from '@oremedia/contracts/generation';
import type { SkillEvaluationActivitiesV1 } from '@oremedia/contracts/skills';
import type { StudioVideoJobActivitiesV1 } from '@oremedia/contracts/video-ai';
import { ApplicationFailure } from '@temporalio/common';
import { gate, next, nonRetryable, tenant, type Recorder, type RecordingCase } from './types';

/**
 * Task queue `agents` (worker-core): agent runs, skill evaluations, brand assist (capture on `ingest-metrics`,
 * extraction on `media`), studio generation and studio video AI jobs, and their signal relays. Each case is one
 * representative execution; see ./types.ts.
 */

// ---- agentRunWorkflowV1 ----
interface AgentScript {
  plans?: PlanNextStepResultV1[];
  tool?: ToolResult;
  reserveFails?: boolean;
}
const agent = (rec: Recorder, s: AgentScript) => {
  const plans = [
    ...(s.plans ?? [
      {
        kind: 'tool_calls' as const,
        stepId: 'step_replay_1',
        toolCalls: [{ id: 'call_replay_1', name: 'brand.read', arguments: { brandId: 'brd_replay_1' } }],
      },
      { kind: 'done' as const, stepId: 'step_replay_2', reason: 'complete' },
    ]),
  ];
  const acts: AgentActivitiesV1 = {
    resolveContextSnapshot: async () => ({
      hash: 'ctx_replay_hash',
      autonomyMode: 'assist',
      allowedTools: ['brand.read', 'creative.propose'],
      budget: {
        maxSteps: 4,
        maxTokens: 20_000,
        maxCostMicros: 500_000,
        maxVariants: 3,
        deadlineSeconds: 600,
      },
      skillVersionIds: ['skv_replay_1'],
      findings: 0,
    }),
    reserveBudget: async () => {
      if (s.reserveFails) throw nonRetryable('BudgetExhausted');
      return { reservationId: 'res_replay_1', reservedMicros: 500_000 };
    },
    dispatchTool: async () => s.tool ?? { kind: 'ok', output: { name: 'Replay brand' } },
    recordDecision: async () => undefined,
    finishRun: async (i) => ({
      runId: i.runId,
      state: i.state === 'waiting_expired' ? 'failed' : i.state,
      costMicros: 1200,
    }),
    settleBudget: async () => undefined,
  };
  const model: ModelActivitiesV1 = {
    planNextStep: async () => next(plans),
  };
  return { agents: { ...rec(acts), ...rec(model) } };
};
const proposal: AgentScript = {
  tool: { kind: 'proposal_requires_user', stepId: 'step_replay_1', proposalRef: 'prop_replay_1' },
};
const agentInput = (n: number) => ({
  ...tenant(1, `corr_replay_run_${n}`),
  runId: `run_replay_${n}`,
  brandId: 'brd_replay_1',
});
const agentCase = (
  name: string,
  description: string,
  script: AgentScript,
  n: number,
  extra: Partial<RecordingCase> = {},
): RecordingCase => ({
  workflowType: 'agentRunWorkflowV1',
  name,
  description,
  queue: 'agents',
  activities: (rec) => agent(rec, script),
  args: [agentInput(n)],
  workflowId: `run:run_replay_${n}`,
  state: 'completed',
  ...extra,
});
const agentRelayTarget =
  (n: number): RecordingCase['before'] =>
  async (ctx) => {
    const target = await ctx.start('agentRunWorkflowV1', [agentInput(n)], `run:run_replay_${n}`);
    await ctx.untilEvent(target, 'TIMER_STARTED');
  };

// ---- brandAssistWorkflowV1 ----
interface AssistScript {
  plan?: Partial<BrandAssistPlanV1>;
  prepared?: BrandAssistPrepareResultV1;
  captureFails?: boolean;
  sectionFails?: boolean;
  /** The capture waits for this gate (a cancel lands while it runs). */
  captureGate?: ReturnType<typeof gate>;
}
const assist = (rec: Recorder, s: AssistScript) => {
  const control: BrandAssistActivitiesV1 = {
    beginBrandAssist: async () => ({
      outcome: 'run',
      reason: null,
      urlSourceIds: ['src_replay_1'],
      documentSourceIds: ['src_replay_2'],
      sections: ['voice', 'messaging'],
      ...s.plan,
    }),
    markBrandAssistStage: async () => undefined,
    recordBrandSourceFailure: async () => undefined,
    prepareBrandAssistProposals: async () =>
      s.prepared ?? { outcome: 'run', reason: null, sections: ['voice', 'messaging'] },
    proposeBrandAssistSection: async (i) => {
      if (s.sectionFails && i.section === 'voice') throw nonRetryable('BudgetExhausted');
      return { section: i.section, outcome: 'ready', suggestions: 3, reason: null };
    },
    recordBrandAssistSectionFailure: async () => undefined,
    finishBrandAssist: async (i) => ({
      state: i.cancelled ? 'cancelled' : i.failure ? 'failed' : 'ready',
      suggestions: 6,
    }),
  };
  const capture: BrandSourceCaptureActivitiesV1 = {
    captureBrandSourceUrl: async (i) => {
      if (s.captureGate) await s.captureGate.wait();
      if (s.captureFails) throw nonRetryable('ValidationFailed', 'blocked address (replay fixture)');
      return { sourceId: i.sourceId, status: 'captured', reason: null };
    },
  };
  const extract: BrandSourceExtractActivitiesV1 = {
    extractBrandSourceDocument: async (i) => ({ sourceId: i.sourceId, status: 'captured', reason: null }),
  };
  return { agents: rec(control), 'ingest-metrics': rec(capture), media: rec(extract) };
};
const assistInput = (n: number) => ({
  ...tenant(1, `corr_replay_assist_${n}`),
  brandId: 'brd_replay_1',
  jobId: `baj_replay_${n}`,
});
const assistCase = (
  name: string,
  description: string,
  script: AssistScript,
  n: number,
  extra: Partial<RecordingCase> = {},
): RecordingCase => ({
  workflowType: 'brandAssistWorkflowV1',
  name,
  description,
  queue: 'agents',
  activities: (rec) => assist(rec, script),
  args: [assistInput(n)],
  workflowId: `brand-assist:baj_replay_${n}`,
  state: 'completed',
  ...extra,
});

// ---- studioGenerationWorkflowV1 / studioVideoJobWorkflowV1 (the same four-step shape) ----
interface JobScript {
  begin?: { proceed: true } | { proceed: false; reason: 'cancelled' | 'finished' };
  /** A failure thrown by the named step (its type decides the failure code). */
  fail?: { step: 'begin' | 'reserve' | 'model' | 'save'; error: () => Error; times?: number };
  modelGate?: ReturnType<typeof gate>;
}
const proceed = { proceed: true } as const;
function jobSteps(s: JobScript) {
  let failures = 0;
  const step = async (name: 'begin' | 'reserve' | 'model' | 'save') => {
    if (name === 'model' && s.modelGate) await s.modelGate.wait();
    if (s.fail?.step === name && failures < (s.fail.times ?? Infinity)) {
      failures += 1;
      throw s.fail.error();
    }
  };
  return step;
}
const generation = (rec: Recorder, s: JobScript) => {
  const step = jobSteps(s);
  const acts: StudioGenerationActivitiesV1 = {
    beginGeneration: async () => (await step('begin'), s.begin ?? proceed),
    reserveGenerationBudget: async () => (await step('reserve'), proceed),
    callGenerationModel: async () => (await step('model'), proceed),
    saveGeneration: async (i) => (await step('save'), { jobId: i.jobId, state: 'completed' }),
    failGeneration: async (i) => ({ jobId: i.jobId, state: 'failed' }),
    settleGenerationBudget: async () => undefined,
  };
  return { agents: rec(acts) };
};
const videoJob = (rec: Recorder, s: JobScript) => {
  const step = jobSteps(s);
  const acts: StudioVideoJobActivitiesV1 = {
    beginVideoJob: async () => (await step('begin'), s.begin ?? proceed),
    reserveVideoJobBudget: async () => (await step('reserve'), proceed),
    callVideoJobModel: async () => (await step('model'), proceed),
    saveVideoJob: async (i) => (await step('save'), { jobId: i.jobId, state: 'completed' }),
    failVideoJob: async (i) => ({ jobId: i.jobId, state: 'failed' }),
    settleVideoJobBudget: async () => undefined,
  };
  return { agents: rec(acts) };
};
const jobInput = (prefix: string, n: number) => ({
  ...tenant(1, `corr_replay_${prefix}_${n}`),
  jobId: `${prefix}_replay_${n}`,
  attempt: 1,
});
const genCase = (
  name: string,
  description: string,
  s: JobScript,
  n: number,
  extra: Partial<RecordingCase> = {},
): RecordingCase => ({
  workflowType: 'studioGenerationWorkflowV1',
  name,
  description,
  queue: 'agents',
  activities: (rec) => generation(rec, s),
  args: [jobInput('gen', n)],
  workflowId: `generation:gen_replay_${n}:1`,
  state: 'completed',
  ...extra,
});
const videoJobCase = (
  name: string,
  description: string,
  s: JobScript,
  n: number,
  extra: Partial<RecordingCase> = {},
): RecordingCase => ({
  workflowType: 'studioVideoJobWorkflowV1',
  name,
  description,
  queue: 'agents',
  activities: (rec) => videoJob(rec, s),
  args: [jobInput('vaj', n)],
  workflowId: `video-ai:vaj_replay_${n}:1`,
  state: 'completed',
  ...extra,
});
/** Signals the job while its model call waits, then lets the call return. */
const cancelDuringModel =
  (signal: string, activity: string, g: ReturnType<typeof gate>): RecordingCase['drive'] =>
  async (h, ctx) => {
    await ctx.untilCall(activity);
    await h.signal(signal);
    await ctx.untilEvent(h, 'WORKFLOW_EXECUTION_SIGNALED');
    g.open();
  };

const genCancelGate = gate();
const genRelayGate = gate();
const videoCancelGate = gate();
const videoRelayGate = gate();
const assistCancelGate = gate();
const assistWorkflowCancelGate = gate();
const assistRelayGate = gate();

export const agentsCases: RecordingCase[] = [
  agentCase(
    'completed',
    'Context, budget, one read tool call, then the model is done: completed and settled.',
    {},
    1,
  ),
  agentCase(
    'proposal-accepted',
    'A tool call needs the user: the run waits (condition timer), the decision signal arrives, it is recorded and the run completes.',
    proposal,
    2,
    {
      drive: async (h, ctx) => {
        await ctx.untilEvent(h, 'TIMER_STARTED');
        await h.signal('proposalDecision', { stepId: 'step_replay_1', decision: 'accept' });
      },
    },
  ),
  agentCase(
    'cancelled-while-waiting',
    'The cancel signal arrives while the run waits for a decision: finished cancelled.',
    proposal,
    3,
    {
      drive: async (h, ctx) => {
        await ctx.untilEvent(h, 'TIMER_STARTED');
        await h.signal('cancelRun');
      },
    },
  ),
  agentCase(
    'waiting-for-decision-open',
    'In flight: the run waits up to 72 hours for the proposal decision.',
    proposal,
    4,
    {
      state: 'open',
    },
  ),
  agentCase(
    'budget-exhausted',
    'The budget reservation fails non-retryably: finished budget_exhausted, settled.',
    { reserveFails: true },
    5,
  ),
  {
    workflowType: 'agentRunSignalRelayV1',
    name: 'relay-decision',
    description: 'The outbox relays a proposal decision to a waiting run (external signal).',
    queue: 'agents',
    activities: (rec) => agent(rec, proposal),
    before: agentRelayTarget(6),
    args: [
      {
        workflowId: 'run:run_replay_6',
        signal: 'proposalDecision',
        decision: { stepId: 'step_replay_1', decision: 'reject' },
      },
    ],
    workflowId: 'agent-signal-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'agentRunSignalRelayV1',
    name: 'relay-cancel',
    description: 'The outbox relays a cancel to a waiting run (external signal).',
    queue: 'agents',
    activities: (rec) => agent(rec, proposal),
    before: agentRelayTarget(7),
    args: [{ workflowId: 'run:run_replay_7', signal: 'cancelRun' }],
    workflowId: 'agent-signal-replay-2',
    state: 'completed',
  },
  {
    workflowType: 'skillEvaluationWorkflowV1',
    name: 'recorded',
    description: 'The evaluation suite runs and its passing result is recorded.',
    queue: 'agents',
    activities: (rec) => ({
      agents: rec<SkillEvaluationActivitiesV1>({
        runSkillEvaluation: async (i) => ({
          outcome: 'recorded',
          skillVersionId: i.skillVersionId,
          suiteId: i.suiteId,
          resultId: 'ser_replay_1',
          passed: true,
          state: 'in_review',
        }),
        failSkillEvaluation: async () => undefined,
      }),
    }),
    args: [
      {
        ...tenant(1),
        skillVersionId: 'skv_replay_1',
        skillId: 'skl_replay_1',
        suiteId: 'sui_replay_1',
        runs: 3,
      },
    ],
    workflowId: 'skill-evaluation:skv_replay_1',
    state: 'completed',
  },
  {
    workflowType: 'skillEvaluationWorkflowV1',
    name: 'failed-recorded',
    description: 'The suite fails non-retryably: the failure is recorded so the version leaves the sandbox.',
    queue: 'agents',
    activities: (rec) => ({
      agents: rec<SkillEvaluationActivitiesV1>({
        runSkillEvaluation: async () => {
          throw nonRetryable('ValidationFailed', 'suite invalid (replay fixture)');
        },
        failSkillEvaluation: async () => undefined,
      }),
    }),
    args: [
      {
        ...tenant(1),
        skillVersionId: 'skv_replay_2',
        skillId: 'skl_replay_1',
        suiteId: 'sui_replay_1',
        runs: 3,
      },
    ],
    workflowId: 'skill-evaluation:skv_replay_2',
    state: 'completed',
  },
  assistCase(
    'full-run',
    'A URL captured on ingest-metrics, a document extracted on media, two sections proposed, finished ready.',
    {},
    1,
  ),
  assistCase(
    'skipped',
    'The job is no longer queued: skipped and finished at once.',
    {
      plan: {
        outcome: 'skipped',
        reason: 'not_queued',
        urlSourceIds: [],
        documentSourceIds: [],
        sections: [],
      },
    },
    2,
  ),
  assistCase(
    'source-and-section-failures',
    'The capture fails (recorded per source) and one section proposal fails (recorded per section); the job still finishes.',
    { captureFails: true, sectionFails: true },
    3,
  ),
  assistCase(
    'prepare-failed',
    'Nothing usable was captured: the proposal step fails and the job finishes failed.',
    {
      prepared: { outcome: 'failed', reason: 'no_sources', sections: [] },
    },
    4,
  ),
  assistCase(
    'cancelled-by-signal',
    'The cancel signal lands during the capture: extraction and proposals are skipped and the job finishes cancelled.',
    { captureGate: assistCancelGate },
    5,
    {
      drive: async (h, ctx) => {
        await ctx.untilCall('captureBrandSourceUrl');
        await h.signal('cancelBrandAssist');
        await ctx.untilEvent(h, 'WORKFLOW_EXECUTION_SIGNALED');
        assistCancelGate.open();
      },
    },
  ),
  assistCase(
    'workflow-cancelled',
    'The workflow itself is cancelled during the capture: the job is finished as cancelled (non-cancellable finish).',
    { captureGate: assistWorkflowCancelGate },
    6,
    {
      drive: async (h, ctx) => {
        await ctx.untilCall('captureBrandSourceUrl');
        await h.cancel();
        await ctx.untilEvent(h, 'WORKFLOW_EXECUTION_CANCEL_REQUESTED');
        await ctx.untilCall('finishBrandAssist');
        assistWorkflowCancelGate.open();
      },
    },
  ),
  {
    workflowType: 'brandAssistSignalRelayV1',
    name: 'relay-cancel',
    description: 'The outbox relays a cancel to a running brand assist job (external signal).',
    queue: 'agents',
    activities: (rec) => assist(rec, { captureGate: assistRelayGate }),
    before: async (ctx) => {
      await ctx.start('brandAssistWorkflowV1', [assistInput(7)], 'brand-assist:baj_replay_7');
      await ctx.untilCall('captureBrandSourceUrl');
    },
    drive: async (h, ctx) => {
      await ctx.untilEvent(h, 'EXTERNAL_WORKFLOW_EXECUTION_SIGNALED');
      assistRelayGate.open();
    },
    args: [{ workflowId: 'brand-assist:baj_replay_7', signal: 'cancelBrandAssist' }],
    workflowId: 'brand-assist-signal-replay-1',
    state: 'completed',
  },
  genCase('saved', 'Begin, reserve, the model call and the save: completed, budget settled.', {}, 1),
  genCase(
    'stopped-at-begin',
    'The job already finished elsewhere: begin says stop; nothing else runs but the settle.',
    {
      begin: { proceed: false, reason: 'finished' },
    },
    2,
  ),
  genCase(
    'begin-retried-then-saved',
    'The first begin fails transiently and is retried by the activity policy (2 s), then the job completes.',
    { fail: { step: 'begin', error: () => new Error('database unavailable (replay fixture)'), times: 1 } },
    3,
  ),
  genCase(
    'budget-exhausted',
    'The reservation fails non-retryably (BudgetExhausted): failed with that code, settled.',
    {
      fail: { step: 'reserve', error: () => nonRetryable('BudgetExhausted') },
    },
    4,
  ),
  genCase(
    'model-failed',
    'The model call fails non-retryably: failed with model_failed, settled.',
    {
      fail: {
        step: 'model',
        error: () => ApplicationFailure.nonRetryable('provider refused (replay fixture)', 'ProviderError'),
      },
    },
    5,
  ),
  genCase(
    'cancelled-by-signal',
    'The cancel signal lands during the model call: stopped before the save, settled.',
    { modelGate: genCancelGate },
    6,
    {
      drive: cancelDuringModel('cancelGeneration', 'callGenerationModel', genCancelGate),
    },
  ),
  {
    workflowType: 'studioGenerationSignalRelayV1',
    name: 'relay-cancel',
    description: 'The outbox relays a cancel to a running generation (external signal).',
    queue: 'agents',
    activities: (rec) => generation(rec, { modelGate: genRelayGate }),
    before: async (ctx) => {
      await ctx.start('studioGenerationWorkflowV1', [jobInput('gen', 7)], 'generation:gen_replay_7:1');
      await ctx.untilCall('callGenerationModel');
    },
    drive: async (h, ctx) => {
      await ctx.untilEvent(h, 'EXTERNAL_WORKFLOW_EXECUTION_SIGNALED');
      genRelayGate.open();
    },
    args: [{ workflowId: 'generation:gen_replay_7:1', signal: 'cancel' }],
    workflowId: 'generation-signal-replay-1',
    state: 'completed',
  },
  videoJobCase('saved', 'Begin, reserve, the model call and the save: completed, budget settled.', {}, 1),
  videoJobCase(
    'validation-failed',
    'The save refuses the proposed operations (ValidationFailed): failed with that code.',
    {
      fail: { step: 'save', error: () => nonRetryable('ValidationFailed') },
    },
    2,
  ),
  videoJobCase(
    'cancelled-by-signal',
    'The cancel signal lands during the model call: stopped before the save, settled.',
    { modelGate: videoCancelGate },
    3,
    {
      drive: cancelDuringModel('cancelVideoJob', 'callVideoJobModel', videoCancelGate),
    },
  ),
  {
    workflowType: 'studioVideoJobSignalRelayV1',
    name: 'relay-cancel',
    description: 'The outbox relays a cancel to a running video AI job (external signal).',
    queue: 'agents',
    activities: (rec) => videoJob(rec, { modelGate: videoRelayGate }),
    before: async (ctx) => {
      await ctx.start('studioVideoJobWorkflowV1', [jobInput('vaj', 4)], 'video-ai:vaj_replay_4:1');
      await ctx.untilCall('callVideoJobModel');
    },
    drive: async (h, ctx) => {
      await ctx.untilEvent(h, 'EXTERNAL_WORKFLOW_EXECUTION_SIGNALED');
      videoRelayGate.open();
    },
    args: [{ workflowId: 'video-ai:vaj_replay_4:1', signal: 'cancel' }],
    workflowId: 'video-ai-signal-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'studioVideoJobSignalRelayV1',
    name: 'target-gone',
    description: 'The job is no longer running: the external signal fails and the relay completes anyway.',
    queue: 'agents',
    activities: () => ({}),
    args: [{ workflowId: 'video-ai:vaj_replay_404:1', signal: 'cancel' }],
    workflowId: 'video-ai-signal-replay-2',
    state: 'completed',
  },
];
