import { and, asc, eq, isNotNull, lt, lte, type SQL } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import {
  BrandScopedRepository,
  PlatformRepository,
  affectedRows,
  requireTenant,
  type Tx,
} from '@oremedia/db';
import {
  brandDestinations,
  pendingDestinationGrants,
  sourceUsePolicies,
} from '@oremedia/db/schema/destinations';

/** A brand has a handful of destinations and policy rows; a list is bounded, never paged. */
const LIST_MAX = 200;

export class BrandDestinationRepository extends BrandScopedRepository<typeof brandDestinations> {
  constructor() {
    super(brandDestinations);
  }
  async create(values: Omit<typeof brandDestinations.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof brandDestinations.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** SELECT ... FOR UPDATE: health and status move under the row lock. */
  async lock(id: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(brandDestinations)
      .where(this.scope(eq(brandDestinations.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('Destination', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  /** The tenant's row for a remote identity, whichever brand holds it (uq_destination_remote). */
  async findRemote(kind: string, externalId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(brandDestinations)
      .where(
        this.scope(
          and(eq(brandDestinations.kind, kind), eq(brandDestinations.externalId, externalId)) as SQL,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  async listForBrand(brandId: string, kind: string | undefined, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(brandDestinations)
      .where(this.brandScope(brandId, kind ? eq(brandDestinations.kind, kind) : undefined))
      .orderBy(asc(brandDestinations.kind), asc(brandDestinations.displayName), asc(brandDestinations.id))
      .limit(LIST_MAX);
  }
}

/** Rows the daily refresh visits per run (spec 17.4 bounded work); the rest wait for the next day. */
export const REFRESH_BATCH = 1000;

/**
 * The daily token refresh (destinationTokenRefreshWorkflowV1) spans tenants like the retention sweep and runs as a
 * declared platform job (spec 5.3); it returns references only (tenant and destination ids), never a row.
 */
export class DestinationRefreshDueRepository extends PlatformRepository {
  /** Active destinations with a credential whose token expires at or before `before`, soonest first. */
  async listDue(before: Date, tx?: Tx, limit = REFRESH_BATCH) {
    return this.conn(tx)
      .select({ tenantId: brandDestinations.tenantId, destinationId: brandDestinations.id })
      .from(brandDestinations)
      .where(
        and(
          eq(brandDestinations.status, 'active'),
          isNotNull(brandDestinations.credentialRefId),
          lte(brandDestinations.tokenExpiresAt, before),
        ),
      )
      .orderBy(asc(brandDestinations.tokenExpiresAt), asc(brandDestinations.id))
      .limit(limit);
  }
}

/** What a pending grant row holds once shredded: no wrapped data key, no ciphertext (as pending_channel_grants). */
const SHREDDED = { wrappedDataKey: '', ciphertext: '' };

/**
 * R2-1 connect flow: the sealed grant offered to the person who completed it, one row per flow. Nothing updates a
 * row: selecting or cancelling deletes it (one-shot), and expired rows are deleted with the next flow in the tenant.
 */
export class PendingDestinationGrantRepository extends BrandScopedRepository<
  typeof pendingDestinationGrants
> {
  constructor() {
    super(pendingDestinationGrants);
  }
  async create(values: Omit<typeof pendingDestinationGrants.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  /** The row of one pending id, locked until the transaction ends (one chooser wins); null when unknown here. */
  async lockPending(pendingId: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(pendingDestinationGrants)
      .where(this.scope(eq(pendingDestinationGrants.id, pendingId)))
      .for('update');
    const row = rows[0];
    if (!row) return null;
    const ctx = requireTenant();
    // A brand the actor cannot see behaves like a choice that does not exist.
    return ctx.brandIds === 'all' || ctx.brandIds.has(row.brandId) ? row : null;
  }
  /** Crypto-shred then delete: the wrapped key and ciphertext go first. */
  async deletePending(pendingId: string, tx: Tx): Promise<number> {
    const where = this.scope(eq(pendingDestinationGrants.id, pendingId));
    await tx.update(pendingDestinationGrants).set(SHREDDED).where(where);
    return affectedRows(await tx.delete(pendingDestinationGrants).where(where));
  }
  /** Shreds and deletes the tenant's expired flows; returns how many rows went. */
  async deleteExpired(now: Date, tx: Tx): Promise<number> {
    const where = this.scope(lt(pendingDestinationGrants.expiresAt, now));
    await tx.update(pendingDestinationGrants).set(SHREDDED).where(where);
    return affectedRows(await tx.delete(pendingDestinationGrants).where(where));
  }
}

export class SourceUsePolicyRepository extends BrandScopedRepository<typeof sourceUsePolicies> {
  constructor() {
    super(sourceUsePolicies);
  }
  async create(values: Omit<typeof sourceUsePolicies.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof sourceUsePolicies.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  private byKey(brandId: string, destinationKind: string, dataType: string): SQL {
    return this.brandScope(
      brandId,
      and(
        eq(sourceUsePolicies.destinationKind, destinationKind),
        eq(sourceUsePolicies.dataType, dataType),
      ) as SQL,
    );
  }
  /** The one row per (brand, kind, data type), or null. */
  async findByKey(brandId: string, destinationKind: string, dataType: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(sourceUsePolicies)
      .where(this.byKey(brandId, destinationKind, dataType))
      .limit(1);
    return rows[0] ?? null;
  }
  /** SELECT ... FOR UPDATE: a policy's version moves under the row lock (null when there is no row yet). */
  async lockByKey(brandId: string, destinationKind: string, dataType: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(sourceUsePolicies)
      .where(this.byKey(brandId, destinationKind, dataType))
      .for('update');
    return rows[0] ?? null;
  }
  async listForBrand(brandId: string, destinationKind: string | undefined, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(sourceUsePolicies)
      .where(
        this.brandScope(
          brandId,
          destinationKind ? eq(sourceUsePolicies.destinationKind, destinationKind) : undefined,
        ),
      )
      .orderBy(asc(sourceUsePolicies.destinationKind), asc(sourceUsePolicies.dataType))
      .limit(LIST_MAX);
  }
}
