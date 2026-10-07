import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { TRPCError } from '@trpc/server';
import { and, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, getTableConfig, type MySqlColumn } from 'drizzle-orm/mysql-core';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  appRouter,
  composeModules,
  createContext,
  envelopeFor,
} from '@oremedia/api';
import { purgeOrder, runInTenant, tenantScopedTables, type Db } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import {
  apiClients,
  brandGrants,
  memberships,
  servicePrincipals,
  sessions,
  tenants,
  users,
} from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { newId } from '@oremedia/domain/ids';
import { hashToken, newOpaqueToken } from '@oremedia/module-access';
import type { ErrorEnvelope } from '@oremedia/contracts/errors';
import { SEED_EXTENSIONS } from './cross-tenant-inputs';

/**
 * Every table in the schema that carries a tenant_id column (the same detection as
 * tooling/scripts/check-schema-tenancy.ts), so the "no writes landed in tenant B" snapshot covers a table the day
 * it is added rather than a hand-kept list.
 */
const TENANT_TABLES: Array<[name: string, table: MySqlTable, tenantCol: MySqlColumn]> = Object.values(
  schema as Record<string, unknown>,
)
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .flatMap((table) => {
    const tenantCol = Object.values(getTableColumns(table)).find((c) => c.name === 'tenant_id');
    return tenantCol ? [[getTableName(table), table, tenantCol] as [string, MySqlTable, MySqlColumn]] : [];
  });

export interface SeededTenant {
  tenantId: string;
  ownerUserId: string;
  ownerToken: string;
  ownerMembershipId: string;
  creatorUserId: string;
  creatorToken: string;
  creatorMembershipId: string;
  brandIds: [string, string];
  servicePrincipalId: string;
  apiClientId: string;
  apiClientKey: string;
  /** Every id a foreign caller might try to use. */
  ids: Record<string, string>;
  snapshot(): Promise<string>;
}

