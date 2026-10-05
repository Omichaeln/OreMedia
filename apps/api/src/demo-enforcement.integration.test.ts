import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { apiClients, memberships, servicePrincipals } from '@oremedia/db/schema/access';
import { spendLimits } from '@oremedia/db/schema/billing';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import {
  CROSS_TENANT_INPUTS,
  OWN_TENANT_INPUTS,
  callMcpTool,
  callPath,
  callRest,
  restRoute,
  seedDemoTenant,
  seedTwoTenants,
  type SeededDemoTenant,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src';
import { configureRateLimiter } from './trpc';

/**
 * Demo workspace stage 2 (architecture §4.2, §4.6, §11 row 2): in a demo company every command that reaches outside
 * (connect, AI, crawl, fetch, invite) is refused in its service, so tRPC, REST and MCP answer the same
 * `demo_simulated` refusal; nobody else can be added to a demo; its spend limits start at zero. A live company is
 * untouched.
 */
const REFUSED: readonly string[] = [
  // channels and websites never connect to a real platform or site
  'publishing.channels.connect.start',
  'publishing.channels.connect.complete',
  'publishing.channels.connect.select',
  'destinations.register',
  'destinations.connect.start',
  'destinations.connect.complete',
  'destinations.connect.select',
  'destinations.connect.withSecret',
  // crawls, page fetches and downloads
  'destinations.audit.run',
  'publishing.publications.validateRendered',
  'brand.sources.add',
  'assets.fonts.importGoogle',
  // model calls (assist, generation, video, agents, analyst, evaluation)
  'brand.assist.estimate',
  'brand.assist.start',
  'brand.assist.answer',
  'brand.onboarding.start',
  'creative.generation.start',
  'creative.generation.retry',
  'creative.videoAi.start',
  'creative.videoAi.retry',
  'agents.runs.start',
  'agents.budgets.setLimit',
  'intelligence.analyst.run',
  'skills.versions.evaluate',
  // a demo is one person's: nobody else is added, no key or principal acts in it, no setup link is issued
  'access.members.invite',
  'access.members.issuePasswordSetup',
  'access.apiClients.create',
  'access.apiClients.rotate',
  'access.servicePrincipals.create',
];

describe('demo workspace enforcement (stage 2)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let demo: SeededDemoTenant;

  /** A valid input for the procedure (the cross-tenant fixtures; the ids are a live tenant's, never reached). */
  const inputFor = (path: string): unknown => {
    const fixture = CROSS_TENANT_INPUTS[path];
    if (!fixture) throw new Error(`no fixture for ${path}`);
    if (fixture.buildInput) return fixture.buildInput(tenantA.ids);
    const own = OWN_TENANT_INPUTS[path];
    if (!own) throw new Error(`no own-tenant fixture for ${path}`);
    return own.input();
  };

  const demoRefusal = { code: 'FORBIDDEN', details: [{ issue: 'demo_simulated' }] };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA } = await seedTwoTenants(tdb.db));
    demo = await seedDemoTenant(tdb.db);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it.each(REFUSED)(
    'tRPC %s is refused in a demo company with demo_simulated and a plain message',
    async (path) => {
      const res = await callPath({ bearer: demo.ownerToken }, path, inputFor(path));
      expect(res.error).toMatchObject(demoRefusal);
      expect(res.error?.message).toMatch(/demo workspace/i);
    },
  );

  it('accepting a recommendation as generate_variants is refused (create_brief is the demo’s way)', async () => {
    const res = await callPath({ bearer: demo.ownerToken }, 'intelligence.recommendations.accept', {
      ...(inputFor('intelligence.recommendations.accept') as Record<string, unknown>),
      action: 'generate_variants',
      servicePrincipalId: demo.servicePrincipalId,
    });
    expect(res.error).toMatchObject(demoRefusal);
    expect(res.error?.message).toMatch(/brief/);
  });

  it('REST and MCP refuse an agent run in a demo company exactly as tRPC does', async () => {
    const start = {
      brandId: demo.brandId,
      servicePrincipalId: demo.servicePrincipalId,
      taskKind: 'copywriting',
      brief: { objective: 'Launch post' },
    };
    const trpc = await callPath({ bearer: demo.apiClientKey }, 'agents.runs.start', start);
    const rest = await callRest({ bearer: demo.apiClientKey }, restRoute('agents.runs.start'), start);
    const mcp = await callMcpTool({ bearer: demo.apiClientKey }, 'agents.startRun', {
      brandId: demo.brandId,
      taskKind: 'copywriting',
      brief: { objective: 'Launch post' },
    });
    expect(trpc.error).toMatchObject(demoRefusal);
    expect(rest.status).toBe(403);
    expect(rest.error).toMatchObject(demoRefusal);
    expect(mcp.error).toMatchObject(demoRefusal);
    expect(rest.error?.message).toBe(trpc.error?.message);
    // MCP carries a tool denial's reason only, so its message is the demo refusal in general terms.
    expect(mcp.error?.message).toMatch(/demo workspace/i);
  });

  it('nothing a refused command would have started reaches the outbox; refusals are audited', async () => {
    const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.tenantId, demo.tenantId));
    expect(events.map((e) => e.eventType).filter((t) => t !== 'membership.changed')).toEqual([]);
    const refusals = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, demo.tenantId), eq(auditEvents.reason, 'demo_simulated')));
    expect(refusals.map((r) => r.action)).toEqual(
      expect.arrayContaining(['demo.member_invite', 'demo.agent_run', 'demo.channel_connect']),
    );
    expect(refusals.every((r) => r.decision === 'denied')).toBe(true);
  });

  it('nobody else can be added to a demo company: still one membership, no new key or principal', async () => {
    const invite = await callPath({ bearer: demo.ownerToken }, 'access.members.invite', {
      email: `friend-${randomUUID().slice(0, 8)}@example.test`,
      role: 'admin',
      allBrands: true,
    });
    expect(invite.error).toMatchObject(demoRefusal);
    const members = await tdb.db.select().from(memberships).where(eq(memberships.tenantId, demo.tenantId));
    expect(members.map((m) => [m.userId, m.role, m.status])).toEqual([[demo.ownerUserId, 'owner', 'active']]);
    const keys = await tdb.db.select().from(apiClients).where(eq(apiClients.tenantId, demo.tenantId));
    const principals = await tdb.db
      .select()
      .from(servicePrincipals)
      .where(eq(servicePrincipals.tenantId, demo.tenantId));
    expect(keys).toHaveLength(1); // the test factory's own key
    expect(principals).toHaveLength(1);
    const setupLink = await callPath({ bearer: demo.ownerToken }, 'access.members.issuePasswordSetup', {
      membershipId: members[0]!.id,
    });
    expect(setupLink.error).toMatchObject(demoRefusal);
  });

  it('a live company is untouched: the same invite, key and agent-run commands are not demo refusals', async () => {
    const invite = await callPath({ bearer: tenantA.ownerToken }, 'access.members.invite', {
      email: `colleague-${randomUUID().slice(0, 8)}@example.test`,
      role: 'creator',
      allBrands: true,
    });
    expect(invite.error).toBeUndefined();
    const key = await callPath({ bearer: tenantA.ownerToken }, 'access.apiClients.create', {
      servicePrincipalId: tenantA.servicePrincipalId,
      scopes: ['brands:read'],
    });
    expect(key.error).toBeUndefined();
    const run = await callPath({ bearer: tenantA.ownerToken }, 'agents.runs.start', {
      brandId: tenantA.brandIds[0],
      servicePrincipalId: tenantA.servicePrincipalId,
      taskKind: 'copywriting',
      brief: { objective: 'Launch post' },
    });
    expect(run.error?.details).not.toEqual([{ issue: 'demo_simulated' }]);
    const estimate = await callPath(
      { bearer: tenantA.ownerToken },
      'brand.assist.estimate',
      inputFor('brand.assist.estimate'),
    );
    expect(estimate.error?.details).not.toEqual([{ issue: 'demo_simulated' }]);
  });

  it('a demo company’s spend limits start at zero (the company’s month and day, each brand’s day); a live one keeps its defaults', async () => {
    const limits = await tdb.db.select().from(spendLimits).where(eq(spendLimits.tenantId, demo.tenantId));
    expect(
      limits
        .map((l) => [l.brandId, l.period, l.limitMicros])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(
      [
        ['', 'day', 0],
        ['', 'month', 0],
        [demo.brandId, 'day', 0],
      ].sort((a, b) => String(a).localeCompare(String(b))),
    );
    const live = await tdb.db.select().from(spendLimits).where(eq(spendLimits.tenantId, tenantA.tenantId));
    expect(live.filter((l) => l.limitMicros === 0)).toEqual([]);
    // The budget read reports the demo's zero limits: nothing paid can be reserved there.
    const budget = await callPath({ bearer: demo.ownerToken }, 'agents.budgets.read', {
      brandId: demo.brandId,
    });
    expect(budget.data).toMatchObject({ month: { limitMicros: 0 }, day: { limitMicros: 0 } });
  });
});
