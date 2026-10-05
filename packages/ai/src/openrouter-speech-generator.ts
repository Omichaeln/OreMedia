import { createHash } from 'node:crypto';
import type { GenerationRestrictions } from '@oremedia/contracts/brand';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { DemoRefusedError, ProviderUnavailableError } from '@oremedia/contracts/errors';
import { logger } from '@oremedia/observability';
import { generatedAssetSink, type GeneratedAssetSink } from './generated-asset-sink';
import {
  openRouterApiKeyFromEnv,
  openRouterFetch,
  openRouterProviderPreferences,
} from './openrouter-adapter';
import { ToolDeniedError } from './tool-dispatcher';
import type { SpeechGenerator } from './tools/services';

export interface OpenRouterSpeechGeneratorOptions {
  apiKey: string;
  /** An OpenRouter text-to-speech model id (OREMEDIA_SPEECH_MODEL_ID); never a literal here. */
  model: string;
  /** The voice used when a call names none (OREMEDIA_SPEECH_VOICE); unset leaves the model's own default. */
  defaultVoice?: string;
  baseURL?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  assets?: GeneratedAssetSink;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const JOB_PREFIX = 'gen:';

/**
 * ADR-11 speech generation through OpenRouter's OpenAI-compatible POST /audio/speech, which answers with the audio
 * bytes. MP3 is requested because ingest checks it structurally (WAV would do too; raw PCM has no container). `submit`
 * generates and hands the file to the asset pipeline as a generated upload (committed on its own); the job id names
 * that upload and `poll` reports its state, as the image generator does. Providers that collect prompts are excluded,
 * and the brand's restrictions narrow the rest. The text is never logged; provenance records its hash.
 */
export class OpenRouterSpeechGenerator implements SpeechGenerator {
  readonly provider = 'openrouter';
  readonly model: string;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly assets: GeneratedAssetSink;

  constructor(private readonly opts: OpenRouterSpeechGeneratorOptions) {
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? openRouterFetch;
    this.assets = opts.assets ?? generatedAssetSink;
    this.model = opts.model;
  }

  async submit(input: {
    brandId: string;
    runId: string;
    text: string;
    voice: string | null;
    actor: ResolvedActor;
    autonomyMode: AutonomyMode;
    restrictions: GenerationRestrictions | null;
  }): Promise<{ jobId: string }> {
    const bytes = await this.speak(
      input.text,
      input.voice ?? this.opts.defaultVoice ?? null,
      input.restrictions,
    );
    const { intentId } = await this.assets.upload(
      input.actor,
      {
        brandId: input.brandId,
        kind: 'audio',
        mime: 'audio/mpeg',
        bytes,
        originalFilename: `generated-${input.runId}.mp3`,
        provenance: {
          kind: 'generated',
          model: `openrouter:${this.opts.model}`,
          promptHash: createHash('sha256').update(input.text).digest('hex'),
          inputs: [],
          agentRunId: input.runId,
        },
      },
      { autonomyMode: input.autonomyMode },
    );
    return { jobId: `${JOB_PREFIX}${intentId}` };
  }

  async poll(jobId: string) {
    if (!jobId.startsWith(JOB_PREFIX)) return { status: 'failed' as const, reason: 'unknown_job' };
    const [upload] = await this.assets.status([jobId.slice(JOB_PREFIX.length)]);
    if (!upload) return { status: 'failed' as const, reason: 'unknown_job' };
    if (upload.state === 'rejected')
      return { status: 'failed' as const, reason: `ingest_rejected:${upload.reason}` };
    if (upload.state !== 'accepted') return { status: 'pending' as const };
    return {
      status: 'done' as const,
      audio: { storageKey: upload.storageKey, contentHash: upload.contentHash },
    };
  }

  private async speak(
    text: string,
    voice: string | null,
    restrictions: GenerationRestrictions | null,
  ): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseURL}/audio/speech`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.model,
          input: text,
          ...(voice ? { voice } : {}),
          response_format: 'mp3',
          provider: openRouterProviderPreferences(restrictions),
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
    } catch (err) {
      if (err instanceof DemoRefusedError) throw err; // the egress guard refused: nothing was sent
      throw unavailable('connection failed or timed out');
    }
    if (res.status === 429 || res.status >= 500) throw unavailable(`status ${res.status}`);
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: number } };
      const code = json.error?.code ?? res.status;
      if (code === 429 || code >= 500) throw unavailable(`upstream ${code}`);
      // A refusal (an unknown voice, text the model will not read) repeats on every retry: the model is told, so it
      // can change the request, and nothing is retried.
      throw new ToolDeniedError(`speech_rejected:${code}`);
    }
    // Anything but audio (an error body with status 200, a format the model chose over mp3) never reaches ingest.
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!type.startsWith('audio/') && type !== 'application/octet-stream')
      throw new ToolDeniedError('speech_returned_no_audio');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await res.arrayBuffer());
    } catch {
      throw unavailable('response interrupted');
    }
    if (bytes.length === 0) throw new Error('speech_generation_returned_no_audio');
    return bytes;
  }
}

function unavailable(detail: string): ProviderUnavailableError {
  logger().warn({ errorMessage: `openrouter speech ${detail}` }, 'speech provider unavailable');
  return new ProviderUnavailableError('openrouter');
}

/**
 * Registered at composition when OPENROUTER_API_KEY_REF and OREMEDIA_SPEECH_MODEL_ID are both set; speech.generate
 * uses it once SPEECH_GEN_PROVIDER=openrouter and the creative.audio_generation flag is on for the tenant. The model
 * id and default voice are deployment configuration, never defaults here.
 */
export function createOpenRouterSpeechGeneratorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterSpeechGenerator | null {
  const apiKey = openRouterApiKeyFromEnv(env);
  const model = env['OREMEDIA_SPEECH_MODEL_ID'];
  if (!apiKey || !model) return null;
  const defaultVoice = env['OREMEDIA_SPEECH_VOICE'];
  const baseURL = env['OREMEDIA_OPENROUTER_BASE_URL'];
  return new OpenRouterSpeechGenerator({
    apiKey,
    model,
    ...(defaultVoice ? { defaultVoice } : {}),
    ...(baseURL ? { baseURL } : {}),
  });
}
