import { z } from 'zod';
import { AutonomyMode } from './tenancy';

export const AgentRunState = z.enum([
  'planned',
  'running',
  'waiting_for_review',
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'waiting_expired',
]);
export type AgentRunState = z.infer<typeof AgentRunState>;

export const Budget = z.object({
  maxSteps: z.number().int().min(1).max(50),
  maxTokens: z.number().int().min(1),
  maxCostMicros: z.number().int().min(0),
  maxVariants: z.number().int().min(1).max(12),
  deadlineSeconds: z.number().int().min(1).max(1800),
});
export type Budget = z.infer<typeof Budget>;

export const AgentRunInput = z.object({
  runId: z.string(),
  tenantId: z.string(),
  brandId: z.string(),
  servicePrincipalId: z.string(),
  initiatorUserId: z.string().optional(),
  requestedAutonomy: AutonomyMode,
  taskKind: z.string(),
  brief: z.record(z.unknown()),
  correlationId: z.string(),
});
export type AgentRunInput = z.infer<typeof AgentRunInput>;

export const AgentRunResult = z.object({
  runId: z.string(),
  state: AgentRunState,
  costMicros: z.number().int(),
});
export type AgentRunResult = z.infer<typeof AgentRunResult>;

export const ProposalDecision = z.object({
  stepId: z.string(),
  decision: z.enum(['accept', 'reject', 'modify']),
  batch: z.unknown().optional(),
});
export type ProposalDecision = z.infer<typeof ProposalDecision>;

export const ModelToolCall = z.object({ id: z.string(), name: z.string(), arguments: z.unknown() });
export type ModelToolCall = z.infer<typeof ModelToolCall>;

export type ToolEffect = 'read' | 'draft' | 'propose' | 'external';

export type ToolResult =
  | { kind: 'ok'; output: unknown }
  | { kind: 'denied'; reason: string }
  | { kind: 'invalid'; issues: Array<{ path?: string; issue: string }> }
  | { kind: 'proposal_requires_user'; stepId: string; proposalRef: string };

export const AgentStepKind = z.enum(['plan', 'model_call', 'tool_call', 'validation']);

/** UX-16: the brand's spend position this month and today, with the ledger by kind (billing.manage). */
export const BudgetRead = z.object({ brandId: z.string() });
/** UX-16: a spend limit for the brand's day or the company's month, in USD micros (billing.manage). */
export const BudgetSetLimit = z.object({
  brandId: z.string(),
  period: z.enum(['day', 'month']),
  limitMicros: z.number().int().min(0),
});

/**
 * The task brief is inlined into the system prompt of every step, so it is bounded: at most 32 KB serialised, not
 * counting `evidence` (each evidence item is bounded and rendered once as an untrusted evidence block).
 */
export const RUN_BRIEF_MAX_BYTES = 32 * 1024;
const serialisedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
export const RunBrief = z.record(z.unknown()).superRefine((brief, ctx) => {
  const { evidence: _evidence, ...rest } = brief;
  if (serialisedBytes(rest) > RUN_BRIEF_MAX_BYTES)
    ctx.addIssue({
      code: 'custom',
      message: `brief_too_large: at most ${RUN_BRIEF_MAX_BYTES} bytes serialised`,
    });
});

export const RunStart = z.object({
  brandId: z.string(),
  servicePrincipalId: z.string(),
  requestedAutonomy: AutonomyMode.default('create'),
  taskKind: z.string(),
  brief: RunBrief,
});

// ---------------------------------------------------------------------------------------------------------------
// Phase 4 agent runtime (spec 12): model adapter contract, context inputs, run workflow contract and router DTOs.
// Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';

/** One part of a conversation turn. Tool results are always strings (JSON) so payloads stay inspectable. */
export const ModelContentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
]);
export type ModelContentPart = z.infer<typeof ModelContentPart>;

export const ModelMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(ModelContentPart).min(1),
});
export type ModelMessage = z.infer<typeof ModelMessage>;

/** Visible model output only: private reasoning blocks are stripped by the adapter and never stored (spec 12.7). */
export const ModelContent = z.object({ type: z.literal('text'), text: z.string() });
export type ModelContent = z.infer<typeof ModelContent>;