async function seedTenant(db: Db, label: string): Promise<SeededTenant> {
  const tenantId = newId('tenant');
  const ownerUserId = newId('user');
  const creatorUserId = newId('user');
  const ownerMembershipId = newId('membership');
  const creatorMembershipId = newId('membership');
  const brandIds: [string, string] = [newId('brand'), newId('brand')];
  const servicePrincipalId = newId('servicePrincipal');
  const apiClientId = newId('apiClient');
  // sql``, not insert(tenants).values(), for the reason given at the brands below (tenants.kind, 0030).
  await db.execute(
    sql`insert into ${tenants} (id, name, slug, created_at, updated_at) values (${tenantId}, ${`Tenant ${label}`}, ${`t-${label}-${tenantId.slice(-8).toLowerCase()}`}, ${new Date()}, ${new Date()})`,
  );
  // sql``, not insert(users).values(), for the reason given at the brands below (users.password_origin, 0013).
  for (const [id, role] of [
    [ownerUserId, 'owner'],
    [creatorUserId, 'creator'],
  ] as const)
    await db.execute(
      sql`insert into ${users} (id, email, name, created_at, updated_at) values (${id}, ${`${label}-${role}-${tenantId.slice(-6).toLowerCase()}@example.test`}, ${`${label} ${role}`}, ${new Date()}, ${new Date()})`,
    );
  await db.insert(memberships).values([
    {
      id: ownerMembershipId,
      tenantId,
      userId: ownerUserId,
      role: 'owner',
      status: 'active',
      allBrands: true,
    },
    {
      id: creatorMembershipId,
      tenantId,
      userId: creatorUserId,
      role: 'creator',
      status: 'active',
      allBrands: false,
    },
  ]);
  // Written with sql``, not insert(brands).values(): Drizzle lists every column of the current schema object (unset
  // ones as `default`), and the migration roll-forward suites seed databases at earlier heads that lack the columns
  // added since (brands.classification, 0009). These columns exist at every head; later columns take their defaults.
  for (const [i, brandId] of brandIds.entries())
    await db.execute(
      sql`insert into ${brands} (id, tenant_id, name, timezone, default_locale, status, created_at, updated_at) values (${brandId}, ${tenantId}, ${`${label} brand ${i + 1}`}, 'UTC', 'en', 'active', ${new Date()}, ${new Date()})`,
    );
  // The creator is restricted to brand 1 only.
  await db.insert(brandGrants).values({
    id: newId('brandGrant'),
    tenantId,
    membershipId: creatorMembershipId,
    brandId: brandIds[0],
    roles: [],
  });
  await db.insert(servicePrincipals).values({
    id: servicePrincipalId,
    tenantId,
    kind: 'agent',
    name: `${label} agent`,
    grants: [{ action: 'brand.read', brandIds: 'all' }],
    maxAutonomy: 'create',
    status: 'active',
    createdByUserId: ownerUserId,
  });
  const apiKey = newOpaqueToken('ak');
  await db.insert(apiClients).values({
    id: apiClientId,
    tenantId,
    servicePrincipalId,
    keyHash: apiKey.hash,
    keyPrefix: apiKey.prefixForLookup,
    scopes: [],
  });
  const ownerToken = `ses_${randomUUID()}`;
  const creatorToken = `ses_${randomUUID()}`;
  await db.insert(sessions).values([
    {
      id: newId('session'),
      userId: ownerUserId,
      tokenHash: hashToken(ownerToken),
      selectedTenantId: tenantId,
      expiresAt: new Date(Date.now() + 3600_000),
    },
    {
      id: newId('session'),
      userId: creatorUserId,
      tokenHash: hashToken(creatorToken),
      selectedTenantId: tenantId,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  ]);
  const extraIds: Record<string, string> = {};
  for (const ext of SEED_EXTENSIONS)
    Object.assign(extraIds, await ext(db, { tenantId, brandIds, ownerUserId }));
  const snapshot = async () => {
    // Row count per tenant-scoped table, keyed by table name (in schema order, so the JSON is stable and a diff
    // names the table that received a write).
    const counts = Object.fromEntries(
      await Promise.all(
        TENANT_TABLES.map(([name, table, tenantCol]) =>
          db
            .select({ c: sql<number>`count(*)` })
            .from(table)
            .where(eq(tenantCol, tenantId))
            .then((r) => [name, Number(r[0]?.c ?? 0)] as const),
        ),
      ),
    );
    const m = await db.select().from(memberships).where(eq(memberships.tenantId, tenantId));
    const sp = await db.select().from(servicePrincipals).where(eq(servicePrincipals.tenantId, tenantId));
    const ac = await db.select().from(apiClients).where(eq(apiClients.tenantId, tenantId));
    return JSON.stringify({ counts, m, sp, ac });
  };
  return {
    tenantId,
    ownerUserId,
    ownerToken,
    ownerMembershipId,
    creatorUserId,
    creatorToken,
    creatorMembershipId,
    brandIds,
    servicePrincipalId,
    apiClientId,
    apiClientKey: apiKey.token,
    ids: {
      tenantId,
      membershipId: creatorMembershipId,
      brandId: brandIds[0],
      brandId2: brandIds[1],
      servicePrincipalId,
      apiClientId,
      userId: creatorUserId,
      ...extraIds,
    },
    snapshot,
  };
}

/**
 * An extra service principal with its own API client key (spec 7.6 per-key scopes), for tests of the public REST
 * API and the MCP server. The principal's grants decide what the policy engine allows; the scopes narrow the key.
 */
export async function seedApiClient(
  db: Db,
  tenant: Pick<SeededTenant, 'tenantId' | 'ownerUserId'>,
  opts: {
    grants: Array<{ action: string; brandIds: string[] | 'all' }>;
    scopes: string[];
    maxAutonomy?: 'assist' | 'create' | 'prepare_release' | 'managed_autopublish';
    kind?: 'agent' | 'api_client' | 'mcp_client' | 'integration';
  },
): Promise<{ servicePrincipalId: string; apiClientId: string; key: string }> {
  const servicePrincipalId = newId('servicePrincipal');
  const apiClientId = newId('apiClient');
  await db.insert(servicePrincipals).values({
    id: servicePrincipalId,
    tenantId: tenant.tenantId,
    kind: opts.kind ?? 'mcp_client',
    name: `client ${servicePrincipalId.slice(-6)}`,
    grants: opts.grants as (typeof servicePrincipals.$inferInsert)['grants'],
    maxAutonomy: opts.maxAutonomy ?? 'create',
    status: 'active',
    createdByUserId: tenant.ownerUserId,
  });
  const key = newOpaqueToken('ak');
  await db.insert(apiClients).values({
    id: apiClientId,
    tenantId: tenant.tenantId,
    servicePrincipalId,
    keyHash: key.hash,
    keyPrefix: key.prefixForLookup,
    scopes: opts.scopes,
  });
  return { servicePrincipalId, apiClientId, key: key.token };
}

/**
 * A member of the tenant restricted to some of its brands (allBrands false, one grant per brand), with a live session:
 * for checks that a brand-restricted member reaches only those brands and hands out no more than them.
 */
export async function seedRestrictedMember(
  db: Db,
  tenant: Pick<SeededTenant, 'tenantId'>,
  opts: { role: 'admin' | 'brand_manager' | 'creator'; brandIds: string[] },
): Promise<{ userId: string; membershipId: string; token: string }> {
  const userId = newId('user');
  const membershipId = newId('membership');
  const token = `ses_${randomUUID()}`;
  await db.execute(
    sql`insert into ${users} (id, email, name, created_at, updated_at) values (${userId}, ${`${userId.toLowerCase()}@example.test`}, ${`restricted ${opts.role}`}, ${new Date()}, ${new Date()})`,
  );
  await db.insert(memberships).values({
    id: membershipId,
    tenantId: tenant.tenantId,
    userId,
    role: opts.role,
    status: 'active',
    allBrands: false,
  });
  for (const brandId of opts.brandIds)
    await db
      .insert(brandGrants)
      .values({ id: newId('brandGrant'), tenantId: tenant.tenantId, membershipId, brandId, roles: [] });
  await db.insert(sessions).values({
    id: newId('session'),
    userId,
    tokenHash: hashToken(token),
    selectedTenantId: tenant.tenantId,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { userId, membershipId, token };
}

/**
 * Columns added to tables that already existed, after the migrations the roll-forward suites start from. A suite that
 * seeds an earlier head selects its snapshot without them (Drizzle would name them, and they do not exist yet).
 */
export const LATER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  brands: ['classification'], // 0009
  messages: ['parent_remote_message_id'], // 0012
  response_drafts: [
    'reply_to_message_id',
    'sent_at',
    'outbound_message_id',
    'failure_code',
    'failure_detail',
  ], // 0012
  users: ['password_origin'], // 0013
  brand_destinations: [
    'token_expires_at',
    'reporting_time_zone',
    'currency_code',
    'reporting_zone_checked_at',
    'write_safety',
    'write_safety_checked_at',
    'article_selector',
  ], // 0016, 0021, 0031, 0032
  channel_variants: ['destination_id'], // 0018
  publications: ['destination_id', 'remote_status', 'remote_verification', 'remote_verified_at'], // 0018, 0020
  channel_connections: ['health', 'health_checked_at'], // 0022
  destination_report_rows: ['time_zone', 'quality'], // 0021
  approved_facts: [
    'category',
    'scope',
    'origin',
    'sources',
    'review_due_at',
    'reviewed_by_user_id',
    'reviewed_at',
    'superseded_by_fact_id',
    'supersedes_fact_id',
    'revoke_reason',
    'conflicts',
    'dedupe_key',
    'review_flagged_at',
    'expiry_notified_at',
  ], // 0023
  creative_revisions: ['generation_inputs'], // 0025
  asset_versions: ['media_info'], // 0026
  upload_intents: ['rejection_detail'], // 0026
  render_jobs: ['progress'], // 0026
  rendered_exports: ['duration_ms', 'fps', 'poster_storage_key', 'captions_storage_key', 'dedupe_key'], // 0026, 0027
  creative_documents: ['kind', 'archived_at'], // 0027, 0029
  tenants: ['kind'], // 0030
};

/** Tables created after every head the older roll-forward suites seed; their snapshots leave them out. */
export const LATER_TABLE_NAMES: readonly string[] = [
  'studio_video_jobs', // 0028
  'reports', // 0033
  'report_preferences', // 0033
];

/** The table's columns that exist at every head the roll-forward suites seed (LATER_COLUMNS left out). */
export function snapshotColumns(table: MySqlTable): Record<string, MySqlColumn> {
  const later = LATER_COLUMNS[getTableName(table)] ?? [];
  return Object.fromEntries(
    Object.entries(getTableColumns(table) as Record<string, MySqlColumn>).filter(
      ([, c]) => !later.includes(c.name),
    ),
  );
}

export async function seedTwoTenants(db: Db): Promise<{ tenantA: SeededTenant; tenantB: SeededTenant }> {
  composeModules();
  return { tenantA: await seedTenant(db, 'a'), tenantB: await seedTenant(db, 'b') };
}

export interface CallOptions {
  bearer: string;
  tenantId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  /**
   * Present the credential as a browser cookie session instead of a bearer header. `csrf` is the double-submit
   * header value; the cookie always carries the token, so omitting `csrf` models a request without the header.
   */
  cookieSession?: { csrf?: string };
}

export const CSRF_TOKEN = 'csrf-test-token';

/** The headers an HTTP request with these options carries. */
export function headersFor(opts: CallOptions): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {
    'idempotency-key': opts.idempotencyKey ?? randomUUID(),
    'x-correlation-id': opts.correlationId ?? `test-${randomUUID()}`,
  };
  if (opts.cookieSession) {
    headers['cookie'] = `${SESSION_COOKIE}=${opts.bearer}; ${CSRF_COOKIE}=${CSRF_TOKEN}`;
    if (opts.cookieSession.csrf) headers['x-oremedia-csrf'] = opts.cookieSession.csrf;
  } else headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.tenantId) headers['x-oremedia-tenant'] = opts.tenantId;
  return headers;
}

