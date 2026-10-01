import { z } from 'zod';
import {
  DESTINATION_KIND_CAPABILITIES,
  DestinationDisconnect,
  DestinationGet,
  DestinationList,
  DestinationRegister,
  DestinationSetHealth,
  SourceUse,
  SourceUseCheck,
  SourceUsePolicyList,
  SourceUsePolicySet,
  sourceUseIssues,
  type DestinationKind,
  type DestinationV1,
  type SourceUseCheckResult,
  type SourceUsePolicyV1,
} from '@oremedia/contracts/destinations';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { Decision, ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { audit, outbox } from '@oremedia/module-operations';
import { BrandDestinationRepository, SourceUsePolicyRepository } from './repositories';

const destinationsRepo = new BrandDestinationRepository();
const policiesRepo = new SourceUsePolicyRepository();

type DestinationRow = Awaited<ReturnType<BrandDestinationRepository['getById']>>;
type PolicyRow = Awaited<ReturnType<SourceUsePolicyRepository['getById']>>;

const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const destinationResource = (d: DestinationRow) => ({
  type: 'brand_destination',
  tenantId: d.tenantId,
  brandId: d.brandId,
  id: d.id,
});
const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });

/**
 * Defence in depth: source_use.manage is AGENT_NEVER (role-grants.ts), so an agent is denied by policy.assert
 * before this runs; should the action ever gain a propose_only grant, a proposal still never writes a policy.
 */
function assertMayDecide(decision: Decision): void {
  if (decision.obligations?.some((o) => o.type === 'propose_only'))
    throw new PolicyDeniedError('propose_only', 'Agents may only propose; an admin must decide');
}

/** Versioned JSON is validated on read (spec 6.1); a kind unknown to the capability table never reaches a DTO. */
const StoredKind = z.enum(
  Object.keys(DESTINATION_KIND_CAPABILITIES) as [DestinationKind, ...DestinationKind[]],
);
const StoredUses = z.array(SourceUse);

/** Never the credential reference: identity, scopes, health and state only. */
const toDestinationDto = (d: DestinationRow): DestinationV1 => ({
  id: d.id,
  brandId: d.brandId,
  kind: StoredKind.parse(d.kind),
  externalId: d.externalId,
  displayName: d.displayName,
  ownerUserId: d.ownerUserId,
  grantedScopes: d.grantedScopes,
  health: d.health,
  healthCheckedAt: d.healthCheckedAt ? d.healthCheckedAt.toISOString() : null,
  capabilityVersion: d.capabilityVersion,
  status: d.status,
  version: d.version,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});

