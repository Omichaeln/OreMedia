import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { initTRPC, TRPCError } from '@trpc/server';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import superjson from 'superjson';
import { z } from 'zod';
import {
  type AgentRunState,
  RunApproveProposal,
  RunCancel,
  RunEffectiveLimits,
  RunGet,
  RunList,
  RunStart,
  RunSteps,
} from '@oremedia/contracts/agents';
import { AuditQuery } from '@oremedia/contracts/operations';
import { ServicePrincipalList } from '@oremedia/contracts/access';
import { PageRequest } from '@oremedia/contracts/pagination';
import { SkillTaskKinds, TaskKind } from '@oremedia/contracts/skills';
import {
  isOremediaError,
  NotFoundError,
  PolicyDeniedError,
  toErrorEnvelope,
  ValidationFailedError,
  type ErrorEnvelope,
} from '@oremedia/contracts/errors';
import { startStaticServer } from './static-server';

/**
 * Agent runs smoke (ledger 4.22; spec 21.2 "Agent activity": waiting, cancelled, budget exhausted, policy denied,
 * recovery required). Runs the BUILT app in headless Chromium against an in-process tRPC mock with the same
 * procedure paths, DTOs, error envelope and header contract as apps/api (studio harness mock mode only: the
 * fixtures below are the point of the test, so there is no real-API variant). Opt-in like studio.e2e.test.ts.
 */
