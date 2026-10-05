import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { EventType } from '@oremedia/contracts/events';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { outbox } from './outbox';
import { DEMO_SUPPRESSED, dispatchBatch, type WorkflowStarter } from './outbox-dispatcher';
import {
  clearOutboxRoutes,
  configureTenantKindResolver,
  registerOutboxRoute,
  tenantKindForDispatch,
  type OutboxRoute,
} from './outbox-routes';

/**
 * Demo workspace stage 2 (architecture §4.3): the dispatcher routes a demo company's events by their registration's
 * demo option and suppresses every other event of a demo (fail-closed), while a live company's events are dispatched
 * exactly as before. A tenant whose kind cannot be read is never dispatched as live.
 */
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: 'usr_demo_dispatch' },
  brandIds: 'all',
  correlationId: 'corr_demo_dispatch',
});

class RecordingStarter implements WorkflowStarter {
  calls: Array<{ workflowId: string; workflowType: string; tenantId: string }> = [];
  async start(req: Parameters<WorkflowStarter['start']>[0]): Promise<void> {
    this.calls.push({ workflowId: req.workflowId, workflowType: req.workflowType, tenantId: req.tenantId });
  }
}

const routeTo =
  (workflowType: string): OutboxRoute =>
  (evt) => ({ workflowType, taskQueue: 'core', workflowId: `${workflowType}:${evt.id}`, args: [] });