const toPolicyDto = (p: PolicyRow): SourceUsePolicyV1 => ({
  id: p.id,
  brandId: p.brandId,
  destinationKind: StoredKind.parse(p.destinationKind),
  dataType: p.dataType,
  allowedUses: StoredUses.parse(p.allowedUses),
  retentionDays: p.retentionDays,
  version: p.version,
  reviewedAt: p.reviewedAt.toISOString(),
  reviewDueAt: p.reviewDueAt.toISOString(),
  reviewedById: p.reviewedById,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

/**
 * Any brand id from a client is read through the brand module first: a brand of another tenant, or one the actor
 * is not granted, is NOT_FOUND (never FORBIDDEN, spec 5.3), and brand.read is asserted on the way.
 */
const visibleBrand = (actor: ResolvedActor, brandId: string, tx?: Tx) => brandService.get(actor, brandId, tx);

/** A destination read by id under a brand: one that belongs to another brand of the tenant does not exist here. */
async function destinationOf(brandId: string, destinationId: string, row: DestinationRow | null) {
  if (!row || row.brandId !== brandId) throw new NotFoundError('Destination', destinationId);
  return row;
}

export const destinationService = {
  /** A brand's destinations, by kind then name (brand.read). */
  async list(actor: ResolvedActor, input: z.input<typeof DestinationList>, tx?: Tx) {
    const parsed = DestinationList.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    const rows = await destinationsRepo.listForBrand(parsed.brandId, parsed.kind, tx);
    return { items: rows.map(toDestinationDto) };
  },

  async get(actor: ResolvedActor, input: z.infer<typeof DestinationGet>, tx?: Tx) {
    const parsed = DestinationGet.parse(input);
    const row = await destinationOf(
      parsed.brandId,
      parsed.destinationId,
      await destinationsRepo.findById(parsed.destinationId, tx), // foreign → null → NOT_FOUND
    );
    await policy.assert(actor, 'brand.read', brandResource(row.brandId), {}, tx);
    return toDestinationDto(row);
  },

  /**
   * Registers a remote identity for the brand (destination.connect, which agents never hold). The person who
   * registers it owns it. A remote identity this brand holds already is a conflict; one another brand of the tenant
   * holds is refused without naming it (uq_destination_remote, as channels do for a remote account). No credential
   * is stored here: a connect flow attaches one later.
   */
  async register(actor: ResolvedActor, input: z.input<typeof DestinationRegister>, tx: Tx) {
    const parsed = DestinationRegister.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    await policy.assert(actor, 'destination.connect', brandResource(parsed.brandId), {}, tx);
    const existing = await destinationsRepo.findRemote(parsed.kind, parsed.externalId, tx);
    if (existing && existing.brandId !== parsed.brandId)
      throw new ValidationFailedError(
        [{ path: 'externalId', issue: 'remote_identity_registered_to_another_brand' }],
        'This remote identity is already registered to another brand',
      );
    if (existing) throw new ConflictError('Destination', existing.id, existing.version);
    const id = newId('destination');
    await destinationsRepo.create(
      {
        id,
        brandId: parsed.brandId,
        kind: parsed.kind,
        externalId: parsed.externalId,
        displayName: parsed.displayName,
        ownerUserId: actor.id,
        credentialRefId: null,
        grantedScopes: parsed.grantedScopes,
        health: 'unknown',
        healthCheckedAt: null,
        capabilityVersion: parsed.capabilityVersion,
        status: 'active',
      },
      tx,
    );
    const row = await destinationsRepo.getById(id, tx);
    await audit.record(
      actorRef(actor),
      'destination.register',
      { type: 'brand_destination', id },
      'allowed',
      tx,
      {
        brandId: parsed.brandId,
        kind: parsed.kind,
        toState: 'active',
      },
    );
    await outbox.add(
      'destination.registered',
      { type: 'brand_destination', id, version: row.version },
      { destinationId: id, kind: parsed.kind, actorKind: actor.kind, actorId: actor.id },
      tx,
      { brandId: parsed.brandId },
    );
    return toDestinationDto(row);
  },

  /** Records what a health check found (destination.manage); the time of the check is now. Not once disconnected. */
  async setHealth(actor: ResolvedActor, input: z.infer<typeof DestinationSetHealth>, tx: Tx) {
    const parsed = DestinationSetHealth.parse(input);
    const row = await destinationOf(
      parsed.brandId,
      parsed.destinationId,
      await destinationsRepo.lock(parsed.destinationId, tx),
    );
    await policy.assert(actor, 'destination.manage', destinationResource(row), {}, tx);
    if (row.status === 'disconnected')
      throw new ValidationFailedError(
        [{ path: 'destinationId', issue: 'disconnected' }],
        'A disconnected destination is not health-checked',
      );
    if (row.version !== parsed.expectedVersion)
      throw new ConflictError('Destination', row.id, parsed.expectedVersion);
    await destinationsRepo.update(
      row.id,
      row.version,
      { health: parsed.health, healthCheckedAt: new Date() },
      tx,
    );
    await audit.record(
      actorRef(actor),
      'destination.health',
      { type: 'brand_destination', id: row.id },
      'allowed',
      tx,
      { brandId: row.brandId, fromState: row.health, toState: parsed.health },
    );
    return toDestinationDto(await destinationsRepo.getById(row.id, tx));
  },

  /** active → disconnected (destination.manage); a destination disconnected already is refused. */
  async disconnect(actor: ResolvedActor, input: z.infer<typeof DestinationDisconnect>, tx: Tx) {
    const parsed = DestinationDisconnect.parse(input);
    const row = await destinationOf(
      parsed.brandId,
      parsed.destinationId,
      await destinationsRepo.lock(parsed.destinationId, tx),
    );
    await policy.assert(actor, 'destination.manage', destinationResource(row), {}, tx);
    if (row.status === 'disconnected')
      throw new ValidationFailedError(
        [{ path: 'destinationId', issue: 'already_disconnected' }],
        'This destination is already disconnected',
      );
    if (row.version !== parsed.expectedVersion)
      throw new ConflictError('Destination', row.id, parsed.expectedVersion);
    await destinationsRepo.update(row.id, row.version, { status: 'disconnected' }, tx);
    await audit.record(
      actorRef(actor),
      'destination.disconnect',
      { type: 'brand_destination', id: row.id },
      'allowed',
      tx,
      { brandId: row.brandId, fromState: row.status, toState: 'disconnected' },
    );
    await outbox.add(
      'destination.disconnected',
      { type: 'brand_destination', id: row.id, version: row.version + 1 },
      { destinationId: row.id, kind: row.kind, actorKind: actor.kind, actorId: actor.id },
      tx,
      { brandId: row.brandId },
    );
    return toDestinationDto(await destinationsRepo.getById(row.id, tx));
  },
};

export const sourceUsePolicyService = {
  /** A brand's source-use policies by kind then data type (brand.read). */
  async list(actor: ResolvedActor, input: z.infer<typeof SourceUsePolicyList>, tx?: Tx) {
    const parsed = SourceUsePolicyList.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    const rows = await policiesRepo.listForBrand(parsed.brandId, parsed.destinationKind, tx);
    return { items: rows.map(toPolicyDto) };
  },

  /**
   * D-17: an admin records what the product may do with one data type of one destination kind (source_use.manage,
   * which agents never hold). The uses are limited to the kind's capabilities; `retain` needs a retention period;
   * the review date is ahead. The first record is version 1; a later one names the version it replaces and moves
   * it on, with who reviewed it and when.
   */
  async set(actor: ResolvedActor, input: z.input<typeof SourceUsePolicySet>, tx: Tx) {
    const parsed = SourceUsePolicySet.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    const decision = await policy.assert(actor, 'source_use.manage', brandResource(parsed.brandId), {}, tx);
    assertMayDecide(decision);
    const allowedUses = [...new Set(parsed.allowedUses)];
    const issues = sourceUseIssues(parsed.destinationKind, allowedUses, parsed.retentionDays);
    if (issues.length)
      throw new ValidationFailedError(
        issues,
        `A ${DESTINATION_KIND_CAPABILITIES[parsed.destinationKind].label} supports ${DESTINATION_KIND_CAPABILITIES[parsed.destinationKind].uses.join(', ')} only, and retained data needs a retention period`,
      );
    const retains = allowedUses.includes('retain');
    const now = new Date();
    const reviewDueAt = new Date(parsed.reviewDueAt);
    if (reviewDueAt.getTime() <= now.getTime())
      throw new ValidationFailedError(
        [{ path: 'reviewDueAt', issue: 'not_in_future' }],
        'The next review must be ahead of today',
      );
    const values = {
      allowedUses,
      retentionDays: retains ? (parsed.retentionDays ?? null) : null, // a period without `retain` means nothing
      reviewedAt: now,
      reviewDueAt,
      reviewedById: actor.id,
    };
    const existing = await policiesRepo.lockByKey(
      parsed.brandId,
      parsed.destinationKind,
      parsed.dataType,
      tx,
    );
    let id: string;
    if (existing) {
      if (parsed.expectedVersion !== existing.version)
        throw new ConflictError('SourceUsePolicy', existing.id, parsed.expectedVersion ?? existing.version);
      await policiesRepo.update(existing.id, existing.version, values, tx);
      id = existing.id;
    } else {
      id = newId('sourceUsePolicy');
      await policiesRepo.create(
        {
          id,
          brandId: parsed.brandId,
          destinationKind: parsed.destinationKind,
          dataType: parsed.dataType,
          version: 1, // the first record is version 1; the column's default (0) is never written
          ...values,
        },
        tx,
      );
    }
    const row = await policiesRepo.getById(id, tx);
    await audit.record(actorRef(actor), 'source_use.set', { type: 'source_use_policy', id }, 'allowed', tx, {
      brandId: parsed.brandId,
      destinationKind: parsed.destinationKind,
      dataType: parsed.dataType,
      fromVersion: existing?.version ?? null,
      toVersion: row.version,
    });
    return toPolicyDto(row);
  },

  /**
   * Whether one use of one data type is allowed now (brand.read): refused without a policy, once the review is
   * overdue, or when the use is not among the allowed ones. Callers that ingest or write ask this first.
   */
  async check(
    actor: ResolvedActor,
    input: z.infer<typeof SourceUseCheck>,
    tx?: Tx,
  ): Promise<SourceUseCheckResult> {
    const parsed = SourceUseCheck.parse(input);
    await visibleBrand(actor, parsed.brandId, tx);
    const row = await policiesRepo.findByKey(parsed.brandId, parsed.destinationKind, parsed.dataType, tx);
    if (!row) return { allowed: false, reason: 'no_policy', policy: null };
    const dto = toPolicyDto(row);
    if (row.reviewDueAt.getTime() < Date.now())
      return { allowed: false, reason: 'review_overdue', policy: dto };
    if (!dto.allowedUses.includes(parsed.use)) return { allowed: false, reason: 'not_allowed', policy: dto };
    return { allowed: true, reason: 'allowed', policy: dto };
  },
};
