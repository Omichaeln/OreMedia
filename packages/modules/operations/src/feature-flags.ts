import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { ConflictError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { FeatureFlagKey, FeatureFlagState } from '@oremedia/contracts/operations';
import { FeatureFlagKey as FeatureFlagKeySchema, FeatureFlagSet } from '@oremedia/contracts/operations';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import {
  PlatformRepository,
  affectedRows,
  currentTenant,
  requireTenant,
  runAsPlatform,
  type Tx,
} from '@oremedia/db';
import { featureFlags } from '@oremedia/db/schema/operations';
import type { z } from 'zod';
import { audit } from './audit';

/**
 * Spec 22.1: engineering flags are short-lived, server-enforced, and carry owner, removal date and success metric.
 * Evaluation is a pure function of the stored row and the tenant id; the client never decides.
 */
export interface FlagDefinition {
  key: FeatureFlagKey;
  owner: string;
  removalDate: string;
  successMetric: string;
  enabledDefault: boolean;
}

export const FLAG_DEFINITIONS: readonly FlagDefinition[] = [
  {
    key: 'mandates.managed_autopublish',
    owner: 'review',
    removalDate: '2027-06-30',
    successMetric: 'zero unauthorised publications over the managed-autopublish pilot',
    enabledDefault: false,
  },
  {
    key: 'intelligence.brand_analyst',
    owner: 'intelligence',
    removalDate: '2027-03-31',
    successMetric: 'recommendation acceptance ≥ 25 %',
    enabledDefault: false,
  },
  {
    key: 'experiments.randomised',
    owner: 'experiments',
    removalDate: '2027-03-31',
    successMetric: 'one randomised experiment analysed end to end per pilot brand',
    enabledDefault: false,
  },
  {
    // Rolling-deploy guard: an older worker-render would render a preview job's committed base revision into
    // publishable rendered_exports. Enabled only once every worker-render runs the preview-aware build
    // (docs/runbooks/deploy-railway.md).
    key: 'creative.preview_render',
    owner: 'creative',
    removalDate: '2027-03-31',
    successMetric:
      'every worker-render on the preview-aware build; zero preview jobs writing rendered_exports',
    enabledDefault: false,
  },
  {
    // ADR-11 video generation (ledger 4.25): off until the clamav stream limit is confirmed for generated clips and
    // the pilot brands opt in.
    key: 'creative.video_generation',
    owner: 'creative',
    removalDate: '2027-03-31',
    successMetric:
      '95 % of video generations land as pending assets; no clip rejected by the scanner for size',
    enabledDefault: false,
  },
  {
    // ADR-11 speech generation (ledger 4.26): off until the pilot brands opt in.
    key: 'creative.audio_generation',
    owner: 'creative',
    removalDate: '2027-03-31',
    successMetric: '95 % of speech generations land as pending assets',
    enabledDefault: false,
  },
];

type FlagRow = typeof featureFlags.$inferSelect;
type Targeting = FlagRow['targeting'];

const isDuplicateKeyError = (err: unknown): boolean =>
  (err as { code?: string } | undefined)?.code === 'ER_DUP_ENTRY' ||
  (err as { cause?: { code?: string } } | undefined)?.cause?.code === 'ER_DUP_ENTRY';

class FlagRepository extends PlatformRepository {
  async get(key: string, tx?: Tx) {
    const rows = await this.conn(tx).select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
    return rows[0] ?? null;
  }
  async all(tx?: Tx) {
    return this.conn(tx).select().from(featureFlags);
  }
  /** The row under a write lock for the rest of the command's transaction, or null when the flag has no row. */
  async lock(key: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .for('update');
    return rows[0] ?? null;
  }
  /** First write of a flag. A concurrent first write of the same key is a version conflict, not a 500. */
  async create(values: typeof featureFlags.$inferInsert, tx: Tx) {
    try {
      await this.conn(tx).insert(featureFlags).values(values);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('FeatureFlag', values.key, 0);
      throw err;
    }
  }
  async update(
    key: string,
    expectedVersion: number,
    values: { enabledDefault: boolean; targeting: Targeting },
    tx: Tx,
  ) {
    const res = await this.conn(tx)
      .update(featureFlags)
      .set({ ...values, version: expectedVersion + 1 })
      .where(and(eq(featureFlags.key, key), eq(featureFlags.version, expectedVersion)));
    if (affectedRows(res) !== 1) throw new ConflictError('FeatureFlag', key, expectedVersion);
  }
}

const repo = new FlagRepository();

/** Flags may be read inside a request (correlate with it) or by a worker outside any tenant context. */
const correlationId = () => currentTenant()?.correlationId ?? 'flags';

export function evaluateFlag(
  row: { enabledDefault: boolean; targeting: { tenantIds?: string[]; percentage?: number } } | null,
  def: FlagDefinition,
  tenantId: string,
): boolean {
  if (!row) return def.enabledDefault;
  if (row.targeting.tenantIds?.includes(tenantId)) return true;
  if (typeof row.targeting.percentage === 'number' && row.targeting.percentage > 0) {
    const bucket =
      parseInt(createHash('sha256').update(`${def.key}:${tenantId}`).digest('hex').slice(0, 8), 16) % 100;
    if (bucket < row.targeting.percentage) return true;
  }
  return row.enabledDefault;
}

/** Ids of other tenants never leave the row: an operator sees the global default and their session's tenant only. */
function stateOf(def: FlagDefinition, row: FlagRow | null, tenantId: string): FeatureFlagState {
  const targeting: Targeting = row?.targeting ?? {};
  return {
    key: def.key,
    owner: def.owner,
    removalDate: def.removalDate,
    successMetric: def.successMetric,
    globalEnabled: row?.enabledDefault ?? def.enabledDefault,
    tenantTargeted: targeting.tenantIds?.includes(tenantId) ?? false,
    targetedTenantCount: targeting.tenantIds?.length ?? 0,
    percentage: typeof targeting.percentage === 'number' ? targeting.percentage : null,
    enabledForTenant: evaluateFlag(row, def, tenantId),
    version: row?.version ?? null,
  };
}

/** The row after the change, in the existing targeting model; percentage targeting is left as it is. */
function applyTarget(
  current: { enabledDefault: boolean; targeting: Targeting },
  input: z.infer<typeof FeatureFlagSet>,
): { enabledDefault: boolean; targeting: Targeting } {
  if (input.target.kind === 'global') return { ...current, enabledDefault: input.enabled };
  const tenantId = input.target.tenantId;
  const others = (current.targeting.tenantIds ?? []).filter((id) => id !== tenantId);
  return {
    enabledDefault: current.enabledDefault,
    targeting: { ...current.targeting, tenantIds: input.enabled ? [...others, tenantId] : others },
  };
}

const definitionOf = (key: FeatureFlagKey): FlagDefinition => {
  const def = FLAG_DEFINITIONS.find((d) => d.key === key);
  if (!def) throw new PolicyDeniedError('unknown_flag', `Unknown flag ${key}`);
  return def;
};

/**
 * Flags are platform settings: only a platform operator, inside a live support session (spec 5.7), reads their
 * targeting or changes them, and a change needs the session escalated by a second operator. Tenant members, API
 * clients and agents are refused whatever their role. A refusal is audited outside the command's transaction so it
 * survives the rollback (same as support.escalate).
 */
type FlagAction = 'feature_flag.list' | 'feature_flag.set';

async function refuse(
  actor: ResolvedActor,
  action: FlagAction,
  resourceId: string,
  reason: string,
  message: string,
): Promise<never> {
  await audit.record(
    { kind: actor.kind, id: actor.id },
    action,
    { type: 'feature_flag', id: resourceId },
    {
      allowed: false,
      reason,
    },
  );
  throw new PolicyDeniedError(reason, message);
}

async function assertOperator(actor: ResolvedActor, action: FlagAction, resourceId: string): Promise<void> {
  const deny = (reason: string, message: string) => refuse(actor, action, resourceId, reason, message);
  if (actor.kind !== 'platform_operator')
    return deny('platform_operator_required', 'Feature flags are managed by platform operators');
  if (actor.expired) return deny('support_session_expired', 'The support session has expired');
  if (action === 'feature_flag.set' && actor.mode !== 'escalated')
    return deny('support_read_only', 'A second operator must escalate this support session first');
}

export const featureFlag = {
  definitions: FLAG_DEFINITIONS,
  async isEnabled(key: FeatureFlagKey, tenantId: string, tx?: Tx): Promise<boolean> {
    FeatureFlagKeySchema.parse(key);
    const def = FLAG_DEFINITIONS.find((d) => d.key === key);
    if (!def) return false;
    const row = await runAsPlatform('feature-flags', correlationId(), () => repo.get(key, tx));
    return evaluateFlag(row, def, tenantId);
  },
  async snapshot(tenantId: string, tx?: Tx): Promise<Record<FeatureFlagKey, boolean>> {
    const rows = await runAsPlatform('feature-flags', correlationId(), () => repo.all(tx));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out = {} as Record<FeatureFlagKey, boolean>;
    for (const def of FLAG_DEFINITIONS)
      out[def.key] = evaluateFlag(byKey.get(def.key) ?? null, def, tenantId);
    return out;
  },

  /** Operator view of every defined flag for the support session's tenant, with the version a change must quote. */
  async list(actor: ResolvedActor, tx?: Tx): Promise<FeatureFlagState[]> {
    const { tenantId, correlationId: corr } = requireTenant();
    await assertOperator(actor, 'feature_flag.list', 'all');
    const rows = await runAsPlatform('feature-flags', corr, () => repo.all(tx));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return FLAG_DEFINITIONS.map((def) => stateOf(def, byKey.get(def.key) ?? null, tenantId));
  },
  /**
   * operations.flags.set: one flag on or off, globally (enabled_default) or for the support session's own tenant
   * (targeting.tenantIds). Version-checked against the row (null = no row yet). A change to the state the flag is
   * already in writes nothing and keeps the version; the request is audited either way in the tenant's trail.
   */
  async set(
    actor: ResolvedActor,
    input: z.infer<typeof FeatureFlagSet>,
    tx: Tx,
  ): Promise<{ changed: boolean; flag: FeatureFlagState }> {
    const parsed = FeatureFlagSet.parse(input);
    const { tenantId, correlationId: corr } = requireTenant();
    await assertOperator(actor, 'feature_flag.set', parsed.key);
    // A support session is bound to one company: it may target that company, never another (spec 5.7).
    if (parsed.target.kind === 'tenant' && parsed.target.tenantId !== tenantId)
      await refuse(
        actor,
        'feature_flag.set',
        parsed.key,
        'tenant_mismatch',
        'Support session is bound to one company',
      );
    const def = definitionOf(parsed.key);
    const { row, after, changed } = await runAsPlatform('feature-flags', corr, async () => {
      const row = await repo.lock(parsed.key, tx);
      if ((row?.version ?? null) !== parsed.expectedVersion)
        // -1: the caller expected no row at all.
        throw new ConflictError('FeatureFlag', parsed.key, parsed.expectedVersion ?? -1);
      const current = row
        ? { enabledDefault: row.enabledDefault, targeting: row.targeting }
        : { enabledDefault: def.enabledDefault, targeting: {} };
      const next = applyTarget(current, parsed);
      const changed =
        next.enabledDefault !== current.enabledDefault ||
        JSON.stringify(next.targeting.tenantIds ?? []) !== JSON.stringify(current.targeting.tenantIds ?? []);
      if (changed && row) await repo.update(parsed.key, row.version, next, tx);
      else if (changed)
        await repo.create(
          {
            key: def.key,
            ...next,
            owner: def.owner,
            removalDate: new Date(`${def.removalDate}T00:00:00Z`),
            successMetric: def.successMetric,
          },
          tx,
        );
      return { row, after: changed ? await repo.get(parsed.key, tx) : row, changed };
    });
    const onOff = (on: boolean) => (on ? 'on' : 'off');
    const was =
      parsed.target.kind === 'global'
        ? (row?.enabledDefault ?? def.enabledDefault)
        : (row?.targeting.tenantIds?.includes(tenantId) ?? false);
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'feature_flag.set',
      { type: 'feature_flag', id: parsed.key },
      'allowed',
      tx,
      {
        flag: parsed.key,
        scope: parsed.target.kind,
        fromState: onOff(was),
        toState: onOff(parsed.enabled),
        expectedVersion: parsed.expectedVersion,
        reason: parsed.reason,
      },
    );
    return { changed, flag: stateOf(def, after, tenantId) };
  },
};