describe('outbox dispatcher: demo workspaces (architecture §4.3)', () => {
  let tdb: TestDatabase;
  const live = newId('tenant');
  const demo = newId('tenant');

  const emit = (tenantId: string, eventType: EventType) =>
    runInTenant(ctx(tenantId), () =>
      withTransaction(undefined, (tx) =>
        outbox.add(eventType, { type: 'test_aggregate', id: newId('agentRun'), version: 0 }, {}, tx),
      ),
    );
  const row = async (id: string) =>
    (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.id, id)))[0];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: live, name: 'Live', slug: 'obd-live-' + live.slice(-6).toLowerCase() },
      { id: demo, name: 'Demo', slug: 'obd-demo-' + demo.slice(-6).toLowerCase(), kind: 'demo' },
    ]);
    // As worker-core wires it (module-access tenantKinds), read here from the row so the module stays alone.
    configureTenantKindResolver(async (tenantId) => {
      const [t] = await tdb.db.select({ kind: tenants.kind }).from(tenants).where(eq(tenants.id, tenantId));
      if (!t) throw new Error(`unknown tenant ${tenantId}`);
      return t.kind;
    });
  });
  afterAll(async () => {
    configureTenantKindResolver(null);
    await tdb?.drop();
  });
  afterEach(async () => {
    clearOutboxRoutes();
    await tdb.db.delete(outboxEvents);
  });

  it('a demo’s events with no demo route are suppressed (nothing starts) and a live company’s are dispatched unchanged', async () => {
    registerOutboxRoute('agent.run_requested', routeTo('agentRunWorkflowV1'));
    registerOutboxRoute('publication.scheduled', routeTo('publicationWorkflowV1'));
    registerOutboxRoute('asset.upload_completed', routeTo('assetIngestWorkflowV1'), { demo: 'same' });
    registerOutboxRoute('community.reply_requested', routeTo('communityReplyWorkflowV1'), {
      demo: routeTo('simulatedCommunityReplyWorkflowV1'),
    });
    const starter = new RecordingStarter();
    const liveRun = await emit(live, 'agent.run_requested');
    const livePub = await emit(live, 'publication.scheduled');
    const liveAsset = await emit(live, 'asset.upload_completed');
    const liveReply = await emit(live, 'community.reply_requested');
    const liveInfo = await emit(live, 'brand.fact_expired'); // no route at all: informational for a live company
    const demoRun = await emit(demo, 'agent.run_requested');
    const demoPub = await emit(demo, 'publication.scheduled');
    const demoAsset = await emit(demo, 'asset.upload_completed');
    const demoReply = await emit(demo, 'community.reply_requested');
    const demoInfo = await emit(demo, 'brand.fact_expired');

    const summary = await dispatchBatch({ workerId: 'w-demo', starter });
    expect(summary).toEqual({ claimed: 10, dispatched: 6, ignored: 4, failed: 0 });

    const started = (tenantId: string) =>
      starter.calls
        .filter((c) => c.tenantId === tenantId)
        .map((c) => c.workflowType)
        .sort();
    expect(started(live)).toEqual([
      'agentRunWorkflowV1',
      'assetIngestWorkflowV1',
      'communityReplyWorkflowV1',
      'publicationWorkflowV1',
    ]);
    // The demo started only what its registrations allow: the shared ingest and its own simulated reply.
    expect(started(demo)).toEqual(['assetIngestWorkflowV1', 'simulatedCommunityReplyWorkflowV1']);

    for (const id of [liveRun, livePub, liveAsset, liveReply, liveInfo, demoAsset, demoReply])
      expect(await row(id)).toMatchObject({ lastError: null, attempts: 0 });
    for (const id of [demoRun, demoPub, demoInfo]) {
      const r = await row(id);
      expect(r?.dispatchedAt).toBeInstanceOf(Date);
      expect(r).toMatchObject({ lastError: DEMO_SUPPRESSED, attempts: 0 });
    }
    const audit = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, demo), eq(auditEvents.action, 'outbox.demo_suppressed')));
    expect(audit.map((a) => [a.decision, a.reason, a.actorKind]).sort()).toEqual([
      ['denied', DEMO_SUPPRESSED, 'system'],
      ['denied', DEMO_SUPPRESSED, 'system'],
      ['denied', DEMO_SUPPRESSED, 'system'],
    ]);
    expect(
      (await tdb.db.select().from(auditEvents).where(eq(auditEvents.tenantId, live))).filter(
        (a) => a.action === 'outbox.demo_suppressed',
      ),
    ).toEqual([]);

    // Suppressed rows are done: a second pass starts nothing.
    expect(await dispatchBatch({ workerId: 'w-demo', starter })).toEqual({
      claimed: 0,
      dispatched: 0,
      ignored: 0,
      failed: 0,
    });
    expect(starter.calls).toHaveLength(6);
  });

  it('re-registering a route without a demo option drops the old option (the demo is suppressed again)', async () => {
    registerOutboxRoute('asset.upload_completed', routeTo('assetIngestWorkflowV1'), { demo: 'same' });
    registerOutboxRoute('asset.upload_completed', routeTo('assetIngestWorkflowV1'));
    const starter = new RecordingStarter();
    const id = await emit(demo, 'asset.upload_completed');
    await dispatchBatch({ workerId: 'w-demo', starter });
    expect(starter.calls).toEqual([]);
    expect(await row(id)).toMatchObject({ lastError: DEMO_SUPPRESSED });
  });

  it('a tenant whose kind cannot be read is not dispatched (the row fails and is retried, never run as live)', async () => {
    registerOutboxRoute('agent.run_requested', routeTo('agentRunWorkflowV1'));
    const starter = new RecordingStarter();
    const id = await emit(live, 'agent.run_requested');
    configureTenantKindResolver(async () => {
      throw new Error('tenant kind unavailable');
    });
    try {
      const summary = await dispatchBatch({ workerId: 'w-demo', starter });
      expect(summary).toMatchObject({ claimed: 1, dispatched: 0, failed: 1 });
    } finally {
      configureTenantKindResolver(async (tenantId) => {
        const [t] = await tdb.db.select({ kind: tenants.kind }).from(tenants).where(eq(tenants.id, tenantId));
        if (!t) throw new Error(`unknown tenant ${tenantId}`);
        return t.kind;
      });
    }
    expect(starter.calls).toEqual([]);
    const r = await row(id);
    expect(r?.dispatchedAt).toBeNull();
    expect(r?.attempts).toBe(1);
    expect(r?.lastError).toContain('tenant kind unavailable');
  });

  it('an unwired resolver refuses to dispatch in production and reads every tenant as live elsewhere', async () => {
    configureTenantKindResolver(null);
    try {
      await expect(tenantKindForDispatch(demo, 'c', { NODE_ENV: 'production' })).rejects.toThrow(
        /not configured/,
      );
      await expect(tenantKindForDispatch(demo, 'c', { NODE_ENV: 'test' })).resolves.toBe('live');
    } finally {
      configureTenantKindResolver(async (tenantId) => {
        const [t] = await tdb.db.select({ kind: tenants.kind }).from(tenants).where(eq(tenants.id, tenantId));
        if (!t) throw new Error(`unknown tenant ${tenantId}`);
        return t.kind;
      });
    }
  });
});