/** The request context an HTTP request with these options would get (headers → context). */
export async function contextFor(opts: CallOptions) {
  return createContext(headersFor(opts));
}

/** In-process caller with the same context builder as HTTP. */
export async function callerFor(opts: CallOptions) {
  return appRouter.createCaller(await contextFor(opts));
}

/** Calls a procedure by dotted path with the given input; returns either the data or the error envelope. */
export async function callPath(
  opts: CallOptions,
  path: string,
  input: unknown,
): Promise<{ data?: unknown; error?: ErrorEnvelope; trpcCode?: string }> {
  const ctx = await contextFor(opts);
  const caller = appRouter.createCaller(ctx);
  const fn = path.split('.').reduce<unknown>((acc, seg) => (acc as Record<string, unknown>)[seg], caller) as (
    i: unknown,
  ) => Promise<unknown>;
  try {
    return { data: await fn(input) };
  } catch (err) {
    if (err instanceof TRPCError) return { error: envelopeFor(err, ctx.correlationId), trpcCode: err.code };
    throw err;
  }
}

export { runInTenant };

const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A random id in the domain's shape (prefix and 26 Crockford characters). */
export const rid = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => ULID[Math.floor(Math.random() * 32)]).join('')}`;

/**
 * A minimal valid row for any tenant-scoped table: required columns filled by type, tenant and brand set, and
 * every foreign key pointed at an existing parent row of the same tenant (parents are filled first; a user is the
 * tenant's owner).
 */
export async function fillEmptyTables(db: Db, t: SeededTenant): Promise<string[]> {
  const filled: string[] = [];
  const tables = purgeOrder(tenantScopedTables()).reverse(); // parents before children
  for (const table of tables) {
    const name = getTableName(table);
    const cols = Object.values(getTableColumns(table)) as MySqlColumn[];
    const tenantCol = cols.find((c) => c.name === 'tenant_id')!;
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .where(eq(tenantCol, t.tenantId));
    if (Number(n) > 0) continue;
    const row: Record<string, unknown> = {};
    for (const c of cols) {
      const key = Object.entries(getTableColumns(table)).find(([, v]) => v === c)![0];
      if (c.name === 'tenant_id') row[key] = t.tenantId;
      else if (c.name === 'brand_id') row[key] = t.brandIds[0];
      else if (c.name === 'id') row[key] = rid(name.slice(0, 3));
      else if (!c.notNull || c.hasDefault) continue;
      else {
        const values = (c as unknown as { enumValues?: string[] }).enumValues;
        if (values?.length) row[key] = values[0];
        else if (c.dataType === 'number' || c.dataType === 'bigint') row[key] = 0;
        else if (c.dataType === 'boolean') row[key] = false;
        else if (c.dataType === 'date') row[key] = new Date();
        else if (c.dataType === 'json') row[key] = {};
        else row[key] = `x${Math.random().toString(36).slice(2, 10)}`;
      }
    }
    for (const fk of getTableConfig(table).foreignKeys) {
      const ref = fk.reference();
      const parent = ref.foreignTable as MySqlTable;
      const parentCols = Object.values(getTableColumns(parent)) as MySqlColumn[];
      const parentTenant = parentCols.find((c) => c.name === 'tenant_id');
      const parentBrand = parentCols.find((c) => c.name === 'brand_id');
      // The parent in the same tenant and, where the key carries the brand, the same brand (brand 1).
      const brandAt = ref.columns.findIndex((c) => c.name === 'brand_id');
      const brandKey = brandAt >= 0 ? ref.foreignColumns[brandAt] : parentBrand;
      // A global parent is the tenant row itself, or (users) the tenant's owner.
      const globalParentId = getTableName(parent) === 'users' ? t.ownerUserId : t.tenantId;
      const where = [
        parentTenant
          ? eq(parentTenant, t.tenantId)
          : eq(
              parentCols.find((c) => c.name === 'id')!,
              globalParentId,
            ),
        ...(brandKey ? [eq(brandKey, t.brandIds[0])] : []),
      ];
      const [p] = await db
        .select()
        .from(parent)
        .where(and(...where))
        .limit(1);
      if (!p) throw new Error(`no ${getTableName(parent)} row of the tenant for ${name}`);
      ref.columns.forEach((c, i) => {
        const key = Object.entries(getTableColumns(table)).find(([, v]) => v === c)![0];
        const pKey = Object.entries(getTableColumns(parent)).find(([, v]) => v === ref.foreignColumns[i])![0];
        row[key] = (p as Record<string, unknown>)[pKey];
      });
    }
    await db.insert(table).values(row as never);
    filled.push(name);
  }
  return filled;
}
