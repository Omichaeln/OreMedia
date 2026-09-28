import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelToolCall } from '@oremedia/contracts/agents';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { TenantContext, Tx } from '@oremedia/db';
import { MemoryProviderJobStore } from './provider-jobs';
import { resetRoutingPolicies, setTenantRoutingPolicy } from './routing-policy';
import { dispatchToolDetailed, type AgentRunContext, type DispatchDeps } from './tool-dispatcher';
import { SPEECH_COST_MICROS_PER_1K_CHARS, createReleaseOneRegistry } from './tools';
import type { SpeechGenerator, ToolServices } from './tools/services';

/**
 * ADR-11 speech generation (ledger 4.26) through the provider-job protocol (spec 12.2): generated and charged once
 * per tool call; a retry of the call polls the persisted job instead of generating (and paying) again.
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
  correlationId: 'corr_speech',
};
const run = (stepId: string): AgentRunContext => ({
  runId: 'run_speech',
  stepId,
  tenantId: 'ten_A',
  brandId: 'brd_1',
  correlationId: 'corr_speech',
  tenantContext,
  principal,
  policy: { autonomyMode: 'create', allowedTools: ['speech.generate'] },
  budgetReservationId: 'bres_1',
  snapshot: null,
});
const TEXT = 'Quarried in the Great Dyke, finished by hand. '.repeat(30); // 1,380 characters
const call: ModelToolCall = {
  id: 'toolu_tts',
  name: 'speech.generate',
  arguments: { text: TEXT, voice: 'alloy' },
};
const AUDIO = { storageKey: 'assets/ten_A/brd_1/generated/voice.mp3', contentHash: 'd'.repeat(64) };
type Poll = Awaited<ReturnType<SpeechGenerator['poll']>>;

function harness(
  poll: (jobId: string) => Promise<Poll>,
  opts: { flag?: boolean; configured?: boolean } = {},
) {
  const submits: Array<Parameters<SpeechGenerator['submit']>[0]> = [];
  const polls: string[] = [];
  const charges: Array<{ kind: string; micros: number }> = [];
  const generator: SpeechGenerator = {
    provider: 'fake',
    model: 'fake-speech',
    async submit(input) {
      submits.push(input);
      return { jobId: `gen:upi_${submits.length}` };
    },
    async poll(jobId) {
      polls.push(jobId);
      return poll(jobId);
    },
  };
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
      speech: opts.configured === false ? null : generator,
      flags: { isEnabled: async () => opts.flag ?? true },
    } as unknown as ToolServices,
    providerJobs: new MemoryProviderJobStore(),
    transaction: (fn) => fn({} as Tx),
  };
  return { deps, submits, polls, charges };
}

describe('speech.generate through provider jobs (ADR-11, spec 12.2)', () => {
  beforeEach(() =>
    setTenantRoutingPolicy('ten_A', {
      schemaVersion: 1,
      defaultModel: 'fake-model',
      permittedVendors: ['fake'],
      permittedRegions: [],
      deniedModels: [],
    }),
  );
  afterEach(() => resetRoutingPolicies());

  it('generates once, charges per started 1,000 characters as audio_generation and returns the pending asset', async () => {
    const h = harness(async () => ({ status: 'done', audio: AUDIO }));
    const out = await dispatchToolDetailed(call, run('step_1'), h.deps);
    expect(out.result).toEqual({ kind: 'ok', output: { jobId: 'gen:upi_1', audio: AUDIO } });
    expect(h.submits[0]).toMatchObject({ text: TEXT, voice: 'alloy', restrictions: null });
    expect(h.charges).toEqual([{ kind: 'audio_generation', micros: 2 * SPEECH_COST_MICROS_PER_1K_CHARS }]);
  });

  it('a retry after an infrastructure failure polls the persisted job; one generation', async () => {
    let first = true;
    const h = harness(async () => {
      if (first) {
        first = false;
        throw Object.assign(new Error('ingest status timed out'), { code: 'ETIMEDOUT' });
      }
      return { status: 'done', audio: AUDIO };
    });
    await expect(dispatchToolDetailed(call, run('step_2'), h.deps)).rejects.toThrow(/timed out/);
    const retried = await dispatchToolDetailed(call, run('step_2'), h.deps);
    expect(retried.result).toMatchObject({ kind: 'ok', output: { jobId: 'gen:upi_1' } });
    expect(h.submits).toHaveLength(1);
    expect(h.polls).toEqual(['gen:upi_1', 'gen:upi_1']);
  });

  it('an ingest rejection is a denial with its reason', async () => {
    const h = harness(async () => ({ status: 'failed', reason: 'ingest_rejected:media_malformed' }));
    expect((await dispatchToolDetailed(call, run('step_3'), h.deps)).result).toEqual({
      kind: 'denied',
      reason: 'provider_failed:ingest_rejected:media_malformed',
    });
  });

  it('with the flag off, no generator, or a company that denies the model, nothing is charged or generated', async () => {
    const done = async (): Promise<Poll> => ({ status: 'done', audio: AUDIO });
    const off = harness(done, { flag: false });
    expect((await dispatchToolDetailed(call, run('step_4'), off.deps)).result).toEqual({
      kind: 'denied',
      reason: 'feature_disabled',
    });
    const unset = harness(done, { configured: false });
    expect((await dispatchToolDetailed(call, run('step_5'), unset.deps)).result).toEqual({
      kind: 'denied',
      reason: 'provider_not_configured',
    });
    setTenantRoutingPolicy('ten_A', {
      schemaVersion: 1,
      defaultModel: 'fake-model',
      permittedVendors: ['fake'],
      permittedRegions: [],
      deniedModels: ['fake-speech'],
    });
    const denied = harness(done);
    expect((await dispatchToolDetailed(call, run('step_6'), denied.deps)).result).toEqual({
      kind: 'denied',
      reason: 'model_routing_denied',
    });
    for (const h of [off, unset, denied]) {
      expect(h.submits).toHaveLength(0);
      expect(h.charges).toHaveLength(0);
    }
  });

  it('the brand restrictions in the step context snapshot go with the request; no voice is null', async () => {
    const generation = { permittedProviders: ['openai'], deniedProviders: [], zeroRetention: true };
    const withPolicy = {
      ...run('step_7'),
      snapshot: { brand: { policy: { generation } } } as unknown as AgentRunContext['snapshot'],
    };
    const h = harness(async () => ({ status: 'done', audio: AUDIO }));
    await dispatchToolDetailed({ ...call, arguments: { text: 'Hello' } }, withPolicy, h.deps);
    expect(h.submits[0]).toMatchObject({ voice: null, restrictions: generation });
    expect(h.charges[0]?.micros).toBe(SPEECH_COST_MICROS_PER_1K_CHARS);
  });
});
