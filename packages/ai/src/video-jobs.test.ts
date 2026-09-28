import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelToolCall } from '@oremedia/contracts/agents';
import { ProviderUnavailableError } from '@oremedia/contracts/errors';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { TenantContext, Tx } from '@oremedia/db';
import { MemoryProviderJobStore } from './provider-jobs';
import { resetRoutingPolicies, setTenantRoutingPolicy } from './routing-policy';
import { dispatchToolDetailed, type AgentRunContext, type DispatchDeps } from './tool-dispatcher';
import { VIDEO_COST_MICROS_PER_SECOND, createReleaseOneRegistry } from './tools';
import type { ToolServices, VideoGenerator } from './tools/services';

/**
 * ADR-11 video generation (ledger 4.25) through the provider-job protocol (spec 12.2): a render is submitted once and
 * charged once; the poll that sees it finish hands the clip to ingest and the call moves on to that stage's job, so a
 * retry never repeats the hand-off; a render that outlasts one activity answers `pending` and videos.status collects it.
 */
const principal: ResolvedActorServicePrincipal = {
  kind: 'service_principal',
  id: 'sp_01HAGENT0000000000000000000',
  tenantId: 'ten_A',
  status: 'active',
  maxAutonomy: 'create',
  grants: [],
};
const tenantContext: TenantContext = {
  tenantId: 'ten_A',
  actor: { kind: 'service_principal', id: principal.id },
  brandIds: 'all',
  correlationId: 'corr_video',
};
const run = (stepId: string, runId = 'run_video'): AgentRunContext => ({
  runId,
  stepId,
  tenantId: 'ten_A',
  brandId: 'brd_1',
  correlationId: 'corr_video',
  tenantContext,
  principal,
  policy: { autonomyMode: 'create', allowedTools: ['videos.generate', 'videos.status'] },
  budgetReservationId: 'bres_1',
  snapshot: null,
});
const generate: ModelToolCall = {
  id: 'toolu_vid',
  name: 'videos.generate',
  arguments: { prompt: 'slow pan across a basalt quarry', seconds: 6 },
};
const status = (jobRef: string): ModelToolCall => ({
  id: 'toolu_status',
  name: 'videos.status',
  arguments: { jobRef },
});
const VIDEO = {
  storageKey: 'assets/ten_A/brd_1/generated/clip.mp4',
  contentHash: 'c'.repeat(64),
  width: 720,
  height: 1280,
};
type Poll = Awaited<ReturnType<VideoGenerator['poll']>>;

function harness(
  poll: (jobId: string) => Promise<Poll>,
  opts: { flag?: boolean; configured?: boolean } = {},
) {
  const submits: Array<Parameters<VideoGenerator['submit']>[0]> = [];
  const polls: string[] = [];
  const charges: Array<{ kind: string; micros: number }> = [];
  const generator: VideoGenerator = {
    provider: 'fake',
    model: 'fake-video',
    async submit(input) {
      submits.push(input);
      return { jobId: `render_${submits.length}` };
    },
    async poll(jobId) {
      polls.push(jobId);
      return poll(jobId);
    },
  };
  const providerJobs = new MemoryProviderJobStore();
  const deps: DispatchDeps = {
    registry: createReleaseOneRegistry(),
    policy: { decide: async () => ({ allowed: true, reason: 'ok' }) },
    audit: { record: async () => 'aud_1' },
    budgets: {
      consume: async (_r, _b, kind, _q, _u, micros) => {
        charges.push({ kind, micros });
      },
    },
    services: {
      videos: opts.configured === false ? null : generator,
      flags: { isEnabled: async () => opts.flag ?? true },
    } as unknown as ToolServices,
    providerJobs,
    transaction: (fn) => fn({} as Tx),
  };
  return { deps, submits, polls, charges, providerJobs };
}

/** The render finishes on the second poll and is handed to ingest, which accepts it on the next. */
const twoStage = () => {
  let renderPolls = 0;
  return async (jobId: string): Promise<Poll> => {
    if (jobId === 'ingest_1') return { status: 'done', video: VIDEO };
    renderPolls += 1;
    return renderPolls < 2 ? { status: 'pending' } : { status: 'pending', next: 'ingest_1' };
  };
};

