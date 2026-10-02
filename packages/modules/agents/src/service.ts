import { z } from 'zod';
import {
  BudgetRead,
  BudgetSetLimit,
  ModelRoutingPolicy,
  RoutingPolicySet,
  RunApproveProposal,
  RunCancel,
  RunEffectiveLimits,
  RunGet,
  RunList,
  RunPendingProposals,
  RunStart,
  RunSteps,
  type AgentRunState,
  type Budget,
  type RunStartBlocker,
} from '@oremedia/contracts/agents';
import { OperationBatch } from '@oremedia/contracts/creative';
import {
  BudgetExhaustedError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { TaskKind } from '@oremedia/contracts/skills';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { requireTenant, type Tx } from '@oremedia/db';
import { effectiveAutonomy } from '@oremedia/domain/autonomy';
import { newId } from '@oremedia/domain/ids';
import { agentRunMachine, type AgentRunEvent } from '@oremedia/domain/state-machines/agent-run';
import { IllegalTransitionError } from '@oremedia/domain/state-machines/machine';
import {
  applyProposalBatch,
  assertRoutingAllowed,
  CreativeProposalPayload,
  PersonCompletedProposal,
  RELEASE_1_TOOLS,
  entitlementAutonomy,
  modelConfigFromEnv,
  modelRegion,
  resolveBudget,
  resolveSkills,
  tenantPolicyFor,
  type ModelConfig,
} from '@oremedia/ai';
import { policy, ServicePrincipalRepository } from '@oremedia/module-access';
import { budgets, entitlements } from '@oremedia/module-billing';
import { brandService, type OnboardingRunSource } from '@oremedia/module-brand';
import { audit, killSwitch, outbox } from '@oremedia/module-operations';
import { runWorkflowId } from './outbox-routes';
import {
  AgentRunRepository,
  AgentStepRepository,
  ModelRoutingPolicyRepository,
  ToolInvocationRepository,
} from './repositories';

const runsRepo = new AgentRunRepository();
const routingPoliciesRepo = new ModelRoutingPolicyRepository();
const stepsRepo = new AgentStepRepository();
const invocationsRepo = new ToolInvocationRepository();
const principalsRepo = new ServicePrincipalRepository();

type RunRow = Awaited<ReturnType<typeof runsRepo.getById>>;

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const tenantResource = (tenantId: string) => ({ type: 'tenant', tenantId, id: tenantId });

const brandResource = (run: RunRow) => ({
  type: 'agent_run',
  tenantId: run.tenantId,
  brandId: run.brandId,
  id: run.id,
});

/** The initial deadline before the context resolver tightens it to the skill budget (spec 10.1 max 1800 s). */
const INITIAL_DEADLINE_SECONDS = 1800;

/** Model configuration is read once per process from the environment (Appendix A names). */
let modelConfig: ModelConfig | null = null;
const currentModelConfig = (): ModelConfig => (modelConfig ??= modelConfigFromEnv());
/** Test seam / composition: pin the configuration explicitly. */
export const configureAgentModel = (cfg: ModelConfig | null): void => {
  modelConfig = cfg;
};

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
function transition(from: AgentRunState, event: AgentRunEvent, path: string): AgentRunState {
  try {
    return agentRunMachine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

/** Parked runs read for a document's proposals (newest first): a brand rarely has more than a few awaiting a person. */
const PARKED_RUNS_MAX = 200;

const toRunDto = (r: RunRow) => ({
  id: r.id,
  brandId: r.brandId,
  state: r.state,
  taskKind: r.taskKind,
  autonomyMode: r.autonomyMode,
  servicePrincipalId: r.servicePrincipalId,
  initiatorKind: r.initiatorKind,
  initiatorId: r.initiatorId,
  brief: r.brief,
  contextSnapshotHash: r.contextSnapshotHash,
  skillVersionIds: r.skillVersionIds,
  modelConfig: r.modelConfig,
  budgetReservationId: r.budgetReservationId,
  costMicros: r.costMicros,
  deadlineAt: r.deadlineAt.toISOString(),
  workflowId: r.workflowId,
  correlationId: r.correlationId,
  finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  version: r.version,
});

/** Task kinds whose runs only their owning command starts (see runs.start). */
const COMMAND_ONLY_TASK_KINDS: ReadonlySet<string> = new Set(['brand_onboarding']);

/** Starts a run of any task kind: policy, kill switch, entitlement, principal, autonomy, routing, row, audit, outbox. */
async function startRun(
  actor: ResolvedActor,
  input: z.infer<typeof RunStart>,
  tx: Tx,
  opts: { autonomyMode?: AutonomyMode } = {},
) {
  const parsed = RunStart.parse(input);
  const taskKind = TaskKind.safeParse(parsed.taskKind);
  if (!taskKind.success)
    throw new ValidationFailedError([{ path: 'taskKind', issue: `unknown task kind ${parsed.taskKind}` }]);
  const { tenantId, correlationId } = requireTenant();
  await brandService.assertExist([parsed.brandId], tx); // NOT_FOUND for a foreign brand
  // A service principal that starts runs on a schedule (the brand analyst) does so under its own ceiling.
  await policy.assert(
    actor,
    'agent.start_run',
    { type: 'brand', tenantId, brandId: parsed.brandId, id: parsed.brandId },
    opts,
    tx,
  );
  if (await killSwitch.isOn('agent_starts', parsed.brandId, tx))
    throw new PolicyDeniedError('kill_switch_engaged', 'Agent starts are paused for this brand');
  await entitlements.assert(tenantId, 'generation_budget_micros_month', tx);
  const principal = await principalsRepo.getById(parsed.servicePrincipalId, tx); // NOT_FOUND for a foreign principal
  if (principal.status !== 'active')
    throw new ValidationFailedError([{ path: 'servicePrincipalId', issue: 'revoked' }]);
  const [tenantPolicy, ent] = await Promise.all([
    tenantPolicyFor(tenantId, correlationId, tx),
    entitlements.resolve(tenantId, tx),
  ]);
  const autonomyMode = effectiveAutonomy(
    parsed.requestedAutonomy,
    principal.maxAutonomy,
    tenantPolicy.maxAutonomy,
    entitlementAutonomy(ent),
  );
  const cfg = currentModelConfig();
  await assertRoutingAllowed(tenantId, cfg.provider, cfg.model);
  // RA-07: effectiveLimits names a missing skill as a blocker (after the principal, kill switch, routing and
  // entitlement ones, the order kept here), so the start refuses the same condition rather than creating a run
  // the workflow would resolve to no skill, no tools and the platform's default budget. A command-only kind
  // (onboarding) starts from its own command with its own skill handling.
  if (!COMMAND_ONLY_TASK_KINDS.has(taskKind.data)) {
    const skills = await resolveSkills(
      { tenantId, brandId: parsed.brandId, taskKind: taskKind.data, actor },
      tx,
    );
    if (skills.length === 0)
      throw new ValidationFailedError(
        [{ path: 'taskKind', issue: 'no_skill' }],
        'No published skill serves this task kind for the brand',
      );
  }
  const id = newId('agentRun');
  const workflowId = runWorkflowId(id);
  await runsRepo.create(
    {
      id,
      brandId: parsed.brandId,
      initiatorKind: actor.kind === 'user' ? 'user' : 'system',
      initiatorId: actor.id,
      servicePrincipalId: principal.id,
      autonomyMode,
      taskKind: taskKind.data,
      brief: parsed.brief,
      contextSnapshotHash: null,
      skillVersionIds: [],
      modelConfig: { provider: cfg.provider, model: cfg.model },
      state: 'planned',
      budgetReservationId: null,
      costMicros: 0,
      deadlineAt: new Date(Date.now() + INITIAL_DEADLINE_SECONDS * 1000),
      workflowId,
      correlationId,
    },
    tx,
  );
  await audit.record(actorRef(actor), 'agent.run.request', { type: 'agent_run', id }, 'allowed', tx, {
    brandId: parsed.brandId,
    runId: id,
    toState: 'planned',
  });
  await outbox.add(
    'agent.run_requested',
    { type: 'agent_run', id, version: 0 },
    {
      runId: id,
      brandId: parsed.brandId,
      servicePrincipalId: principal.id,
      initiatorKind: actor.kind,
      initiatorId: actor.id,
      taskKind: taskKind.data,
      autonomyMode,
    },
    tx,
    { brandId: parsed.brandId },
  );
  return { runId: id, state: 'planned' as const, autonomyMode, workflowId, version: 0 };
}

/**
 * Spec 7.5 agents router commands. A run is a brand-owned row (NOT_FOUND for a foreign id), starts through the
 * outbox (agent.run_requested → agentRunWorkflowV1 on queue `agents`) and changes state only through
 * agentRunMachine. The model never widens any of this: autonomy is min(requested, principal, tenant, entitlement).
 */
export const agentsService = {
  runs: {
    /**
     * A run of a command-only task kind starts through its owning command, which writes the brief the run's tools
     * later trust (brand_onboarding: brand.onboarding.start, which requires brand.edit_standards on the draft). Here
     * it is refused, so a person who may start runs but not edit standards cannot hand a run a brief of their own.
     */
    async start(
      actor: ResolvedActor,
      input: z.infer<typeof RunStart>,
      tx: Tx,
      opts: { autonomyMode?: AutonomyMode } = {},
    ) {
      if (COMMAND_ONLY_TASK_KINDS.has(input.taskKind))
        throw new ValidationFailedError([
          {
            path: 'taskKind',
            issue: `${input.taskKind} runs start from their own command (brand.onboarding.start)`,
          },
        ]);
      return startRun(actor, input, tx, opts);
    },

    async get(actor: ResolvedActor, input: z.infer<typeof RunGet>, tx?: Tx) {
      const parsed = RunGet.parse(input);
      const run = await runsRepo.getById(parsed.runId, tx);
      await policy.assert(actor, 'brand.read', brandResource(run), {}, tx);
      return toRunDto(run);
    },

    /** The brand's runs newest first (brand.read on the brand, as get on each run); a foreign brand is NOT_FOUND. */
    async list(actor: ResolvedActor, input: z.infer<typeof RunList>, tx?: Tx) {
      const parsed = RunList.parse(input);
      // brandService.get asserts brand.read; a foreign brand is NOT_FOUND.
      const brand = await brandService.get(actor, parsed.brandId, tx);
      const page = await runsRepo.listForBrand(brand.id, parsed.page, tx);
      return { items: page.items.map(toRunDto), nextCursor: page.nextCursor };
    },

    /**
     * UX-07: the creative proposals awaiting a person on a document, so the studio shows the same proposal after a
     * leave and return (it lives on the run, not in the browser). A parked run has one open proposal: its latest.
     * brand.read on the brand (a foreign brand is NOT_FOUND); deciding still needs the tool's own permission.
     */
    async pendingProposals(actor: ResolvedActor, input: z.infer<typeof RunPendingProposals>, tx?: Tx) {
      const parsed = RunPendingProposals.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      const parked = await runsRepo.listInState(brand.id, 'waiting_for_review', PARKED_RUNS_MAX, tx);
      const runIds = parked.map((r) => r.id);
      const proposals = await invocationsRepo.listProposalsForRuns(runIds, tx);
      const decided = await stepsRepo.decidedProposalStepIds(runIds, tx);
      const items: Array<{
        runId: string;
        stepId: string;
        taskKind: string;
        brief: Record<string, unknown>;
        createdAt: string;
        proposal: CreativeProposalPayload;
      }> = [];
      for (const run of parked) {
        const latest = proposals.find((p) => p.runId === run.id);
        // Decided but not yet applied (the run moves once the workflow records the decision): no longer pending.
        if (!latest || decided.has(latest.stepId)) continue;
        const payload = CreativeProposalPayload.safeParse(latest.proposalPayload);
        if (!payload.success || payload.data.documentId !== parsed.documentId) continue;
        items.push({
          runId: run.id,
          stepId: latest.stepId,
          taskKind: run.taskKind,
          brief: run.brief,
          createdAt: latest.createdAt.toISOString(),
          proposal: payload.data,
        });
      }
      return { items };
    },

    /**
     * RA-07: the limits a run would start under, read before it starts so a person never learns them from a
     * refusal. Computed from the same sources as startRun and resolveContextSnapshot (principal ceiling, tenant
     * policy, entitlement, pinned skills' budgets and allowlists, the brand's spend position, the kill switch);
     * nothing is reserved or written. Gated as the principal list is (agent.start_run on the brand); a foreign
     * brand or principal is NOT_FOUND. Every task kind is accepted, including the command-only brand_onboarding
     * that runs.start refuses: the onboarding path (brand.onboarding.start, voice extraction) reads its limits here.
     */
    async effectiveLimits(actor: ResolvedActor, input: z.input<typeof RunEffectiveLimits>, tx?: Tx) {
      const parsed = RunEffectiveLimits.parse(input);
      const taskKind = TaskKind.safeParse(parsed.taskKind);
      if (!taskKind.success)
        throw new ValidationFailedError([
          { path: 'taskKind', issue: `unknown task kind ${parsed.taskKind}` },
        ]);
      const { tenantId, correlationId } = requireTenant();
      await brandService.assertExist([parsed.brandId], tx); // NOT_FOUND for a foreign brand
      await policy.assert(
        actor,
        'agent.start_run',
        { type: 'brand', tenantId, brandId: parsed.brandId, id: parsed.brandId },
        {},
        tx,
      );
      const principal = await principalsRepo.getById(parsed.servicePrincipalId, tx); // NOT_FOUND for a foreign one
      const blockers: Array<{ code: RunStartBlocker; message: string }> = [];
      if (principal.status !== 'active')
        blockers.push({
          code: 'principal_revoked',
          message: 'This principal was revoked; no run starts under it.',
        });
      if (await killSwitch.isOn('agent_starts', parsed.brandId, tx))
        blockers.push({ code: 'kill_switch_engaged', message: 'Agent starts are paused for this brand.' });
      // The model-routing gate startRun applies (spec 12.7): the deployment's model against the tenant's policy.
      try {
        const cfg = currentModelConfig();
        await assertRoutingAllowed(tenantId, cfg.provider, cfg.model);
      } catch (err) {
        if (!(err instanceof PolicyDeniedError)) throw err;
        blockers.push({
          code: 'model_routing_denied',
          message: `${err.message}; an owner or admin changes the model routing policy under Settings.`,
        });
      }
      const entitlement = await entitlements.check(tenantId, 'generation_budget_micros_month', tx);
      if (!entitlement.allowed)
        blockers.push({
          code: 'entitlement_exhausted',
          message: "The plan's generation budget for this month is used up.",
        });
      const ent = await entitlements.resolve(tenantId, tx);
      const tenantPolicy = await tenantPolicyFor(tenantId, correlationId, tx);
      const autonomy = {
        requested: parsed.requestedAutonomy,
        principalMax: principal.maxAutonomy,
        tenantPolicyMax: tenantPolicy.maxAutonomy,
        entitlementMax: entitlementAutonomy(ent),
        effective: effectiveAutonomy(
          parsed.requestedAutonomy,
          principal.maxAutonomy,
          tenantPolicy.maxAutonomy,
          entitlementAutonomy(ent),
        ),
      };
      const skills = await resolveSkills(
        { tenantId, brandId: parsed.brandId, taskKind: taskKind.data, actor },
        tx,
      );
      if (skills.length === 0)
        blockers.push({
          code: 'no_skill',
          message: 'No published skill serves this task kind for the brand.',
        });
      let budget: Budget | null = null;
      try {
        budget = resolveBudget(skills, ent);
      } catch (err) {
        if (!(err instanceof BudgetExhaustedError)) throw err;
        blockers.push({
          code: 'budget_exhausted_month',
          message: "The company's generation budget for this month is spent.",
        });
      }
      const spend = await budgets.summary(parsed.brandId, tx);
      const reservedMicros = budget?.maxCostMicros ?? 0;
      if (budget && reservedMicros > spend.month.remainingMicros)
        blockers.push({
          code: 'budget_exhausted_month',
          message: "The company's remaining budget this month is below what the run would reserve.",
        });
      if (budget && reservedMicros > spend.day.remainingMicros)
        blockers.push({
          code: 'budget_exhausted_day',
          message: "The brand's remaining budget today is below what the run would reserve.",
        });
      // allowedTools as the context resolver computes it: the skills' allowlists the principal's grants cover.
      const covers = (action: string) =>
        principal.grants.some(
          (g) => g.action === action && (g.brandIds === 'all' || g.brandIds.includes(parsed.brandId)),
        );
      const tools = [...new Set(skills.flatMap((s) => s.manifest.allowedTools))].sort().map((name) => {
        const def = RELEASE_1_TOOLS.find((t) => t.name === name);
        const action = def?.action ?? null;
        return { name, action, allowed: action !== null && covers(action) };
      });
      const deniedActions = [
        ...new Set(tools.flatMap((t) => (!t.allowed && t.action ? [t.action] : []))),
      ].sort();
      return {
        brandId: parsed.brandId,
        taskKind: taskKind.data,
        principal: { id: principal.id, name: principal.name, maxAutonomy: principal.maxAutonomy },
        autonomy,
        skills: skills.map((s) => ({ key: s.key, title: s.manifest.title, versionNumber: s.versionNumber })),
        budget,
        reservedMicros,
        spend: {
          month: { limitMicros: spend.month.limitMicros, remainingMicros: spend.month.remainingMicros },
          day: { limitMicros: spend.day.limitMicros, remainingMicros: spend.day.remainingMicros },
        },
        tools,
        deniedActions,
        blockers,
        canStart: blockers.length === 0,
      };
    },

    /** Spec 13.5: cancel moves the row (machine), releases the reservation and signals the workflow via the outbox. */
    async cancel(actor: ResolvedActor, input: z.infer<typeof RunCancel>, tx: Tx) {
      const parsed = RunCancel.parse(input);
      const run = await runsRepo.lock(parsed.runId, tx);
      await policy.assert(actor, 'agent.cancel_run', { ...brandResource(run), state: run.state }, {}, tx);
      const toState = transition(run.state, 'cancel', 'runId');
      await runsRepo.update(run.id, run.version, { state: toState, finishedAt: new Date() }, tx);
      await audit.record(
        actorRef(actor),
        'agent.run.cancel',
        { type: 'agent_run', id: run.id },
        'allowed',
        tx,
        { brandId: run.brandId, runId: run.id, fromState: run.state, toState, reason: parsed.reason ?? null },
      );
      await outbox.add(
        'agent.run_cancel_requested',
        { type: 'agent_run', id: run.id, version: run.version + 1 },
        { runId: run.id, requestedByKind: actor.kind, requestedById: actor.id },
        tx,
        { brandId: run.brandId },
      );
      // Released with the command: if this transaction does not commit, the run keeps its reservation. The
      // cancel signal reaches the workflow through the outbox relay only after the commit (no direct signal
      // can be sent from inside an open transaction without racing the workflow against uncommitted state).
      await budgets.release(run.id, tx); // idempotent; the workflow's settle is a no-op afterwards
      return { runId: run.id, state: toState, version: run.version + 1 };
    },

    /** Steps with their tool invocations: inputs redacted, outcomes and costs; never private reasoning (spec 12.7). */
    async steps(actor: ResolvedActor, input: z.infer<typeof RunSteps>, tx?: Tx) {
      const parsed = RunSteps.parse(input);
      const run = await runsRepo.getById(parsed.runId, tx);
      await policy.assert(actor, 'brand.read', brandResource(run), {}, tx);
      const page = await stepsRepo.listForRun(run.id, parsed.page, tx);
      const invocations = await invocationsRepo.listForSteps(
        run.id,
        page.items.map((s) => s.id),
        tx,
      );
      return {
        items: page.items.map((s) => ({
          id: s.id,
          index: s.index,
          kind: s.kind,
          summary: s.summary,
          tokensIn: s.tokensIn,
          tokensOut: s.tokensOut,
          costMicros: s.costMicros,
          durationMs: s.durationMs,
          createdAt: s.createdAt.toISOString(),
          invocations: invocations
            .filter((i) => i.stepId === s.id)
            .map((i) => ({
              id: i.id,
              toolName: i.toolName,
              inputHash: i.inputHash,
              inputRedacted: i.inputRedacted,
              policyDecision: i.policyDecision,
              policyReason: i.policyReason,
              outcome: i.outcome,
              outputRef: i.outputRef,
              proposal: i.proposalPayload ?? null,
              createdAt: i.createdAt.toISOString(),
            })),
        })),
        nextCursor: page.nextCursor,
      };
    },

    /**
     * Spec 12.2 proposalDecision: a person accepts, rejects or modifies a proposal. The decision is recorded and
     * relayed to the workflow after commit (agent.proposal_decided); recordDecision applies an accepted batch as the
     * run's principal. `modify` applies the person's own batch here, as the person (origin user).
     */
    async approveProposal(actor: ResolvedActor, input: z.infer<typeof RunApproveProposal>, tx: Tx) {
      const parsed = RunApproveProposal.parse(input);
      const run = await runsRepo.lock(parsed.runId, tx);
      const proposal = await invocationsRepo.findProposal(run.id, parsed.stepId, tx);
      if (!proposal) throw new NotFoundError('Proposal', parsed.stepId);
      // The decider needs the permission of the tool that made the proposal (a proposed schedule needs
      // publication.schedule, a creative batch creative.edit), never a fixed one.
      const action = RELEASE_1_TOOLS.find((t) => t.name === proposal.toolName)?.action ?? 'creative.edit';
      await policy.assert(actor, action, brandResource(run), {}, tx);
      if (actor.kind !== 'user') throw new PolicyDeniedError('agent_never', 'A person decides on proposals');
      if (run.state !== 'waiting_for_review')
        throw new ValidationFailedError([
          { path: 'runId', issue: `run is ${run.state}, not waiting_for_review` },
        ]);
      // One decision per proposal: the run moves only once the workflow records it, so the row alone cannot tell.
      if ((await stepsRepo.decidedProposalStepIds([run.id], tx)).has(parsed.stepId))
        throw new ValidationFailedError([{ path: 'stepId', issue: 'proposal_already_decided' }]);
      let appliedRevisionId: string | null = null;
      if (parsed.decision === 'modify') {
        // A pending proposal a person completes through its own command (a proposed schedule) has no batch to modify.
        if (PersonCompletedProposal.safeParse(proposal.proposalPayload).success)
          throw new ValidationFailedError([{ path: 'decision', issue: 'modify_not_supported_for_proposal' }]);
        const proposed = CreativeProposalPayload.parse(proposal.proposalPayload);
        const batch = OperationBatch.extend({ documentId: z.string() }).parse({
          ...(parsed.batch as object),
          origin: 'user',
        });
        if (batch.documentId !== proposed.documentId)
          throw new ValidationFailedError([{ path: 'batch.documentId', issue: 'must match the proposal' }]);
        const applied = await applyProposalBatch(actor, batch, tx);
        appliedRevisionId = applied.revision.id;
      }
      await stepsRepo.append(
        {
          id: newId('agentStep'),
          runId: run.id,
          index: await stepsRepo.nextIndex(run.id, tx),
          kind: 'validation',
          summary: `proposal ${parsed.stepId} ${parsed.decision} by user ${actor.id}${appliedRevisionId ? `: revision ${appliedRevisionId}` : ''}`,
          tokensIn: 0,
          tokensOut: 0,
          costMicros: 0,
          durationMs: 0,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'agent.proposal.decide',
        { type: 'agent_run', id: run.id },
        'allowed',
        tx,
        { brandId: run.brandId, runId: run.id, reason: parsed.decision, revisionId: appliedRevisionId },
      );
      await outbox.add(
        'agent.proposal_decided',
        { type: 'agent_run', id: run.id, version: run.version },
        {
          runId: run.id,
          stepId: parsed.stepId,
          decision: parsed.decision,
          decidedByKind: actor.kind,
          decidedById: actor.id,
        },
        tx,
        { brandId: run.brandId },
      );
      return { runId: run.id, stepId: parsed.stepId, decision: parsed.decision, appliedRevisionId };
    },
  },

  /**
   * Spec 12.7: the tenant's model-routing policy (permitted vendors, regions, retention, data classes), stored per
   * tenant and read by assertRoutingAllowed before every model call through the source the composition root
   * registers (storedFor). Reading and changing it is a tenant administration action (billing.manage: vendor, retention and cost are commercial terms; agents never); every change is audited.
   */
  routingPolicy: {
    async get(actor: ResolvedActor, tx?: Tx) {
      const { tenantId } = requireTenant();
      await policy.assert(actor, 'billing.manage', tenantResource(tenantId), {}, tx);
      const row = await routingPoliciesRepo.current(tx);
      // The route agents.runs.start checks (deployment configuration), so an admin sees what a policy would stop.
      const cfg = currentModelConfig();
      const inUse = { provider: cfg.provider, model: cfg.model, region: modelRegion() };
      return row
        ? {
            policy: ModelRoutingPolicy.parse(row.document),
            version: row.version,
            stored: true as const,
            inUse,
          }
        : { policy: null, version: null, stored: false as const, inUse };
    },

    async set(actor: ResolvedActor, input: z.input<typeof RoutingPolicySet>, tx: Tx) {
      const parsed = RoutingPolicySet.parse(input);
      const { tenantId } = requireTenant();
      await policy.assert(actor, 'billing.manage', tenantResource(tenantId), {}, tx);
      const row = await routingPoliciesRepo.current(tx);
      const values = { document: parsed.policy, updatedByKind: actor.kind, updatedById: actor.id };
      let version: number;
      if (row) {
        if (parsed.expectedVersion === undefined)
          throw new ValidationFailedError([{ path: 'expectedVersion', issue: 'required' }]);
        await routingPoliciesRepo.update(row.id, parsed.expectedVersion, values, tx); // CONFLICT on a stale version
        version = parsed.expectedVersion + 1;
      } else {
        await routingPoliciesRepo.create({ id: newId('modelRoutingPolicy'), ...values }, tx);
        version = 0;
      }
      await audit.record(
        actorRef(actor),
        'agent.routing_policy.set',
        { type: 'tenant', id: tenantId },
        'allowed',
        tx,
        // The document is the stored row (like brand.versions.update, only the version is audited); no outbox
        // event: nothing consumes a change, assertRoutingAllowed reads the row on every check (as killSwitch.set).
        row ? { expectedVersion: parsed.expectedVersion } : undefined,
      );
      return { policy: parsed.policy, version };
    },

    /**
     * The stored policy as assertRoutingAllowed reads it (the RoutingPolicySource the composition root registers).
     * Only inside the same tenant's context: a check for another tenant is refused, never answered with a default.
     */
    async storedFor(tenantId: string): Promise<ModelRoutingPolicy | null> {
      if (requireTenant().tenantId !== tenantId)
        throw new PolicyDeniedError('tenant_mismatch', 'Routing policy is read in its own tenant only');
      const row = await routingPoliciesRepo.current();
      return row ? ModelRoutingPolicy.parse(row.document) : null;
    },
  },

  /** UX-16: the spend position and limits a person with billing.manage reads and sets (spec 12.6 budgets). */
  budgets: {
    async read(actor: ResolvedActor, input: z.infer<typeof BudgetRead>, tx?: Tx) {
      const parsed = BudgetRead.parse(input);
      const { tenantId } = requireTenant();
      await brandService.assertExist([parsed.brandId], tx); // NOT_FOUND for a foreign brand
      await policy.assert(actor, 'billing.manage', tenantResource(tenantId), {}, tx);
      return { brandId: parsed.brandId, ...(await budgets.summary(parsed.brandId, tx)) };
    },

    async setLimit(actor: ResolvedActor, input: z.infer<typeof BudgetSetLimit>, tx: Tx) {
      const parsed = BudgetSetLimit.parse(input);
      const { tenantId } = requireTenant();
      await brandService.assertExist([parsed.brandId], tx);
      await policy.assert(actor, 'billing.manage', tenantResource(tenantId), {}, tx);
      // The month limit is the company's (one row, brandId ''); the day limit is the brand's own.
      await budgets.setLimit(
        parsed.period === 'month' ? null : parsed.brandId,
        parsed.period,
        parsed.limitMicros,
        tx,
      );
      await audit.record(
        actorRef(actor),
        'billing.spend_limit.set',
        {
          type: parsed.period === 'month' ? 'tenant' : 'brand',
          id: parsed.period === 'month' ? tenantId : parsed.brandId,
        },
        'allowed',
        tx,
        { brandId: parsed.brandId, period: parsed.period, limitMicros: parsed.limitMicros },
      );
      return { brandId: parsed.brandId, period: parsed.period, limitMicros: parsed.limitMicros };
    },
  },
};

/**
 * Spec 8.2: the brand module's onboarding runs (registerOnboardingRunSource in both composition roots). An
 * onboarding run is an ordinary run of task kind brand_onboarding: same policy, kill switch, entitlement, routing
 * policy and autonomy computation as any start, and the only way such a run starts (runs.start refuses the task
 * kind); `get` returns the brief exactly as the brand module wrote it.
 */
export const onboardingRunSource: OnboardingRunSource = {
  start: (actor, input, tx) =>
    startRun(actor, { ...input, requestedAutonomy: 'create', taskKind: 'brand_onboarding' }, tx),
  async get(actor, runId, tx) {
    const run = await agentsService.runs.get(actor, { runId }, tx);
    return { brandId: run.brandId, taskKind: run.taskKind, brief: run.brief };
  },
};
