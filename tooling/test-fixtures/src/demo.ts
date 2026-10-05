import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { composeModules } from '@oremedia/api';
import type { Db } from '@oremedia/db';
import { sessions, users } from '@oremedia/db/schema/access';
import { newId } from '@oremedia/domain/ids';
import { accessService, hashToken } from '@oremedia/module-access';
import { callPath, seedApiClient } from './seed';

export interface SeededDemoTenant {
  tenantId: string;
  ownerUserId: string;
  ownerToken: string;
  /** A brand created through brand.create in the demo (so it carries the demo's zero daily spend limit). */
  brandId: string;
  /**
   * An API key of the demo, written straight to the database: the services refuse to create one in a demo
   * (apiClients.create), but the tests need one to prove the REST and MCP surfaces refuse what tRPC refuses.
   */
  apiClientKey: string;
  servicePrincipalId: string;
}

/**
 * TEST ONLY (demo workspace stage 2, architecture §11): a demo company (`tenants.kind = 'demo'`) for one fresh person,
 * created the way stage 4's provisioning will create it, through accessService.createTenantWithOwner with kind
 * `demo` (which sets its zero spend limits). No production path creates a demo company in this stage.
 */
export async function seedDemoTenant(db: Db, label = 'demo'): Promise<SeededDemoTenant> {
  composeModules();
  const suffix = randomUUID().slice(0, 8);
  const ownerUserId = newId('user');
  await db.execute(
    sql`insert into ${users} (id, email, name, created_at, updated_at) values (${ownerUserId}, ${`${label}-${suffix}@example.test`}, ${`${label} owner`}, ${new Date()}, ${new Date()})`,
  );
  const { tenantId } = await accessService.createTenantWithOwner(
    { name: 'Ore & Tar · Demo', slug: `demo-${label}-${suffix}` },
    ownerUserId,
    `test-${randomUUID()}`,
    undefined,
    'demo',
  );
  const ownerToken = `ses_${randomUUID()}`;
  await db.insert(sessions).values({
    id: newId('session'),
    userId: ownerUserId,
    tokenHash: hashToken(ownerToken),
    selectedTenantId: tenantId,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const created = await callPath({ bearer: ownerToken }, 'brand.create', {
    name: 'Ore & Tar (demo)',
    timezone: 'Africa/Harare',
    defaultLocale: 'en',
    classification: 'internal',
  });
  if (created.error) throw new Error(`demo brand.create failed: ${created.error.code}`);
  const brandId = (created.data as { brandId: string }).brandId;
  const client = await seedApiClient(
    db,
    { tenantId, ownerUserId },
    {
      grants: [
        { action: 'brand.read', brandIds: 'all' },
        { action: 'agent.start_run', brandIds: 'all' },
      ],
      scopes: ['brands:read', 'agents:read', 'agents:write'],
      kind: 'mcp_client',
    },
  );
  return {
    tenantId,
    ownerUserId,
    ownerToken,
    brandId,
    apiClientKey: client.key,
    servicePrincipalId: client.servicePrincipalId,
  };
}
