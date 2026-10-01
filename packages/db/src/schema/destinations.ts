import { foreignKey, int, json, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { brandId, createdAt, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

/**
 * Ledger R2-0: a brand's non-social destinations (analytics property, Search Console site, Business Profile
 * location, website CMS, Discord webhook). One row per remote identity per tenant; the credential, when a connect
 * flow has stored one, lives in credential_refs (the column is a plain reference: a destination registered before
 * its grant has none, and the composite key cannot be nullable).
 */
export const brandDestinations = mysqlTable(
  'brand_destinations',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: varchar('kind', { length: 40 }).notNull(),
    externalId: varchar('external_id', { length: 200 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    ownerUserId: ref('owner_user_id').notNull(),
    credentialRefId: ref('credential_ref_id'),
    grantedScopes: json('granted_scopes').$type<string[]>().notNull().default([]),
    health: mysqlEnum('health', ['unknown', 'healthy', 'degraded', 'unreachable'])
      .notNull()
      .default('unknown'),
    healthCheckedAt: ts('health_checked_at'),
    capabilityVersion: int('capability_version').notNull(),
    status: mysqlEnum('status', ['active', 'disconnected']).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_destination_remote').on(t.tenantId, t.kind, t.externalId),
    uniqueIndex('uq_destination_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_destination_brand',
    }),
  ],
);

/**
 * D-17: per destination kind and data type, what the product may do with the data (read, retain, write) and for
 * how long a copy may be kept; every change is a new version with who reviewed it and when the next review is
 * due. A use without a current policy is refused.
 */
export const sourceUsePolicies = mysqlTable(
  'source_use_policies',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    destinationKind: varchar('destination_kind', { length: 40 }).notNull(),
    dataType: varchar('data_type', { length: 80 }).notNull(),
    allowedUses: json('allowed_uses').$type<string[]>().notNull(),
    retentionDays: int('retention_days'),
    version: int('version').notNull().default(1),
    reviewedAt: ts('reviewed_at').notNull(),
    reviewDueAt: ts('review_due_at').notNull(),
    reviewedById: ref('reviewed_by_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_source_use_policy').on(t.tenantId, t.brandId, t.destinationKind, t.dataType),
    uniqueIndex('uq_source_use_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_source_use_policy_brand',
    }),
  ],
);
