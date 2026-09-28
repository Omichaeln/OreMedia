import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { GeneratedAssetSink } from './generated-asset-sink';
import {
  OpenRouterSpeechGenerator,
  createOpenRouterSpeechGeneratorFromEnv,
} from './openrouter-speech-generator';

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00]);
const actor = { kind: 'service_principal', id: 'sp_1' } as unknown as ResolvedActor;
const submitInput = {
  tenantId: 'ten_A',
  brandId: 'brd_1',
  runId: 'run_1',
  text: 'Quarried in the Great Dyke, finished by hand.',
  voice: null,
  actor,
  autonomyMode: 'create' as const,
  restrictions: null,
};

function fakeFetch(respond: () => Response) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(await req.text()) as Record<string, unknown>,
    });
    return respond();
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}
const audio = () => new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });

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

const generator = (f: ReturnType<typeof fakeFetch>, s = fakeSink(), defaultVoice?: string) =>
  new OpenRouterSpeechGenerator({
    apiKey: 'or-key',
    model: 'vendor/tts-model',
    baseURL: 'https://or.invalid/api/v1/',
    fetch: f.fetch,
    assets: s.sink,
    ...(defaultVoice ? { defaultVoice } : {}),
  });

describe('OpenRouterSpeechGenerator (ADR-11, ledger 4.26)', () => {
  it('requests MP3 speech with the explicit model and no-data-collection routing, and hands it to ingest', async () => {
    const f = fakeFetch(audio);
    const s = fakeSink();
    const { jobId } = await generator(f, s).submit({
      ...submitInput,
      voice: 'alloy',
      restrictions: { permittedProviders: [], deniedProviders: ['someone'], zeroRetention: false },
    });
    expect(jobId).toBe('gen:upi_1');
    expect(f.calls[0]!.url).toBe('https://or.invalid/api/v1/audio/speech');
    expect(f.calls[0]!.headers.get('authorization')).toBe('Bearer or-key');
    expect(f.calls[0]!.body).toEqual({
      model: 'vendor/tts-model',
      input: submitInput.text,
      voice: 'alloy',
      response_format: 'mp3',
      provider: { data_collection: 'deny', ignore: ['someone'] },
    });
    const [uploadActor, input, opts] = s.uploads[0]!;
    expect(uploadActor).toBe(actor);
    expect(opts).toEqual({ autonomyMode: 'create' });
    expect(input).toMatchObject({
      brandId: 'brd_1',
      kind: 'audio',
      mime: 'audio/mpeg',
      originalFilename: 'generated-run_1.mp3',
      provenance: {
        kind: 'generated',
        model: 'openrouter:vendor/tts-model',
        promptHash: createHash('sha256').update(submitInput.text).digest('hex'),
        inputs: [],
        agentRunId: 'run_1',
      },
    });
    expect(input.bytes.equals(MP3)).toBe(true);
  });

  it('a call without a voice uses the configured default, or sends none', async () => {
    const withDefault = fakeFetch(audio);
    await generator(withDefault, fakeSink(), 'nova').submit(submitInput);
    expect(withDefault.calls[0]!.body['voice']).toBe('nova');
    const without = fakeFetch(audio);
    await generator(without).submit(submitInput);
    expect(without.calls[0]!.body).not.toHaveProperty('voice');
  });

  it('poll reports the accepted upload, or the rejection reason', async () => {
    const accepted = fakeSink([
      {
        intentId: 'upi_1',
        state: 'accepted',
        assetId: 'ast_1',
        storageKey: 'k',
        contentHash: 'h'.repeat(64),
        width: 0,
        height: 0,
      },
    ]);
    expect(await generator(fakeFetch(audio), accepted).poll('gen:upi_1')).toEqual({
      status: 'done',
      audio: { storageKey: 'k', contentHash: 'h'.repeat(64) },
    });
    const rejected = fakeSink([{ intentId: 'upi_1', state: 'rejected', reason: 'media_malformed' }]);
    expect(await generator(fakeFetch(audio), rejected).poll('gen:upi_1')).toEqual({
      status: 'failed',
      reason: 'ingest_rejected:media_malformed',
    });
    expect(await generator(fakeFetch(audio)).poll('job_other')).toEqual({
      status: 'failed',
      reason: 'unknown_job',
    });
  });

  it('429 and 5xx are the provider being unavailable; a refusal or a non-audio answer is a denial; nothing is uploaded', async () => {
    const s = fakeSink();
    const busy = fakeFetch(() => new Response('{}', { status: 503 }));
    await expect(generator(busy, s).submit(submitInput)).rejects.toBeInstanceOf(ProviderUnavailableError);
    const refused = fakeFetch(() => new Response(JSON.stringify({ error: { code: 400 } }), { status: 400 }));
    await expect(generator(refused, s).submit(submitInput)).rejects.toMatchObject({
      reason: 'speech_rejected:400',
    });
    const notAudio = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: 'no' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(generator(notAudio, s).submit(submitInput)).rejects.toMatchObject({
      reason: 'speech_returned_no_audio',
    });
    expect(s.uploads).toHaveLength(0);
  });

  it('is built from the environment only when the key and the model id are both set', () => {
    expect(createOpenRouterSpeechGeneratorFromEnv({ OPENROUTER_API_KEY_REF: 'or' })).toBeNull();
    expect(createOpenRouterSpeechGeneratorFromEnv({ OREMEDIA_SPEECH_MODEL_ID: 'm' })).toBeNull();
    expect(
      createOpenRouterSpeechGeneratorFromEnv({ OPENROUTER_API_KEY_REF: 'or', OREMEDIA_SPEECH_MODEL_ID: 'm' })
        ?.model,
    ).toBe('m');
  });
});