const enabled = process.env['OREMEDIA_E2E'] === '1';
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const chromiumPath = process.env['OREMEDIA_CHROMIUM_PATH'];
const launchOptions = chromiumPath
  ? { executablePath: chromiumPath, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chromium' as const, headless: true, args: ['--no-sandbox'] };

const E2E = {
  ownerToken: 'ses_e2e_owner',
  reviewerToken: 'ses_e2e_reviewer',
  tenantId: 'ten_e2e',
  brandId: 'brd_e2e',
  principalId: 'sp_e2e_agent',
};

type State = z.infer<typeof AgentRunState>;
interface Invocation {
  id: string;
  toolName: string;
  inputHash: string;
  inputRedacted: Record<string, unknown>;
  policyDecision: 'allowed' | 'denied' | 'invalid';
  policyReason: string | null;
  outcome: 'ok' | 'error' | 'denied' | 'invalid' | 'proposal';
  outputRef: string | null;
  proposal: Record<string, unknown> | null;
  createdAt: string;
}
interface Step {
  id: string;
  index: number;
  kind: 'plan' | 'model_call' | 'tool_call' | 'validation';
  summary: string;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  durationMs: number;
  createdAt: string;
  invocations: Invocation[];
}
interface Run {
  id: string;
  brandId: string;
  state: State;
  taskKind: string;
  autonomyMode: 'assist' | 'create' | 'prepare_release' | 'managed_autopublish';
  servicePrincipalId: string;
  initiatorKind: 'user' | 'system' | 'recommendation';
  initiatorId: string;
  brief: Record<string, unknown>;
  contextSnapshotHash: string | null;
  skillVersionIds: string[];
  modelConfig: Record<string, string>;
  budgetReservationId: string | null;
  costMicros: number;
  deadlineAt: string;
  workflowId: string;
  correlationId: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  steps: Step[];
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const rid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
let stepIndex = 0;
const step = (kind: Step['kind'], summary: string, over: Partial<Step> = {}): Step => ({
  id: rid('st'),
  index: stepIndex++,
  kind,
  summary,
  tokensIn: 0,
  tokensOut: 0,
  costMicros: 0,
  durationMs: 0,
  createdAt: at(5),
  invocations: [],
  ...over,
});
const invocation = (toolName: string, over: Partial<Invocation> = {}): Invocation => ({
  id: rid('ti'),
  toolName,
  inputHash: 'ab12cd34ef56'.repeat(5) + 'abcd',
  inputRedacted: { brandId: E2E.brandId, query: { kind: 'headline', limit: 3 }, apiKey: '[redacted]' },
  policyDecision: 'allowed',
  policyReason: null,
  outcome: 'ok',
  outputRef: 'ok',
  proposal: null,
  createdAt: at(5),
  ...over,
});
const PROPOSAL = {
  documentId: 'doc_e2e',
  baseRevisionId: 'rev_e2e_1',
  operations: [{ op: 'setText', pageId: 'page_1', elementId: 'el_headline', text: 'Sharper headline' }],
  summary: 'Tighten the headline for the spring launch',
  contentHash: 'c'.repeat(64),
  findings: [{ code: 'headline_length', severity: 'warning', message: 'Headline is close to the limit' }],
};
const run = (id: string, state: State, taskKind: string, costMicros: number, steps: Step[]): Run => {
  stepIndex = 0;
  const finished = !['planned', 'running', 'waiting_for_review'].includes(state);
  return {
    id,
    brandId: E2E.brandId,
    state,
    taskKind,
    autonomyMode: 'create',
    servicePrincipalId: E2E.principalId,
    initiatorKind: 'user',
    initiatorId: 'usr_e2e',
    brief: { goal: 'spring launch' },
    contextSnapshotHash: null,
    skillVersionIds: ['skv_e2e'],
    modelConfig: { provider: 'anthropic', model: 'model-e2e' },
    budgetReservationId: 'br_e2e',
    costMicros,
    deadlineAt: at(-30),
    workflowId: `run:${id}`,
    correlationId: 'corr_e2e',
    finishedAt: finished ? at(1) : null,
    createdAt: at(10),
    updatedAt: at(1),
    version: 1,
    steps,
  };
};

class Backend {
  readonly runs = new Map<string, Run>();
  readonly replays = new Map<string, unknown>();
  readonly requests: Array<{ path: string; headers: IncomingHttpHeaders; input?: unknown }> = [];
  readonly decisions: Array<{ runId: string; stepId: string; decision: string; batch?: unknown }> = [];
  constructor() {
    for (const r of [
      run('run_waiting', 'waiting_for_review', 'copywriting', 12_340, [
        step('plan', 'Plan: read the brand snapshot, then propose a headline change'),
        step('model_call', '1 tool call(s): brand.getSnapshot (tool_use)', {
          tokensIn: 1200,
          tokensOut: 300,
          costMicros: 6_170,
          durationMs: 2_300,
        }),
        step('tool_call', 'brand.getSnapshot', { invocations: [invocation('brand.getSnapshot')] }),
        step('model_call', '1 tool call(s): creative.proposeOperations (tool_use)', {
          tokensIn: 1400,
          tokensOut: 250,
          costMicros: 6_170,
          durationMs: 1_900,
        }),
        step('tool_call', 'creative.proposeOperations', {
          invocations: [
            invocation('creative.proposeOperations', {
              outcome: 'proposal',
              outputRef: 'proposal:st_x',
              proposal: PROPOSAL,
            }),
          ],
        }),
      ]),
      // A second parked proposal, for Modify (the first is consumed by Accept).
      run('run_waiting_modify', 'waiting_for_review', 'copywriting', 8_000, [
        step('tool_call', 'creative.proposeOperations', {
          invocations: [
            invocation('creative.proposeOperations', {
              outcome: 'proposal',
              outputRef: 'proposal:st_y',
              proposal: {
                ...PROPOSAL,
                operations: [
                  ...PROPOSAL.operations,
                  { op: 'moveElement', pageId: 'page_1', elementId: 'el_headline', x: 40, y: 40 },
                ],
                summary: 'Sharpen and nudge the headline',
                findings: [],
              },
            }),
          ],
        }),
      ]),
      run('run_budget', 'budget_exhausted', 'campaign_planning', 2_500_000, [
        step('plan', 'Plan: draft five variants'),
        step('model_call', '2 tool call(s): images.generate, images.generate (tool_use)', {
          tokensIn: 5000,
          tokensOut: 900,
          costMicros: 2_500_000,
          durationMs: 8_100,
        }),
      ]),
      run('run_denied', 'policy_denied', 'channel_adaptation', 4_000, [
        step('model_call', '1 tool call(s): publications.proposeSchedule (tool_use)', {
          tokensIn: 800,
          tokensOut: 120,
          costMicros: 4_000,
          durationMs: 900,
        }),
        step('tool_call', 'publications.proposeSchedule', {
          invocations: [
            invocation('publications.proposeSchedule', {
              policyDecision: 'denied',
              policyReason: 'autonomy_below_prepare_release',
              outcome: 'denied',
              outputRef: 'autonomy_below_prepare_release',
            }),
          ],
        }),
      ]),
      run('run_failed', 'failed', 'layout', 1_000, [
        step('tool_call', 'images.generate', {
          invocations: [
            invocation('images.generate', {
              outcome: 'error',
              outputRef: 'provider_unavailable: image vendor timeout',
            }),
          ],
        }),
      ]),
      run('run_running', 'running', 'brand_review', 500, [step('plan', 'Plan: review the latest revision')]),
      run('run_done', 'completed', 'copywriting', 9_990, [step('model_call', 'final (end_turn): done')]),
    ])
      this.runs.set(r.id, r);
  }
  run(id: string): Run {
    const r = this.runs.get(id);
    if (!r) throw new NotFoundError('AgentRun', id);
    return r;
  }
}

interface Ctx {
  headers: IncomingHttpHeaders;
  correlationId: string;
}
const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);
const t = initTRPC.context<Ctx>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error, ctx }) => {
    const correlationId = ctx?.correlationId ?? 'unknown';
    let envelope: ErrorEnvelope;
    if (isOremediaError(error.cause)) envelope = toErrorEnvelope(error.cause, correlationId);
    else if (error.code === 'UNAUTHORIZED')
      envelope = { code: 'UNAUTHENTICATED', message: 'Authentication required', correlationId };
    else if (error.code === 'FORBIDDEN')
      envelope = { code: 'FORBIDDEN', message: error.message, correlationId };
    else if (error.code === 'BAD_REQUEST')
      envelope = { code: 'VALIDATION_FAILED', message: 'Bad request', correlationId };
    else envelope = { code: 'INTERNAL', message: 'Something went wrong', correlationId };
    return { ...shape, message: envelope.message, data: { ...shape.data, envelope } };
  },
});
const domainErrors = t.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (isOremediaError(err))
      throw new TRPCError({
        code:
          err.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : err.code === 'FORBIDDEN'
              ? 'FORBIDDEN'
              : err.code === 'VALIDATION_FAILED'
                ? 'BAD_REQUEST'
                : 'INTERNAL_SERVER_ERROR',
        message: err.message,
        cause: err,
      });
    throw err;
  }
});
const roleOf = (headers: IncomingHttpHeaders): 'owner' | 'reviewer' | null => {
  const bearer = first(headers['authorization']);
  if (bearer === `Bearer ${E2E.ownerToken}`) return 'owner';
  if (bearer === `Bearer ${E2E.reviewerToken}`) return 'reviewer';
  return null;
};
const authed = t.middleware(({ ctx, next }) => {
  const role = roleOf(ctx.headers);
  if (!role) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, role } });
});
const tenantScoped = t.middleware(({ ctx, next }) => {
  if (first(ctx.headers['x-oremedia-tenant']) !== E2E.tenantId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not a member of this company' });
  return next();
});

function createRouter(backend: Backend) {
  const idempotent = t.middleware(async ({ ctx, path, next }) => {
    const key = first(ctx.headers['idempotency-key']);
    if (!key) throw new TRPCError({ code: 'BAD_REQUEST', message: 'IDEMPOTENCY_KEY_REQUIRED' });
    const replayKey = `${path}:${key}`;
    if (backend.replays.has(replayKey))
      return {
        ok: true as const,
        data: backend.replays.get(replayKey),
        ctx,
        marker: 'replay' as const,
      } as never;
    const result = await next();
    if (result.ok) backend.replays.set(replayKey, result.data);
    return result;
  });
  const query = t.procedure.use(domainErrors).use(authed).use(tenantScoped);
  const mutation = query.use(idempotent);
  const authedOnly = t.procedure.use(domainErrors).use(authed);
  const brand = {
    id: E2E.brandId,
    name: 'E2E brand',
    timezone: 'UTC',
    defaultLocale: 'en',
    status: 'active' as const,
    classification: 'client' as const,
    publishedVersionId: 'bv_e2e',
    activePolicyVersionId: null,
    version: 1,
  };
  const dto = ({ steps: _s, ...r }: Run) => r;
  return t.router({
    access: t.router({
      session: authedOnly.query(() => ({ userId: 'usr_e2e', name: 'E2E person', email: 'e2e@example.test' })),
      /** UX-08: gated as agents.runs.start is (role-grants: not a reviewer); the denial shows before choosing anything. */
      servicePrincipals: t.router({
        list: query.input(ServicePrincipalList).query(({ ctx }) => {
          if (ctx.role !== 'owner')
            throw new PolicyDeniedError(
              'role_missing',
              'Your role does not include agent.start_run for this brand',
            );
          return {
            items: [
              {
                id: E2E.principalId,
                name: 'E2E agent',
                kind: 'agent' as const,
                maxAutonomy: 'prepare_release' as const,
                actions: ['brand.read', 'creative.edit'],
                createdAt: '2026-09-01T09:00:00.000Z',
              },
            ],
            nextCursor: null,
          };
        }),
      }),
      listCompanies: authedOnly.query(({ ctx }) => [
        {
          tenantId: E2E.tenantId,
          name: 'E2E company',
          slug: 'e2e',
          kind: 'live' as const,
          role: ctx.role,
          allBrands: true,
        },
      ]),
    }),
    skills: t.router({
      taskKinds: query.input(SkillTaskKinds).query(() => ({
        items: TaskKind.options.map((taskKind) => ({
          taskKind,
          skills:
            taskKind === 'copywriting'
              ? [
                  {
                    skillVersionId: 'skv_copy_3',
                    skillId: 'sk_copy',
                    key: 'brand-copywriting',
                    title: 'Brand copywriting',
                    description: 'Drafts on-brand copy for the brief.',
                    versionNumber: 3,
                    inputSchema: {
                      type: 'object',
                      properties: {
                        goal: { type: 'string', maxLength: 1000, description: 'What the copy must achieve.' },
                        channels: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
                        tone: { type: 'string', enum: ['warm', 'direct'] },
                      },
                      required: ['goal'],
                      additionalProperties: false,
                    },
                  },
                ]
              : [],
        })),
      })),
    }),
    brand: t.router({
      list: query.query(() => [brand]),
      get: query.input(z.object({ brandId: z.string() })).query(({ input }) => {
        if (input.brandId !== E2E.brandId) throw new NotFoundError('Brand', input.brandId);
        return brand;
      }),
    }),
    operations: t.router({
      audit: t.router({
        query: query.input(z.object({ query: AuditQuery, page: PageRequest })).query(({ ctx, input }) => {
          if (ctx.role !== 'owner')
            throw new PolicyDeniedError('role_missing', 'audit.read needs owner or admin');
          const items = [...backend.runs.values()]
            .filter(() => input.query.resourceType === 'agent_run')
            .map((r, i) => ({
              id: `aud_${String(1000 - i).padStart(4, '0')}`,
              tenantId: E2E.tenantId,
              actorKind: 'user',
              actorId: 'usr_e2e',
              supportSessionId: null,
              action: 'agent.run.request',
              resourceType: 'agent_run',
              resourceId: r.id,
              decision: 'allowed' as const,
              reason: null,
              correlationId: 'corr_e2e',
              metadata: { brandId: r.brandId, runId: r.id, toState: 'planned' },
              createdAt: new Date(r.createdAt),
            }));
          return { items, nextCursor: null };
        }),
      }),
    }),
    agents: t.router({
      runs: t.router({
        /** RA-07: the limits a start would be bound by; gated as the start is. */
        effectiveLimits: query.input(RunEffectiveLimits).query(({ ctx, input }) => {
          if (ctx.role !== 'owner')
            throw new PolicyDeniedError(
              'role_missing',
              'Your role does not include agent.start_run for this brand',
            );
          if (input.servicePrincipalId !== E2E.principalId)
            throw new NotFoundError('ServicePrincipal', input.servicePrincipalId);
          const skill = input.taskKind === 'copywriting' || input.taskKind === 'campaign_planning';
          return {
            brandId: input.brandId,
            taskKind: input.taskKind,
            principal: { id: E2E.principalId, name: 'E2E agent', maxAutonomy: 'prepare_release' as const },
            autonomy: {
              requested: input.requestedAutonomy,
              principalMax: 'prepare_release' as const,
              tenantPolicyMax: 'prepare_release' as const,
              entitlementMax: 'prepare_release' as const,
              effective:
                input.requestedAutonomy === 'managed_autopublish'
                  ? 'prepare_release'
                  : input.requestedAutonomy,
            },
            skills: skill ? [{ key: 'brand-copywriting', title: 'Brand copywriting', versionNumber: 3 }] : [],
            budget: skill
              ? {
                  maxSteps: 8,
                  maxTokens: 80_000,
                  maxCostMicros: 1_250_000,
                  maxVariants: 3,
                  deadlineSeconds: 600,
                }
              : null,
            reservedMicros: skill ? 1_250_000 : 0,
            spend: {
              month: { limitMicros: 250_000_000, remainingMicros: 207_500_000 },
              day: { limitMicros: 20_000_000, remainingMicros: 16_900_000 },
            },
            tools: [
              { name: 'brand.getSnapshot', action: 'brand.read', allowed: true },
              { name: 'content.draftCopy', action: 'content.edit', allowed: false },
              { name: 'creative.proposeOperations', action: 'creative.edit', allowed: true },
            ],
            deniedActions: ['content.edit'],
            blockers: skill
              ? []
              : [
                  {
                    code: 'no_skill' as const,
                    message: 'No published skill serves this task kind for the brand.',
                  },
                ],
            canStart: skill,
          };
        }),
        start: mutation.input(RunStart).mutation(({ ctx, input }) => {
          if (ctx.role !== 'owner')
            throw new PolicyDeniedError(
              'role_missing',
              'Your role does not include agent.start_run for this brand',
            );
          if (input.servicePrincipalId !== E2E.principalId)
            throw new ValidationFailedError([{ path: 'servicePrincipalId', issue: 'revoked' }]);
          if (input.brief['goal'] === 'fail')
            throw new ValidationFailedError([{ path: 'brief', issue: 'goal must not be "fail"' }]);
          const id = rid('run');
          const r = run(id, 'planned', input.taskKind, 0, []);
          r.brief = input.brief;
          r.autonomyMode = input.requestedAutonomy;
          r.finishedAt = null;
          backend.runs.set(id, r);
          return {
            runId: id,
            state: 'planned' as const,
            autonomyMode: r.autonomyMode,
            workflowId: r.workflowId,
            version: 0,
          };
        }),
        list: query.input(RunList).query(({ input }) => ({
          items: [...backend.runs.values()]
            .filter((r) => r.brandId === input.brandId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
            .map(dto),
          nextCursor: null,
        })),
        get: query.input(RunGet).query(({ input }) => dto(backend.run(input.runId))),
        steps: query
          .input(RunSteps)
          .query(({ input }) => ({ items: backend.run(input.runId).steps, nextCursor: null })),
        cancel: mutation.input(RunCancel).mutation(({ input }) => {
          const r = backend.run(input.runId);
          if (!['planned', 'running', 'waiting_for_review'].includes(r.state))
            throw new ValidationFailedError([{ path: 'runId', issue: 'illegal transition' }]);
          r.state = 'cancelled';
          r.finishedAt = new Date().toISOString();
          r.version += 1;
          return { runId: r.id, state: r.state, version: r.version };
        }),
        approveProposal: mutation.input(RunApproveProposal).mutation(({ input }) => {
          const r = backend.run(input.runId);
          if (r.state !== 'waiting_for_review')
            throw new ValidationFailedError([
              { path: 'runId', issue: `run is ${r.state}, not waiting_for_review` },
            ]);
          const stepOf = r.steps.find((s) => s.id === input.stepId && s.invocations.some((i) => i.proposal));
          if (!stepOf) throw new NotFoundError('Proposal', input.stepId);
          backend.decisions.push({
            runId: r.id,
            stepId: input.stepId,
            decision: input.decision,
            batch: input.batch,
          });
          r.state = 'running';
          r.steps.push({
            ...step('validation', `proposal ${input.stepId} ${input.decision} by user usr_e2e`),
            index: r.steps.length,
          });
          return {
            runId: r.id,
            stepId: input.stepId,
            decision: input.decision,
            appliedRevisionId: input.decision === 'modify' ? 'rev_e2e_2' : null,
          };
        }),
      }),
    }),
  });
}

describe.skipIf(!enabled)('agent runs smoke (built app in Chromium, mock transport)', () => {
  const backend = new Backend();
  let origin = '';
  let close: () => Promise<void> = async () => {};
  let browser: Browser;
  let page: Page;
  const agentsPath = () =>
    `/c/${encodeURIComponent(E2E.tenantId)}/b/${encodeURIComponent(E2E.brandId)}/agents`;
  const signIn = async (token: string) => {
    await page.goto(`${origin}/sign-in`);
    await page.getByLabel('Session token').fill(token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect.poll(() => page.url()).toContain('/portfolio');
  };
  const runRows = () => page.getByTestId('run-row');
  const detail = () => page.getByTestId('run-detail');

  beforeAll(async () => {
    if (!existsSync(`${dist}/index.html`))
      throw new Error(`build first: pnpm --filter @oremedia/web build (missing ${dist}/index.html)`);
    const handler = createHTTPHandler({
      router: createRouter(backend),
      basePath: '/trpc/',
      createContext: ({ req }) => {
        const path = (req.url ?? '').replace(/^\/trpc\//, '').split('?')[0] ?? '';
        backend.requests.push({ path, headers: req.headers });
        return {
          headers: req.headers,
          correlationId: first(req.headers['x-correlation-id']) ?? randomUUID(),
        };
      },
    });
    const served = await startStaticServer({ dist, trpcHandler: handler });
    origin = served.origin;
    close = served.close;
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); // phone width first
    page = await context.newPage();
    page.on('pageerror', (err) => console.error('[page error]', err));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await close();
  });

  it('lists every run of the brand from the server with a state chip, task kind, initiator, cost and times', async () => {
    await signIn(E2E.ownerToken);
    await page.goto(`${origin}${agentsPath()}`);
    await expect.poll(() => page.getByRole('heading', { level: 1 }).textContent()).toBe('Agent runs');
    await expect.poll(() => runRows().count(), { timeout: 15_000 }).toBe(7);
    await expect
      .poll(
        async () =>
          (await runRows().evaluateAll((els) => els.map((e) => e.getAttribute('data-run-state')))).sort(),
        { timeout: 15_000 },
      )
      .toEqual(
        [
          'budget_exhausted',
          'completed',
          'failed',
          'policy_denied',
          'running',
          'waiting_for_review',
          'waiting_for_review',
        ].sort(),
      );
    const list = await page.getByRole('list', { name: 'Runs' }).textContent();
    for (const label of [
      'Waiting for review',
      'Budget exhausted',
      'Policy denied',
      'Failed',
      'Running',
      'Completed',
    ])
      expect(list).toContain(label);
    expect(list).toContain('$2.50'); // 2_500_000 micros, never raw
    expect(list).not.toContain('2500000');
    expect(list).toContain('user usr_e2e');
    expect(list).toContain('copywriting');
    // No horizontal overflow at phone width (spec 21.3 / WCAG reflow).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    expect(backend.requests.some((r) => r.path.includes('agents.runs.list'))).toBe(true);
    expect(backend.requests.some((r) => r.path.includes('operations.audit.query'))).toBe(false);
  }, 45_000);

  it('shows the step timeline with kinds, tokens, cost, duration and tool invocations with the redacted input', async () => {
    await page.locator('a[href$="run=run_waiting"]').click();
    await expect.poll(() => page.url()).toContain('run=run_waiting');
    await expect
      .poll(() => detail().getAttribute('data-run-state'), { timeout: 15_000 })
      .toBe('waiting_for_review');
    await expect.poll(() => page.getByTestId('step').count()).toBe(5);
    const kinds = await page
      .getByTestId('step')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-step-kind')));
    expect(kinds).toEqual(['plan', 'model_call', 'tool_call', 'model_call', 'tool_call']);
    const timeline = await page.getByTestId('timeline').textContent();
    expect(timeline).toContain('1,200 in / 300 out');
    expect(timeline).toContain('$0.0062'); // 6_170 micros
    expect(timeline).toContain('2.3 s');
    expect(timeline).toContain('brand.getSnapshot');
    expect(timeline).toContain('policy allowed');
    expect(timeline).toContain('outcome proposal');
    expect(await page.getByTestId('run-cost').textContent()).toBe('$0.0123');
    // The redacted input is a collapsible text tree; expanding it shows the redaction marker, never a secret.
    const first = page.getByTestId('invocation').first();
    await first.locator('summary').first().click();
    await expect.poll(() => first.textContent()).toContain('[redacted]');
    expect(await first.textContent()).toContain('headline');
    expect(await page.getByRole('heading', { level: 3, name: 'Needs attention' }).count()).toBe(1);
  }, 45_000);

  it('waiting_for_review shows the proposal verbatim and Accept records the decision with an Idempotency-Key', async () => {
    const proposal = page.getByTestId('proposal');
    await expect.poll(() => proposal.count()).toBe(1);
    expect(await proposal.textContent()).toContain('Tighten the headline for the spring launch');
    expect(await proposal.textContent()).toContain('doc_e2e');
    expect(await proposal.textContent()).toContain('Headline is close to the limit');
    expect(await page.getByTestId('needs-attention').textContent()).toContain('Waiting for your decision');
    // RA-07: Modify reviews the operations as rows with the proposed text editable; nothing is typed as JSON.
    await page.getByRole('button', { name: 'Modify' }).click();
    await expect.poll(() => page.getByTestId('modify-operation').count()).toBe(1);
    expect(await page.getByTestId('modify-operation').textContent()).toContain('Set the text');
    expect(await page.locator('#modify-op-0-text').inputValue()).toBe('Sharper headline');
    expect(await page.locator('textarea.font-mono, #modify-batch').count()).toBe(0);
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => backend.decisions.length, { timeout: 15_000 }).toBe(1);
    expect(backend.decisions[0]).toMatchObject({ runId: 'run_waiting', decision: 'accept' });
    const req = backend.requests.filter((r) => r.path === 'agents.runs.approveProposal').at(-1);
    expect(typeof req?.headers['idempotency-key']).toBe('string');
    await expect.poll(() => detail().getAttribute('data-run-state'), { timeout: 15_000 }).toBe('running');
    await expect.poll(() => page.getByTestId('proposal').count()).toBe(0);
    expect(await page.getByTestId('timeline').textContent()).toContain('accept by user usr_e2e');
  }, 45_000);

  it('Modify applies the kept operations with the edited text as the person’s own batch (RA-07: no JSON)', async () => {
    await page.goto(`${origin}${agentsPath()}?run=run_waiting_modify`);
    await expect.poll(() => page.getByTestId('proposal').count(), { timeout: 15_000 }).toBe(1);
    await page.getByRole('button', { name: 'Modify' }).click();
    await expect.poll(() => page.getByTestId('modify-operation').count()).toBe(2);
    await page.locator('#modify-op-0-text').fill('My own headline');
    await page.getByRole('button', { name: 'Remove #2' }).click();
    expect(await page.getByTestId('modify-operation').nth(1).getAttribute('data-kept')).toBe('false');
    await page.locator('#modify-summary').fill('Kept the text change only');
    const decided = backend.decisions.length;
    await page.getByRole('button', { name: 'Apply 1 of 2 operations' }).click();
    await expect.poll(() => backend.decisions.length, { timeout: 15_000 }).toBe(decided + 1);
    expect(backend.decisions.at(-1)).toMatchObject({
      runId: 'run_waiting_modify',
      decision: 'modify',
      batch: {
        documentId: 'doc_e2e',
        baseRevisionId: 'rev_e2e_1',
        summary: 'Kept the text change only',
        operations: [{ op: 'setText', pageId: 'page_1', elementId: 'el_headline', text: 'My own headline' }],
      },
    });
    expect((backend.decisions.at(-1)?.batch as { operations: unknown[] }).operations).toHaveLength(1);
    await expect.poll(() => detail().getAttribute('data-run-state'), { timeout: 15_000 }).toBe('running');
    expect(await page.getByTestId('timeline').textContent()).toContain('modify by user usr_e2e');
  }, 45_000);

  it('budget_exhausted is a needs-attention item with the spend in currency', async () => {
    await page.goto(`${origin}${agentsPath()}?run=run_budget`);
    await expect
      .poll(() => detail().getAttribute('data-run-state'), { timeout: 15_000 })
      .toBe('budget_exhausted');
    const attention = await page.getByTestId('needs-attention').textContent();
    expect(attention).toContain('Budget exhausted');
    expect(attention).toContain('$2.50');
    expect(await page.getByTestId('run-state').textContent()).toContain('Budget exhausted');
    expect(await page.getByRole('button', { name: 'Cancel run' }).count()).toBe(0); // terminal: nothing to cancel
  }, 30_000);

  it('policy_denied names the denied tool and the recorded reason', async () => {
    await page.goto(`${origin}${agentsPath()}?run=run_denied`);
    await expect
      .poll(() => detail().getAttribute('data-run-state'), { timeout: 15_000 })
      .toBe('policy_denied');
    const attention = await page.getByTestId('needs-attention').textContent();
    expect(attention).toContain('Policy denied');
    expect(attention).toContain('publications.proposeSchedule');
    expect(attention).toContain('autonomy_below_prepare_release');
    await expect.poll(() => page.getByTestId('invocation').count()).toBe(1);
    expect(await page.getByTestId('invocation').getAttribute('data-policy-decision')).toBe('denied');
    expect(await page.getByTestId('invocation').textContent()).toContain('policy denied');
  }, 30_000);

  it('failed shows the recorded exception', async () => {
    await page.goto(`${origin}${agentsPath()}?run=run_failed`);
    await expect.poll(() => detail().getAttribute('data-run-state'), { timeout: 15_000 }).toBe('failed');
    const attention = await page.getByTestId('needs-attention').textContent();
    expect(attention).toContain(
      'Recorded exception: images.generate: provider_unavailable: image vendor timeout',
    );
  }, 30_000);

  it('cancel asks for confirmation, then the run is cancelled', async () => {
    await page.goto(`${origin}${agentsPath()}?run=run_running`);
    await expect.poll(() => detail().getAttribute('data-run-state'), { timeout: 15_000 }).toBe('running');
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(1);
    await page.getByRole('button', { name: 'Keep running' }).click();
    await expect.poll(() => page.getByRole('alertdialog').count()).toBe(0);
    expect(backend.run('run_running').state).toBe('running');
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await page.getByTestId('confirm-cancel').click();
    await expect.poll(() => detail().getAttribute('data-run-state'), { timeout: 15_000 }).toBe('cancelled');
    expect(await page.getByTestId('needs-attention').textContent()).toContain('Cancelled');
    expect(
      typeof backend.requests.find((r) => r.path === 'agents.runs.cancel')?.headers['idempotency-key'],
    ).toBe('string');
  }, 45_000);

  it('start run: the new run opens as Queued and the same intent key is kept for the submission', async () => {
    await page.goto(`${origin}${agentsPath()}`);
    await page.getByRole('button', { name: 'New run' }).click();
    // UX-08: the principal is picked by name and the brief is the skill's own fields, never typed JSON or ids.
    await page.locator('#run-principal').click();
    await page.getByRole('option', { name: /E2E agent/ }).click();
    await expect.poll(() => page.getByLabel('Goal').count(), { timeout: 15_000 }).toBe(1);
    // RA-07: the limits the server will hold the run to are shown before it starts, from the same sources.
    await expect.poll(() => page.getByTestId('effective-limits').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('effective-autonomy').textContent()).toContain('create');
    expect(await page.getByTestId('effective-budget').textContent()).toContain('$1.25');
    expect(await page.getByTestId('effective-budget').textContent()).toContain('8 steps');
    expect(await page.getByTestId('denied-actions').textContent()).toContain('content.edit');
    expect(await page.getByTestId('denied-actions').textContent()).toContain('content.draftCopy');
    expect(await page.getByTestId('effective-limits').textContent()).toContain('$16.90');
    // A required field left empty is refused before any request is sent.
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect.poll(() => page.locator('#run-brief-goal-error').count(), { timeout: 15_000 }).toBe(1);
    expect(backend.requests.filter((r) => r.path === 'agents.runs.start')).toHaveLength(0);
    await page.getByLabel('Goal').fill('fail');
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect.poll(() => page.getByRole('alert').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const firstKey = backend.requests.filter((r) => r.path === 'agents.runs.start').at(-1)?.headers[
      'idempotency-key'
    ];
    await page.getByLabel('Goal').fill('spring launch');
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(/run=run_/);
    const secondKey = backend.requests.filter((r) => r.path === 'agents.runs.start').at(-1)?.headers[
      'idempotency-key'
    ];
    expect(secondKey).toBe(firstKey); // same intent until it succeeds (spec 7.3)
    await expect
      .poll(() => page.getByTestId('run-state').textContent(), { timeout: 15_000 })
      .toContain('Queued');
    expect(backend.runs.size).toBe(8);
  }, 45_000);

  it('a reviewer without agent.start_run still sees the brand’s runs and gets a Permission denied state on start', async () => {
    // At phone width Sign out is in the Menu drawer with the brand navigation.
    const menu = page.getByRole('button', { name: 'Menu' });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    // Sign out navigates to /sign-in itself; a second navigation started before it lands is aborted (ERR_ABORTED).
    await page.waitForURL('**/sign-in*', { timeout: 15_000 });
    await signIn(E2E.reviewerToken);
    await page.goto(`${origin}${agentsPath()}`);
    // The list comes from agents.runs.list (brand.read), not the audit log: no admin role is needed for history.
    await expect.poll(() => runRows().count(), { timeout: 15_000 }).toBe(8);
    expect(await page.getByTestId('runs').textContent()).not.toContain('audit access');
    await page.getByRole('button', { name: 'New run' }).click();
    // The principal list is gated as the start is, so the denial shows before anything is chosen.
    await expect.poll(() => page.getByTestId('start-denied').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByTestId('start-denied').textContent()).toContain('Permission denied');
    expect(await page.getByTestId('start-denied').textContent()).toContain('agent.start_run');
    expect(backend.runs.size).toBe(8);
  }, 45_000);
});