/** A tool as the model sees it: name, description and a JSON Schema for its input. */
export const ToolSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(4000),
  inputSchema: z.record(z.unknown()),
});
export type ToolSchema = z.infer<typeof ToolSchema>;

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Spec 12.7 request shape. `metadata` carries opaque ids only; prompts and content are never logged. */
export interface ModelRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs: number;
  metadata: { runId: string; tenantId: string };
  /**
   * Structured output: the answer's JSON Schema, sent to providers that constrain their answer to it. The schema is
   * in strict form (every object closed and every property required; an optional field is nullable). The caller
   * still validates the answer, because a provider or model may not honour it.
   */
  responseSchema?: ModelResponseSchema;
}

/** A named JSON Schema for a model's answer (`name` matches `^[a-zA-Z0-9_-]{1,64}$`, as tool names do). */
export interface ModelResponseSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface ModelCompletion {
  content: ModelContent[];
  toolCalls: ModelToolCall[];
  usage: ModelUsage;
  stopReason: string;
}

/** Retrieved content handed to the model is labelled untrusted and delimited (spec 12.3, 18). */
export const EvidenceSourceKind = z.enum([
  'guideline_document',
  'ocr_text',
  'caption',
  'comment',
  'web_page',
  'asset_metadata',
  'other',
]);
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKind>;

