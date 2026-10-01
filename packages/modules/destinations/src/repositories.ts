import { and, asc, eq, type SQL } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import { BrandScopedRepository, type Tx } from '@oremedia/db';
import { brandDestinations, sourceUsePolicies } from '@oremedia/db/schema/destinations';

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