describe('videos.generate through provider jobs (ADR-11, spec 12.2)', () => {
  beforeEach(() =>
    setTenantRoutingPolicy('ten_A', {
      schemaVersion: 1,
      defaultModel: 'fake-model',
      permittedVendors: ['fake'],
      permittedRegions: [],
      deniedModels: [],
    }),
  );
  afterEach(() => {
    resetRoutingPolicies();
    vi.useRealTimers();
  });

  it('submits once, charges per second as video_generation, follows the render into ingest and returns the clip', async () => {
    vi.useFakeTimers();
    const h = harness(twoStage());
    const attempt = dispatchToolDetailed(generate, run('step_1'), h.deps);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await attempt).result).toEqual({
      kind: 'ok',
      output: { jobRef: 'step_1/toolu_vid', status: 'done', video: VIDEO },
    });
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]).toMatchObject({ seconds: 6, aspect: '9:16', restrictions: null });
    expect(h.charges).toEqual([{ kind: 'video_generation', micros: 6 * VIDEO_COST_MICROS_PER_SECOND }]);
    expect(h.polls).toEqual(['render_1', 'render_1', 'ingest_1']);
  });

  it('a retry after the hand-off polls the ingest stage: the clip is handed over once, nothing is resubmitted', async () => {
    let handedOver = 0;
    let failNext = true;
    const h = harness(async (jobId) => {
      if (jobId === 'ingest_1') {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error('storage timed out'), { code: 'ETIMEDOUT' });
        }
        return { status: 'done', video: VIDEO };
      }
      handedOver += 1;
      return { status: 'pending', next: 'ingest_1' };
    });
    // Attempt 1: the render finished and was handed over; the next poll hits an infrastructure failure.
    await expect(dispatchToolDetailed(generate, run('step_2'), h.deps)).rejects.toThrow(/timed out/);
    // Attempt 2 (Temporal retry of the same call): the call already holds the ingest stage's job.
    const retried = await dispatchToolDetailed(generate, run('step_2'), h.deps);
    expect(retried.result).toMatchObject({ kind: 'ok', output: { status: 'done' } });
    expect(handedOver).toBe(1);
    expect(h.submits).toHaveLength(1);
    expect(h.polls).toEqual(['render_1', 'ingest_1', 'ingest_1']);
  });

  it('a render that outlasts the wait answers pending with a job ref; videos.status collects it without a charge', async () => {
    vi.useFakeTimers();
    let ready = false;
    const h = harness(async (jobId) => {
      if (jobId === 'ingest_1') return { status: 'done', video: VIDEO };
      return ready ? { status: 'pending', next: 'ingest_1' } : { status: 'pending' };
    });
    const first = dispatchToolDetailed(generate, run('step_3'), h.deps);
    // No poll starts unless its hand-off budget (170 s) fits before the 280 s deadline: polling stops after 110 s.
    await vi.advanceTimersByTimeAsync(115_000);
    expect((await first).result).toEqual({
      kind: 'ok',
      output: { jobRef: 'step_3/toolu_vid', status: 'pending', video: null },
    });
    ready = true;
    const later = await dispatchToolDetailed(status('step_3/toolu_vid'), run('step_4'), h.deps);
    expect(later.result).toEqual({
      kind: 'ok',
      output: { jobRef: 'step_3/toolu_vid', status: 'done', video: VIDEO },
    });
    expect(h.submits).toHaveLength(1);
    expect(h.charges).toHaveLength(1);
  });

  it('a provider that is unavailable after the job exists answers pending with the job ref, not a denial', async () => {
    let down = true;
    const h = harness(async (jobId) => {
      if (jobId === 'ingest_1') return { status: 'done', video: VIDEO };
      if (down) throw new ProviderUnavailableError('fake');
      return { status: 'pending', next: 'ingest_1' };
    });
    const first = await dispatchToolDetailed(generate, run('step_12'), h.deps);
    expect(first.result).toEqual({
      kind: 'ok',
      output: { jobRef: 'step_12/toolu_vid', status: 'pending', video: null },
    });
    down = false;
    const later = await dispatchToolDetailed(status('step_12/toolu_vid'), run('step_13'), h.deps);
    expect(later.result).toMatchObject({ kind: 'ok', output: { status: 'done', video: VIDEO } });
    expect(h.submits).toHaveLength(1);
    expect(h.charges).toHaveLength(1);
  });

  it('a slow submission leaves less time to poll: the deadline counts from the start of the call', async () => {
    vi.useFakeTimers();
    const h = harness(async () => ({ status: 'pending' }));
    const slow = h.deps.services.videos as VideoGenerator;
    const submit = slow.submit.bind(slow);
    slow.submit = async (input) => {
      await new Promise((r) => setTimeout(r, 100_000));
      return submit(input);
    };
    const attempt = dispatchToolDetailed(generate, run('step_14'), h.deps);
    await vi.advanceTimersByTimeAsync(100_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await attempt).result).toMatchObject({ kind: 'ok', output: { status: 'pending' } });
    expect(h.polls.length).toBeLessThanOrEqual(3); // 100 s submitting leaves 10 s of polls, not another 110 s
  });

  it('videos.status only resolves jobs of its own run: another run’s ref or a malformed one is unknown_job', async () => {
    const h = harness(async () => ({ status: 'done', video: VIDEO }));
    await dispatchToolDetailed(generate, run('step_5'), h.deps);
    const foreign = await dispatchToolDetailed(
      status('step_5/toolu_vid'),
      run('step_1', 'run_other'),
      h.deps,
    );
    expect(foreign.result).toEqual({ kind: 'denied', reason: 'unknown_job' });
    const malformed = await dispatchToolDetailed(status('no-separator'), run('step_6'), h.deps);
    expect(malformed.result).toEqual({ kind: 'denied', reason: 'unknown_job' });
  });

  it('a failed render is a denial with its reason, and nothing is resubmitted', async () => {
    const h = harness(async () => ({ status: 'failed', reason: 'render_failed' }));
    const out = await dispatchToolDetailed(generate, run('step_7'), h.deps);
    expect(out.result).toEqual({ kind: 'denied', reason: 'provider_failed:render_failed' });
    expect(h.submits).toHaveLength(1);
  });

  it('with the flag off, no generator, or a company that denies the model, nothing is charged or submitted', async () => {
    const off = harness(twoStage(), { flag: false });
    expect((await dispatchToolDetailed(generate, run('step_8'), off.deps)).result).toEqual({
      kind: 'denied',
      reason: 'feature_disabled',
    });
    const unset = harness(twoStage(), { configured: false });
    expect((await dispatchToolDetailed(generate, run('step_9'), unset.deps)).result).toEqual({
      kind: 'denied',
      reason: 'provider_not_configured',
    });
    setTenantRoutingPolicy('ten_A', {
      schemaVersion: 1,
      defaultModel: 'fake-model',
      permittedVendors: ['fake'],
      permittedRegions: [],
      deniedModels: ['fake-video'],
    });
    const denied = harness(twoStage());
    expect((await dispatchToolDetailed(generate, run('step_10'), denied.deps)).result).toEqual({
      kind: 'denied',
      reason: 'model_routing_denied',
    });
    for (const h of [off, unset, denied]) {
      expect(h.submits).toHaveLength(0);
      expect(h.charges).toHaveLength(0);
    }
  });

  it('the brand restrictions in the step context snapshot go with the submission', async () => {
    const generation = { permittedProviders: ['bytedance'], deniedProviders: [], zeroRetention: true };
    const withPolicy = {
      ...run('step_11'),
      snapshot: { brand: { policy: { generation } } } as unknown as AgentRunContext['snapshot'],
    };
    const h = harness(async () => ({ status: 'done', video: VIDEO }));
    await dispatchToolDetailed(generate, withPolicy, h.deps);
    expect(h.submits[0]?.restrictions).toEqual(generation);
  });
});
