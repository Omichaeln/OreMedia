import { z } from 'zod';
import { TenantContextInput } from './tenancy';

export const AuditDecision = z.enum(['allowed', 'denied']);

export const AuditQuery = z.object({
  resourceType: z.string().max(60).optional(),
  resourceId: z.string().optional(),
  actorId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const DeletionRequestCreate = z.object({
  subjectType: z.enum(['user', 'asset', 'brand', 'tenant', 'channel_connection', 'customer_voice']),
  subjectId: z.string(),
  reason: z.string().max(500),
});
export const DeletionRequestState = z.enum(['requested', 'in_progress', 'completed', 'blocked']);

export const RetentionDataClass = z.enum([
  'user_identity',
  'asset_files',
  'creative_revisions',
  'agent_transcripts',
  'audit_and_evidence',
  'social_tokens',
  'metrics',
  'customer_voice_raw',
]);

export const IncidentSeverity = z.enum(['sev1', 'sev2', 'sev3', 'sev4']);

/**
 * Spec 22.1: engineering flags (short-lived, server-enforced). Every key here is read by the code it gates
 * (feature-flags.test.ts). `studio.agent_proposals` and `publishing.channel.*` were removed unread: agent proposals
 * shipped ungated, and channel connect is gated by certification. Their rows, if any, are ignored on read.
 */
export const FeatureFlagKey = z.enum([
  'mandates.managed_autopublish',
  'intelligence.brand_analyst',
  'experiments.randomised',
  'creative.preview_render',
  'creative.video_generation',
  'creative.audio_generation',
]);
export type FeatureFlagKey = z.infer<typeof FeatureFlagKey>;

/**
 * Where operations.flags.set writes, in the feature_flags row's own targeting model: `global` is the row's
 * enabled_default (every tenant), `tenant` adds or removes one tenant id in targeting.tenantIds. A tenant entry only
 * ever turns a flag on: with the global default on, removing a tenant does not turn it off for that tenant.
 */
export const FeatureFlagTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('tenant'), tenantId: z.string().min(1).max(40) }),
]);
export type FeatureFlagTarget = z.infer<typeof FeatureFlagTarget>;

/**
 * Operator-only flag change (platform operator in an escalated support session). `expectedVersion` is the row's
 * version from operations.flags.list, or null when the flag has no row yet; a stale value is CONFLICT.
 */
export const FeatureFlagSet = z.object({
  key: FeatureFlagKey,
  target: FeatureFlagTarget,
  enabled: z.boolean(),
  expectedVersion: z.number().int().min(0).nullable(),
  reason: z.string().trim().min(1).max(200),
});
export type FeatureFlagSet = z.infer<typeof FeatureFlagSet>;

/** One flag as an operator sees it from inside a support session: the global default and this tenant's entry. */
export const FeatureFlagState = z.object({
  key: FeatureFlagKey,
  owner: z.string(),
  removalDate: z.string(),
  successMetric: z.string(),
  globalEnabled: z.boolean(),
  tenantTargeted: z.boolean(),
  /** How many tenants are targeted; the ids of other tenants are never returned. */
  targetedTenantCount: z.number().int(),
  percentage: z.number().nullable(),
  enabledForTenant: z.boolean(),
  version: z.number().int().nullable(),
});
export type FeatureFlagState = z.infer<typeof FeatureFlagState>;

export const KillSwitchScope = z.enum(['agent_starts', 'release_dispatch']);
export type KillSwitchScope = z.infer<typeof KillSwitchScope>;

/** Runbook "drain and replay the outbox": replay one dead-lettered event of the caller's tenant. */
export const OutboxReplay = z.object({ eventId: z.string() });
export type OutboxReplay = z.infer<typeof OutboxReplay>;

/**
 * Spec 17.5 deletion fan-out: deletionRequestWorkflowV1 on task queue `core`, started from the outbox event
 * `operations.deletion_requested`. Each registered subsystem handler runs as its own activity and records its
 * completion (fanout status + audited evidence) on the deletion request; a repeat of a finished handler is a no-op.
 */
export const DeletionWorkflowInputV1 = TenantContextInput.extend({ deletionRequestId: z.string() });
export type DeletionWorkflowInputV1 = z.infer<typeof DeletionWorkflowInputV1>;

export const DeletionFanoutStatus = z.enum(['pending', 'done', 'blocked', 'not_applicable']);
export type DeletionFanoutStatus = z.infer<typeof DeletionFanoutStatus>;

export interface DeletionPlanV1 {
  state: z.infer<typeof DeletionRequestState>;
  /** Handlers (in run order) whose fan-out entry is still pending. */
  pending: string[];
}

export interface DeletionStepResultV1 {
  handler: string;
  status: 'done' | 'not_applicable' | 'operator_action_required' | 'skipped';
  /** Per-table or per-store counts, e.g. { publications: 3, objects: 2 }. */
  evidence: Record<string, number | string>;
}

export interface DeletionFinishResultV1 {
  state: z.infer<typeof DeletionRequestState>;
  /** Fan-out entries a person must complete (Temporal visibility, logs, backups: see the deletion runbook). */
  operatorActions: string[];
}

export interface DeletionActivitiesV1 {
  beginDeletion(input: DeletionWorkflowInputV1): Promise<DeletionPlanV1>;
  runDeletionHandler(input: DeletionWorkflowInputV1 & { handler: string }): Promise<DeletionStepResultV1>;
  finishDeletion(input: DeletionWorkflowInputV1): Promise<DeletionFinishResultV1>;
}

/** Spec 17.5 TTL job: retentionSweepWorkflowV1 on task queue `core`, started by a Temporal schedule. */
export const RetentionSweepArgsV1 = z.object({
  dryRun: z.boolean().optional(),
  now: z.string().datetime().optional(),
  correlationId: z.string().optional(),
});
export type RetentionSweepArgsV1 = z.infer<typeof RetentionSweepArgsV1>;

export interface RetentionSweepInputV1 {
  correlationId: string;
  now: string;
  dryRun: boolean;
}

/**
 * The class a TTL handler runs under: one of the tenant's retention_policies classes, or `source_use_policy` for
 * rows whose retention each brand's per-destination source-use policy sets (D-17: the policy's retentionDays with
 * `retain`, else the operational cache or keep rule); such a handler reads its own cut-offs from `now`.
 */
export type RetentionHandlerClass = z.infer<typeof RetentionDataClass> | 'source_use_policy';

export interface RetentionClassResultV1 {
  dataClass: RetentionHandlerClass;
  handler: string;
  /** The days the cut-off was taken from; null for a `source_use_policy` handler (one cut-off per destination). */
  retentionDays: number | null;
  cutoff: string;
  /** Rows removed, or rows that would be removed in a dry run. */
  rows: number;
}

export interface RetentionTenantResultV1 {
  tenantId: string;
  dryRun: boolean;
  classes: RetentionClassResultV1[];
}

export interface RetentionActivitiesV1 {
  listRetentionTenants(input: RetentionSweepInputV1): Promise<string[]>;
  applyRetention(input: RetentionSweepInputV1 & { tenantId: string }): Promise<RetentionTenantResultV1>;
}

/** The module-side implementations the activities wrap (tenant context is established by the activity host). */
export type DeletionRuntimeV1 = DeletionActivitiesV1;
export type RetentionRuntimeV1 = RetentionActivitiesV1;
