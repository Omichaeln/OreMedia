import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import {
  OpenRouterImageGenerator,
  createOpenRouterImageGeneratorFromEnv,
  type GeneratedAssetSink,
} from './openrouter-image-generator';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageBody = {
  choices: [
    { message: { images: [{ image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] } },
  ],
};
const actor = { kind: 'service_principal', id: 'sp_1' } as unknown as ResolvedActor;
const submitInput = {
  tenantId: 'ten_A',
  brandId: 'brd_1',
  runId: 'run_1',
  prompt: 'A basalt quarry at dawn',
  count: 2,
  aspect: '4:5',
  actor,
  autonomyMode: 'create' as const,
};

function fakeFetch(status = 200, body: unknown = imageBody) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(await req.text()) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function fakeSink(statuses: Awaited<ReturnType<GeneratedAssetSink['status']>> = []) {
  const uploads: Array<{
    actor: ResolvedActor;
    input: Parameters<GeneratedAssetSink['upload']>[1];
    opts: Parameters<GeneratedAssetSink['upload']>[2];
  }> = [];
  const polled: string[][] = [];
  const sink: GeneratedAssetSink = {
    upload: async (a, input, opts) => {
      uploads.push({ actor: a, input, opts });
      return { intentId: `upi_${uploads.length}` };
    },
    status: async (ids) => {
      polled.push([...ids]);
      return statuses;
    },
  };
  return { sink, uploads, polled };
}

describe('OpenRouterImageGenerator (ADR-11)', () => {
  it('requests one image per call with the explicit model, aspect and no-data-collection routing', async () => {
    const f = fakeFetch();
    const s = fakeSink();
    const gen = new OpenRouterImageGenerator({
      apiKey: 'or-key',
      model: 'vendor/image-model',
      baseURL: 'https://or.invalid/api/v1/',
      fetch: f.fetch,
      assets: s.sink,
    });
    const { jobId } = await gen.submit(submitInput);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.url).toBe('https://or.invalid/api/v1/chat/completions');
    expect(f.calls[0]!.headers.get('authorization')).toBe('Bearer or-key');
    expect(f.calls[0]!.body).toEqual({
      model: 'vendor/image-model',
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '4:5' },
      messages: [{ role: 'user', content: 'A basalt quarry at dawn' }],
      provider: { data_collection: 'deny' },
      user: 'run_1',
    });
    expect(jobId).toBe('gen:upi_1,upi_2');
  });

  it('hands each image to asset ingest as a generated upload under the run actor, recording provenance', async () => {
    const s = fakeSink();
    await new OpenRouterImageGenerator({
      apiKey: 'k',
      model: 'vendor/image-model',
      fetch: fakeFetch().fetch,
      assets: s.sink,
    }).submit(submitInput);
    expect(s.uploads).toHaveLength(2);
    const first = s.uploads[0]!;
    expect(first.actor).toBe(actor);
    expect(first.opts).toEqual({ autonomyMode: 'create' });
    expect(first.input).toMatchObject({
      brandId: 'brd_1',
      kind: 'illustration',
      mime: 'image/png',
      originalFilename: 'generated-run_1-1.png',
      provenance: {
        kind: 'generated',
        model: 'openrouter:vendor/image-model',
        promptHash: createHash('sha256').update('A basalt quarry at dawn').digest('hex'),
        inputs: [],
        agentRunId: 'run_1',
      },
    });
    expect(first.input.bytes.equals(PNG)).toBe(true);
    // The prompt itself is never stored.
    expect(JSON.stringify(first.input.provenance)).not.toContain('basalt');
  });

  it('polls ingest: pending until every intent is accepted, failed on any rejection, done with the versions', async () => {
    const accepted = {
      intentId: 'upi_1',
      state: 'accepted' as const,
      assetId: 'ast_1',
      storageKey: 'k1',
      contentHash: 'h1',
      width: 1024,
      height: 1280,
    };
    const run = (statuses: Awaited<ReturnType<GeneratedAssetSink['status']>>) => {
      const s = fakeSink(statuses);
      return {
        s,
        result: new OpenRouterImageGenerator({ apiKey: 'k', model: 'm', assets: s.sink }).poll(
          'gen:upi_1,upi_2',
        ),
      };
    };
    const pending = run([accepted, { intentId: 'upi_2', state: 'pending' }]);
    expect(await pending.result).toEqual({ status: 'pending' });
    expect(pending.s.polled).toEqual([['upi_1', 'upi_2']]);
    expect(
      await run([accepted, { intentId: 'upi_2', state: 'rejected', reason: 'malware_detected' }]).result,
    ).toEqual({ status: 'failed', reason: 'ingest_rejected:malware_detected' });
    expect(await run([accepted, { ...accepted, intentId: 'upi_2', storageKey: 'k2' }]).result).toEqual({
      status: 'done',
      images: [
        { storageKey: 'k1', contentHash: 'h1', width: 1024, height: 1280 },
        { storageKey: 'k2', contentHash: 'h1', width: 1024, height: 1280 },
      ],
    });
    expect(await new OpenRouterImageGenerator({ apiKey: 'k', model: 'm' }).poll('other')).toEqual({
      status: 'failed',
      reason: 'unknown_job',
    });
  });

  it('treats 429, 5xx and connection failures as unavailable; a 4xx or an image-less answer as rejected', async () => {
    const submit = (f: typeof fetch) =>
      new OpenRouterImageGenerator({ apiKey: 'k', model: 'm', fetch: f, assets: fakeSink().sink }).submit(
        submitInput,
      );
    await expect(submit(fakeFetch(429, {}).fetch)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(submit(fakeFetch(503, {}).fetch)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(submit(fakeFetch(200, { error: { code: 502 } }).fetch)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(submit(failing)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(submit(fakeFetch(400, { error: { code: 400 } }).fetch)).rejects.toThrow(
      'image_generation_rejected:400',
    );
    await expect(submit(fakeFetch(200, { choices: [{ message: { content: 'no' } }] }).fetch)).rejects.toThrow(
      'image_generation_returned_no_image',
    );
  });

  it('is configured only when both the OpenRouter key and an image model id are set', () => {
    expect(createOpenRouterImageGeneratorFromEnv({ OPENROUTER_API_KEY_REF: 'or' })).toBeNull();
    expect(createOpenRouterImageGeneratorFromEnv({ OREMEDIA_IMAGE_MODEL_ID: 'm' })).toBeNull();
    expect(
      createOpenRouterImageGeneratorFromEnv({ OPENROUTER_API_KEY_REF: 'or', OREMEDIA_IMAGE_MODEL_ID: 'm' })
        ?.provider,
    ).toBe('openrouter');
  });
});
