import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';
import type { FeatureFlagState } from '@oremedia/contracts/operations';
import { sessions, users } from '@oremedia/db/schema/access';
import { auditEvents, featureFlags } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { accessService, hashToken } from '@oremedia/module-access';
import { featureFlag } from '@oremedia/module-operations';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import {
  callPath,
  seedApiClient,
  seedTwoTenants,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src';
import { configureRateLimiter } from './trpc';

const newId = (kind: IdKind) =>
  `${ID_PREFIXES[kind]}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/**
 * G05: operations.flags.set is the only way to turn an engineering flag on. Platform operators only (a support
 * session on the tenant, escalated by a second operator to write); tenant members and API keys are refused and the
 * refusal is audited; a change is version-checked, idempotent, audited with its supportSessionId, and a session
 * bound to tenant A can target tenant A or every tenant, never tenant B.
 */
describe('operations.flags.set (G05)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const KEY = 'experiments.randomised' as const;

  const newOperator = async () => {
    const userId = newId('user');
    const tokenPart = randomUUID();
    await tdb.db
      .insert(users)
      .values({ id: userId, email: `${userId.toLowerCase()}@ops.example.test`, name: 'op' });
    await tdb.db.insert(sessions).values({
      id: newId('session'),
      userId,
      tokenHash: hashToken(`ses_${tokenPart}`),
      selectedTenantId: null,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return { userId, tokenPart };
  };
  const open = async (op: { userId: string; tokenPart: string }, tenantId: string) => {
    const { supportSessionId } = await accessService.openSupportSession(
      op.userId,
      {
        tenantId,
        reason: 'pilot opt-in for randomised experiments',
        ticketRef: 'OPS-77',
        consentRecorded: true,
        durationMinutes: 60,
      },
      `corr-${randomUUID()}`,
    );
    return { supportSessionId, bearer: `sup_${op.tokenPart}.${supportSessionId}` };
  };
  /** A support session on `tenantId`, escalated by a second operator. */
  const escalated = async (tenantId: string) => {
    const s = await open(await newOperator(), tenantId);
    const approver = await open(await newOperator(), tenantId);
    const res = await callPath({ bearer: approver.bearer, tenantId }, 'access.supportSessions.escalate', {
      supportSessionId: s.supportSessionId,
      reason: 'second operator approves the flag change in OPS-77',
    });
    expect(res.error).toBeUndefined();
    return s;
  };
  const flagRow = async () =>
    (await tdb.db.select().from(featureFlags).where(eq(featureFlags.key, KEY)))[0] ?? null;
  const flagAudit = (tenantId: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.resourceType, 'feature_flag')))
      .orderBy(auditEvents.createdAt, auditEvents.id);
  const enabledFor = (tenantId: string) => featureFlag.isEnabled(KEY, tenantId);
  const stateIn = (list: unknown) => (list as FeatureFlagState[]).find((f) => f.key === KEY)!;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('tenant members, API keys and agents can neither list nor set flags; each refusal is audited and nothing is written', async () => {
    // Keys holding every operations scope and the owner's operational grants still reach the service and are refused.
    const keyOf = async (kind: 'api_client' | 'agent') =>
      (
        await seedApiClient(tdb.db, tenantA, {
          kind,
          grants: ['audit.read', 'billing.manage'].map((action) => ({ action, brandIds: 'all' as const })),
          scopes: ['operations:read', 'operations:write'],
          maxAutonomy: 'managed_autopublish',
        })
      ).key;
    const bearers = [
      tenantA.ownerToken,
      tenantA.creatorToken,
      await keyOf('api_client'),
      await keyOf('agent'),
    ];
    const input = {
      key: KEY,
      target: { kind: 'global' },
      enabled: true,
      expectedVersion: null,
      reason: 'member tries to turn it on',
    };
    for (const bearer of bearers) {
      const set = await callPath({ bearer, tenantId: tenantA.tenantId }, 'operations.flags.set', input);
      expect(set.error).toMatchObject({ code: 'FORBIDDEN' });
      const list = await callPath({ bearer, tenantId: tenantA.tenantId }, 'operations.flags.list', undefined);
      expect(list.error).toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await flagRow()).toBeNull();
    expect(await enabledFor(tenantA.tenantId)).toBe(false);
    const refusals = (await flagAudit(tenantA.tenantId)).filter((r) => r.decision === 'denied');
    expect(refusals.length).toBe(8);
    expect(new Set(refusals.map((r) => r.reason))).toEqual(new Set(['platform_operator_required']));
    expect(new Set(refusals.map((r) => r.actorKind))).toEqual(new Set(['user', 'service_principal']));
  });

  it('a read-only support session lists flags but cannot set one', async () => {
    const s = await open(await newOperator(), tenantA.tenantId);
    const list = await callPath(
      { bearer: s.bearer, tenantId: tenantA.tenantId },
      'operations.flags.list',
      undefined,
    );
    expect(list.error).toBeUndefined();
    expect(stateIn(list.data)).toMatchObject({
      globalEnabled: false,
      tenantTargeted: false,
      enabledForTenant: false,
      version: null,
    });
    const set = await callPath({ bearer: s.bearer, tenantId: tenantA.tenantId }, 'operations.flags.set', {
      key: KEY,
      target: { kind: 'tenant', tenantId: tenantA.tenantId },
      enabled: true,
      expectedVersion: null,
      reason: 'read-only session tries to write',
    });
    expect(set.error).toMatchObject({ code: 'FORBIDDEN' });
    expect(await flagRow()).toBeNull();
    const refusal = (await flagAudit(tenantA.tenantId)).find(
      (r) => r.supportSessionId === s.supportSessionId && r.decision === 'denied',
    );
    expect(refusal).toMatchObject({ actorKind: 'platform_operator', reason: 'support_read_only' });
  });

  it('an escalated operator turns a flag on for their tenant only: version-checked, idempotent, audited', async () => {
    const s = await escalated(tenantA.tenantId);
    const call = (input: unknown, idempotencyKey?: string) =>
      callPath(
        { bearer: s.bearer, tenantId: tenantA.tenantId, ...(idempotencyKey ? { idempotencyKey } : {}) },
        'operations.flags.set',
        input,
      );
    const on = {
      key: KEY,
      target: { kind: 'tenant', tenantId: tenantA.tenantId },
      enabled: true,
      expectedVersion: null,
      reason: 'pilot brand opted in (OPS-77)',
    };

    const first = await call(on, 'flag-on-1');
    expect(first.error).toBeUndefined();
    expect(first.data).toMatchObject({
      changed: true,
      flag: { tenantTargeted: true, enabledForTenant: true },
    });
    const created = await flagRow();
    expect(created).toMatchObject({ enabledDefault: false, targeting: { tenantIds: [tenantA.tenantId] } });
    expect(await enabledFor(tenantA.tenantId)).toBe(true);
    expect(await enabledFor(tenantB.tenantId)).toBe(false);
    const snapshot = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'operations.flags.snapshot',
      undefined,
    );
    expect((snapshot.data as Record<string, boolean>)[KEY]).toBe(true);

    // The same request replayed with its idempotency key: the stored response, nothing written again.
    const replay = await call(on, 'flag-on-1');
    expect(replay.data).toEqual(first.data);
    expect((await flagRow())?.version).toBe(created!.version);

    // A stale version (the caller still thinks there is no row) is CONFLICT and writes nothing.
    const stale = await call({ ...on, enabled: false });
    expect(stale.error).toMatchObject({ code: 'CONFLICT' });
    expect(await enabledFor(tenantA.tenantId)).toBe(true);

    // The state it is already in: no write, the version stays.
    const same = await call({ ...on, expectedVersion: created!.version });
    expect(same.data).toMatchObject({ changed: false, flag: { version: created!.version } });
    expect((await flagRow())?.version).toBe(created!.version);

    // Off again for the tenant, with the current version.
    const off = await call({ ...on, enabled: false, expectedVersion: created!.version });
    expect(off.data).toMatchObject({
      changed: true,
      flag: { tenantTargeted: false, enabledForTenant: false },
    });
    expect((await flagRow())?.version).toBe(created!.version + 1);
    expect(await enabledFor(tenantA.tenantId)).toBe(false);

    const allowed = (await flagAudit(tenantA.tenantId)).filter(
      (r) => r.supportSessionId === s.supportSessionId && r.decision === 'allowed',
    );
    expect(allowed.map((r) => r.metadata)).toEqual([
      expect.objectContaining({
        flag: KEY,
        scope: 'tenant',
        fromState: 'off',
        toState: 'on',
        expectedVersion: null,
      }),
      expect.objectContaining({ flag: KEY, scope: 'tenant', fromState: 'on', toState: 'on' }),
      expect.objectContaining({ flag: KEY, scope: 'tenant', fromState: 'on', toState: 'off' }),
    ]);
    expect(allowed.every((r) => r.actorKind === 'platform_operator' && r.action === 'feature_flag.set')).toBe(
      true,
    );
  });

  it('a session bound to tenant A cannot target tenant B; global on reaches every tenant and global off withdraws it', async () => {
    const s = await escalated(tenantA.tenantId);
    const version = (await flagRow())!.version;
    const foreign = await callPath({ bearer: s.bearer, tenantId: tenantA.tenantId }, 'operations.flags.set', {
      key: KEY,
      target: { kind: 'tenant', tenantId: tenantB.tenantId },
      enabled: true,
      expectedVersion: version,
      reason: 'operator of A targets B',
    });
    expect(foreign.error).toMatchObject({ code: 'FORBIDDEN' });
    expect((await flagRow())?.version).toBe(version);
    expect(await enabledFor(tenantB.tenantId)).toBe(false);
    expect(
      (await flagAudit(tenantA.tenantId)).some(
        (r) => r.supportSessionId === s.supportSessionId && r.reason === 'tenant_mismatch',
      ),
    ).toBe(true);
    expect(await flagAudit(tenantB.tenantId)).toEqual([]); // nothing landed in tenant B's trail

    const set = (enabled: boolean, expectedVersion: number) =>
      callPath({ bearer: s.bearer, tenantId: tenantA.tenantId }, 'operations.flags.set', {
        key: KEY,
        target: { kind: 'global' },
        enabled,
        expectedVersion,
        reason: 'general availability',
      });
    expect((await set(true, version)).error).toBeUndefined();
    expect(await enabledFor(tenantA.tenantId)).toBe(true);
    expect(await enabledFor(tenantB.tenantId)).toBe(true);
    expect((await set(false, version + 1)).error).toBeUndefined();
    expect(await enabledFor(tenantB.tenantId)).toBe(false);
  });

  it('rows of removed flags (studio.agent_proposals, publishing.channel.*) stay harmless: ignored by every read', async () => {
    await tdb.db.insert(featureFlags).values(
      ['studio.agent_proposals', 'publishing.channel.linkedin_page'].map((key) => ({
        key,
        enabledDefault: true,
        targeting: { tenantIds: [tenantA.tenantId] },
        owner: 'legacy',
        removalDate: new Date('2027-03-31T00:00:00Z'),
        successMetric: 'removed',
      })),
    );
    const snapshot = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'operations.flags.snapshot',
      undefined,
    );
    expect(snapshot.error).toBeUndefined();
    expect(Object.keys(snapshot.data as object)).not.toContain('studio.agent_proposals');
    const s = await open(await newOperator(), tenantA.tenantId);
    const list = await callPath(
      { bearer: s.bearer, tenantId: tenantA.tenantId },
      'operations.flags.list',
      undefined,
    );
    expect((list.data as FeatureFlagState[]).map((f) => f.key)).not.toContain(
      'publishing.channel.linkedin_page',
    );
  });
});