/** Evidence ids are rendered inside the marker line, so they are plain identifiers (no quotes, spaces or newlines). */
export const EVIDENCE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
export const EvidenceItem = z.object({
  id: z.string().regex(EVIDENCE_ID),
  sourceKind: EvidenceSourceKind,
  ref: z.string().max(1000),
  text: z.string().max(20000),
  trust: z.literal('untrusted').default('untrusted'),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

// ---- run workflow contract (agentRunWorkflowV1 on task queue `agents`, workflow id `run:<runId>`) ----

/**
 * Workflow input: references only. Activities re-load the run row, the principal's grants and the context at the
 * point of effect (spec 5.2); the brief never travels through Temporal payloads.
 */
export const AgentRunWorkflowInputV1 = TenantContextInput.extend({
  runId: z.string(),
  brandId: z.string(),
});
export type AgentRunWorkflowInputV1 = z.infer<typeof AgentRunWorkflowInputV1>;

export const AgentRunFinishState = z.enum([
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'waiting_expired',
]);
export type AgentRunFinishState = z.infer<typeof AgentRunFinishState>;

export interface ContextResolveResultV1 {
  hash: string;
  autonomyMode: AutonomyMode;
  allowedTools: string[];
  budget: Budget;
  skillVersionIds: string[];
  findings: number;
}

export type ReserveBudgetInputV1 = AgentRunWorkflowInputV1 & { budget: Budget };
export interface ReserveBudgetResultV1 {
  reservationId: string;
  reservedMicros: number;
}

export type PlanNextStepInputV1 = AgentRunWorkflowInputV1 & { step: number };
export type PlanNextStepResultV1 =
  | { kind: 'done'; stepId: string; reason: string }
  | { kind: 'tool_calls'; stepId: string; toolCalls: ModelToolCall[] };

export type DispatchToolInputV1 = AgentRunWorkflowInputV1 & {
  step: number;
  stepId: string;
  call: ModelToolCall;
};
export type RecordDecisionInputV1 = AgentRunWorkflowInputV1 & { decision: ProposalDecision };
export type FinishRunInputV1 = AgentRunWorkflowInputV1 & { state: AgentRunFinishState };

/** Spec 12.2 `AgentActivities`: every effect of the run lifecycle. */
export interface AgentActivitiesV1 {
  resolveContextSnapshot(input: AgentRunWorkflowInputV1): Promise<ContextResolveResultV1>;
  reserveBudget(input: ReserveBudgetInputV1): Promise<ReserveBudgetResultV1>;
  dispatchTool(input: DispatchToolInputV1): Promise<ToolResult>;
  recordDecision(input: RecordDecisionInputV1): Promise<void>;
  finishRun(input: FinishRunInputV1): Promise<AgentRunResult>;
  settleBudget(input: AgentRunWorkflowInputV1): Promise<void>;
}

/** Spec 12.2 `ModelActivities`: the bounded model call (heartbeats; shorter retry). */
export interface ModelActivitiesV1 {
  planNextStep(input: PlanNextStepInputV1): Promise<PlanNextStepResultV1>;
}

export type AgentRunActivitiesV1 = AgentActivitiesV1 & ModelActivitiesV1;

/** What the activity host hands the runtime: the heartbeat of the current activity, nothing else. */
export interface ActivityHooks {
  heartbeat(detail: string): void;
}

/** The module-side implementation the activities wrap (tenant context is established by the activity host). */
export interface AgentRunRuntimeV1 extends AgentActivitiesV1 {
  planNextStep(input: PlanNextStepInputV1, hooks?: ActivityHooks): Promise<PlanNextStepResultV1>;
}

/** Signals relayed from the outbox to a running agent run (agentRunSignalRelayV1). */
export const AgentRunSignalV1 = z.discriminatedUnion('signal', [
  z.object({ workflowId: z.string(), signal: z.literal('cancelRun') }),
  z.object({ workflowId: z.string(), signal: z.literal('proposalDecision'), decision: ProposalDecision }),
]);
export type AgentRunSignalV1 = z.infer<typeof AgentRunSignalV1>;

// ---- router DTOs (spec 7.5 agents router) ----
export const RunGet = z.object({ runId: z.string() });
/** The brand's runs, newest first (brand.read). */
export const RunList = z.object({ brandId: z.string(), page: PageRequest });
export const RunCancel = z.object({ runId: z.string(), reason: z.string().max(500).optional() });
export const RunSteps = z.object({ runId: z.string(), page: PageRequest });
/** UX-07: the proposals of runs parked in waiting_for_review that target a creative document of the brand. */
export const RunPendingProposals = z.object({ brandId: z.string(), documentId: z.string() });
export const RunApproveProposal = z.object({
  runId: z.string(),
  stepId: z.string(),
  decision: z.enum(['accept', 'reject', 'modify']),
  /** `modify` only: the batch the person applies in place of the proposal (validated by the creative module). */
  batch: z.unknown().optional(),
});
/**
 * RA-07: what a run of `taskKind` under `servicePrincipalId` would be bound by if it started now, as runs.start and
 * the context resolver compute it (autonomy = min(requested, principal, tenant policy, entitlement); budget =
 * min(skill manifests, platform default, month remainder); tools = the skills' allowlists the principal's grants
 * cover). A read for a person who may start runs on the brand (agent.start_run); the server still decides at start.
 */
export const RunEffectiveLimits = z.object({
  brandId: z.string(),
  servicePrincipalId: z.string(),
  taskKind: z.string(),
  requestedAutonomy: AutonomyMode.default('create'),
});
/** Why a start would be refused right now, in the server's own vocabulary (runs.start raises the same conditions). */
export const RunStartBlocker = z.enum([
  'principal_revoked',
  'kill_switch_engaged',
  'model_routing_denied',
  'entitlement_exhausted',
  'no_skill',
  'budget_exhausted_month',
  'budget_exhausted_day',
]);
export type RunStartBlocker = z.infer<typeof RunStartBlocker>;

// ---- tenant model-routing policy (spec 12.7) ----

/** Model vendors a tenant can permit. `fake` is the deterministic test adapter. */
export const ModelVendor = z.enum(['anthropic', 'openrouter', 'fake']);
export type ModelVendor = z.infer<typeof ModelVendor>;

/**
 * Spec 12.7: tenant model-routing policy (permitted vendors, inference regions, denied models), checked before
 * EVERY model call. Stored per tenant as a versioned document (model_routing_policies). Retention and data classes
 * were removed (26 September 2026): nothing enforced them; a stored document that still carries them parses, and
 * the keys are dropped.
 */
export const ModelRoutingPolicy = z.object({
  schemaVersion: z.literal(1),
  /** Recorded only: the model a run uses is deployment configuration (OREMEDIA_MODEL_ID). */
  defaultModel: z.string().min(1).max(120),
  permittedVendors: z.array(ModelVendor).min(1),
  /** Inference regions the tenant permits; [] = any region. Checked against OREMEDIA_MODEL_REGION. */
  permittedRegions: z.array(z.string().min(1).max(40)).default([]),
  deniedModels: z.array(z.string().max(120)).default([]),
});
export type ModelRoutingPolicy = z.infer<typeof ModelRoutingPolicy>;

/** agents.routingPolicy.set: the whole versioned document, with optimistic concurrency. */
export const RoutingPolicySet = z.object({
  policy: ModelRoutingPolicy,
  /** The stored row's version; omitted only when the tenant has no stored policy yet. */
  expectedVersion: z.number().int().min(0).optional(),
  /**
   * The administrator's explicit choice to store a policy that refuses the deployment's model in use (it stops
   * every model call for the company). Without it such a policy is refused with VALIDATION_FAILED
   * `policy: stops_model_in_use`, so the only configured gateway is never excluded silently.
   */
  confirmStopsRuns: z.boolean().optional(),
});
