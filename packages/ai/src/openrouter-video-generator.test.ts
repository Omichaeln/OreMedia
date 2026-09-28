import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from '@oremedia/contracts/errors';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { GeneratedAssetSink } from './generated-asset-sink';
import {
  OpenRouterVideoGenerator,
  createOpenRouterVideoGeneratorFromEnv,
} from './openrouter-video-generator';

const CLIP = Buffer.from('not really an mp4, ingest checks that');
const actor = { kind: 'service_principal', id: 'sp_1' } as unknown as ResolvedActorServicePrincipal;
const by = { brandId: 'brd_1', runId: 'run_1', actor, autonomyMode: 'create' as const };
const submitInput = {
  tenantId: 'ten_A',
  brandId: 'brd_1',
  runId: 'run_1',
  prompt: 'Slow pan across a basalt quarry',
  seconds: 6,
  aspect: '9:16',
  restrictions: null,
};
const promptHash = createHash('sha256').update(submitInput.prompt).digest('hex');

/** Answers by method and path; records every request. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const text = await req.text();
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: text ? JSON.parse(text) : null,
    });
    const url = new URL(req.url);
    const route = routes[`${req.method} ${url.pathname}${url.search}`];
    return route ? route() : new Response('{}', { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeSink(statuses: Awaited<ReturnType<GeneratedAssetSink['status']>> = []) {
  const uploads: Array<Parameters<GeneratedAssetSink['upload']>> = [];
  const sink: GeneratedAssetSink = {
    upload: async (...args) => {
      uploads.push(args);
      return { intentId: `upi_${uploads.length}` };
    },
    status: async () => statuses,
  };
  return { sink, uploads };
}

const generator = (f: ReturnType<typeof fakeFetch>, s = fakeSink()) =>
  new OpenRouterVideoGenerator({
    apiKey: 'or-key',
    model: 'vendor/video-model',
    baseURL: 'https://or.invalid/api/v1/',
    fetch: f.fetch,
    assets: s.sink,
  });

describe('OpenRouterVideoGenerator (ADR-11, ledger 4.25)', () => {
  it('submits the render with the explicit model, duration, aspect and no-data-collection routing', async () => {
    const f = fakeFetch({ 'POST /api/v1/videos': () => json({ id: 'vj_1', status: 'pending' }, 202) });
    const { jobId } = await generator(f).submit({
      ...submitInput,
      restrictions: { permittedProviders: ['bytedance'], deniedProviders: [], zeroRetention: true },
    });
    expect(jobId).toBe(`vid:${promptHash}:vj_1`);
    expect(f.calls[0]!.headers.get('authorization')).toBe('Bearer or-key');
    expect(f.calls[0]!.body).toEqual({
      model: 'vendor/video-model',
      prompt: submitInput.prompt,
      duration: 6,
      aspect_ratio: '9:16',
      provider: { data_collection: 'deny', only: ['bytedance'], zdr: true },
    });
  });

  it('a render still in progress is pending; a completed one is downloaded and handed to ingest as the next stage', async () => {
    let state = 'in_progress';
    const f = fakeFetch({
      'GET /api/v1/videos/vj_1': () => json({ id: 'vj_1', status: state }),
      'GET /api/v1/videos/vj_1/content?index=0': () =>
        new Response(CLIP, { status: 200, headers: { 'content-type': 'video/mp4' } }),
    });
    const s = fakeSink();
    const gen = generator(f, s);
    const jobId = `vid:${promptHash}:vj_1`;
    expect(await gen.poll(jobId, by)).toEqual({ status: 'pending' });
    expect(s.uploads).toHaveLength(0);
    state = 'completed';
    expect(await gen.poll(jobId, by)).toEqual({ status: 'pending', next: 'gen:upi_1' });
    const download = f.calls.find((c) => c.url.endsWith('/content?index=0'));
    expect(download?.headers.get('authorization')).toBe('Bearer or-key');
    const [uploadActor, input, opts] = s.uploads[0]!;
    expect(uploadActor).toBe(actor);
    expect(opts).toEqual({ autonomyMode: 'create' });
    expect(input).toMatchObject({
      brandId: 'brd_1',
      kind: 'video',
      mime: 'video/mp4',
      originalFilename: 'generated-run_1.mp4',
      provenance: {
        kind: 'generated',
        model: 'openrouter:vendor/video-model',
        promptHash,
        inputs: [],
        agentRunId: 'run_1',
      },
    });
    expect(input.bytes.equals(CLIP)).toBe(true);
  });

  it('the ingest stage reports the accepted clip, or the rejection reason', async () => {
    const accepted = fakeSink([
      {
        intentId: 'upi_1',
        state: 'accepted',
        assetId: 'ast_1',
        storageKey: 'k',
        contentHash: 'h'.repeat(64),
        width: 720,
        height: 1280,
      },
    ]);
    expect(await generator(fakeFetch({}), accepted).poll('gen:upi_1', by)).toEqual({
      status: 'done',
      video: { storageKey: 'k', contentHash: 'h'.repeat(64), width: 720, height: 1280 },
    });
    const rejected = fakeSink([{ intentId: 'upi_1', state: 'rejected', reason: 'duration_exceeds_cap' }]);
    expect(await generator(fakeFetch({}), rejected).poll('gen:upi_1', by)).toEqual({
      status: 'failed',
      reason: 'ingest_rejected:duration_exceeds_cap',
    });
  });

  it('a failed, cancelled or expired render fails the job; an unknown one too', async () => {
    const f = fakeFetch({
      'GET /api/v1/videos/vj_1': () => json({ id: 'vj_1', status: 'expired', error: 'took too long' }),
    });
    expect(await generator(f).poll(`vid:${promptHash}:vj_1`, by)).toEqual({
      status: 'failed',
      reason: 'render_expired',
    });
    expect(await generator(f).poll(`vid:${promptHash}:vj_gone`, by)).toEqual({
      status: 'failed',
      reason: 'render_not_found',
    });
    expect(await generator(f).poll('job_other', by)).toEqual({ status: 'failed', reason: 'unknown_job' });
  });

  it('a refused status call or download fails the job instead of retrying what will not change', async () => {
    const f = fakeFetch({
      'GET /api/v1/videos/vj_1': () => json({}, 401),
      'GET /api/v1/videos/vj_2': () => json({ id: 'vj_2', status: 'completed' }),
      'GET /api/v1/videos/vj_2/content?index=0': () => json({}, 410),
    });
    const s = fakeSink();
    expect(await generator(f, s).poll(`vid:${promptHash}:vj_1`, by)).toEqual({
      status: 'failed',
      reason: 'status_rejected_401',
    });
    expect(await generator(f, s).poll(`vid:${promptHash}:vj_2`, by)).toEqual({
      status: 'failed',
      reason: 'download_rejected_410',
    });
    expect(s.uploads).toHaveLength(0);
  });

  it('429 and 5xx are the provider being unavailable; another refusal is an error', async () => {
    const busy = fakeFetch({ 'POST /api/v1/videos': () => json({}, 429) });
    await expect(generator(busy).submit(submitInput)).rejects.toBeInstanceOf(ProviderUnavailableError);
    const down = fakeFetch({ 'GET /api/v1/videos/vj_1': () => json({}, 503) });
    await expect(generator(down).poll(`vid:${promptHash}:vj_1`, by)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    const refused = fakeFetch({
      'POST /api/v1/videos': () => json({ error: { code: 400, message: 'bad' } }, 400),
    });
    await expect(generator(refused).submit(submitInput)).rejects.toThrow('video_generation_rejected:400');
  });

  it('is built from the environment only when the key and the model id are both set', () => {
    expect(createOpenRouterVideoGeneratorFromEnv({ OPENROUTER_API_KEY_REF: 'or' })).toBeNull();
    expect(createOpenRouterVideoGeneratorFromEnv({ OREMEDIA_VIDEO_MODEL_ID: 'm' })).toBeNull();
    expect(
      createOpenRouterVideoGeneratorFromEnv({ OPENROUTER_API_KEY_REF: 'or', OREMEDIA_VIDEO_MODEL_ID: 'm' })
        ?.model,
    ).toBe('m');
  });
});
