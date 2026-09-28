import { createHash } from 'node:crypto';
import type { GenerationRestrictions } from '@oremedia/contracts/brand';
import { ProviderUnavailableError } from '@oremedia/contracts/errors';
import { logger } from '@oremedia/observability';
import { openRouterApiKeyFromEnv, openRouterProviderPreferences } from './openrouter-adapter';
import { generatedAssetSink, type GeneratedAssetSink } from './generated-asset-sink';
import type { VideoGenerator } from './tools/services';

export interface OpenRouterVideoGeneratorOptions {
  apiKey: string;
  /** An OpenRouter video model id (OREMEDIA_VIDEO_MODEL_ID), e.g. a Seedance model; never a literal here. */
  model: string;
  baseURL?: string;
  timeoutMs?: number;
  /** The clip download, which can be tens of megabytes (videos.generate budgets for status, download and upload). */
  downloadTimeoutMs?: number;
  fetch?: typeof fetch;
  assets?: GeneratedAssetSink;
}

interface VideoJobResponse {
  id?: string;
  status?: string;
  error?: string | { code?: number; message?: string };
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
/** Stage 1, the provider's render: `vid:<sha256 of the prompt>:<OpenRouter job id>`. */
const RENDER_PREFIX = 'vid:';
/** Stage 2, ingest of the downloaded clip: `gen:<upload intent id>`, as the image generator names its jobs. */
const INGEST_PREFIX = 'gen:';
const RENDER_FAILED = new Set(['failed', 'cancelled', 'expired']);

/**
 * ADR-11 video generation through OpenRouter's asynchronous video API: POST /videos accepts a job, GET /videos/{id}
 * reports it, GET /videos/{id}/content returns the clip. `submit` only starts the render. The `poll` that sees it
 * completed downloads the clip, hands it to the asset pipeline as a generated upload (committed on its own) and
 * returns the ingest stage's job id as `next`; later polls read the upload's state. Providers that collect prompts
 * are excluded, and the brand's restrictions narrow the rest (openRouterProviderPreferences). Prompts are never
 * logged; provenance records the prompt's hash (carried in the job id, so a poll in a later step still has it), the
 * model and the run.
 */
export class OpenRouterVideoGenerator implements VideoGenerator {
  readonly provider = 'openrouter';
  readonly model: string;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly assets: GeneratedAssetSink;

  constructor(private readonly opts: OpenRouterVideoGeneratorOptions) {
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.assets = opts.assets ?? generatedAssetSink;
    this.model = opts.model;
  }

  async submit(input: {
    runId: string;
    prompt: string;
    seconds: number;
    aspect: string;
    restrictions: GenerationRestrictions | null;
  }): Promise<{ jobId: string }> {
    const res = await this.call('/videos', {
      method: 'POST',
      body: JSON.stringify({
        model: this.opts.model,
        prompt: input.prompt,
        duration: input.seconds,
        aspect_ratio: input.aspect,
        provider: openRouterProviderPreferences(input.restrictions),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as VideoJobResponse;
    if (!res.ok || json.error) {
      const code = (typeof json.error === 'object' ? json.error.code : undefined) ?? res.status;
      if (code === 429 || code >= 500) throw unavailable(`upstream ${code}`);
      throw new Error(`video_generation_rejected:${code}`);
    }
    if (!json.id) throw new Error('video_generation_returned_no_job');
    const promptHash = createHash('sha256').update(input.prompt).digest('hex');
    return { jobId: `${RENDER_PREFIX}${promptHash}:${json.id}` };
  }

  async poll(jobId: string, by: Parameters<VideoGenerator['poll']>[1]) {
    if (jobId.startsWith(INGEST_PREFIX)) return this.pollIngest(jobId.slice(INGEST_PREFIX.length));
    if (!jobId.startsWith(RENDER_PREFIX)) return { status: 'failed' as const, reason: 'unknown_job' };
    const [promptHash, renderId] = splitOnce(jobId.slice(RENDER_PREFIX.length), ':');
    if (!promptHash || !renderId) return { status: 'failed' as const, reason: 'unknown_job' };

    const res = await this.call(`/videos/${encodeURIComponent(renderId)}`, { method: 'GET' });
    if (res.status === 404) return { status: 'failed' as const, reason: 'render_not_found' };
    // Any other refusal (an expired key, a job of another account) does not change on a retry.
    if (!res.ok) return { status: 'failed' as const, reason: `status_rejected_${res.status}` };
    const json = (await res.json().catch(() => ({}))) as VideoJobResponse;
    const status = json.status ?? '';
    if (RENDER_FAILED.has(status)) {
      const detail = typeof json.error === 'string' ? json.error : json.error?.message;
      logger().warn(
        { errorMessage: `openrouter video ${status}: ${detail ?? 'no detail'}` },
        'video render failed',
      );
      return { status: 'failed' as const, reason: `render_${status}` };
    }
    if (status !== 'completed') return { status: 'pending' as const };

    const clip = await this.download(renderId);
    if (!clip.ok) return { status: 'failed' as const, reason: `download_rejected_${clip.status}` };
    const { intentId } = await this.assets.upload(
      by.actor,
      {
        brandId: by.brandId,
        kind: 'video',
        mime: clip.mime,
        bytes: clip.bytes,
        originalFilename: `generated-${by.runId}.${clip.mime === 'video/quicktime' ? 'mov' : 'mp4'}`,
        provenance: {
          kind: 'generated',
          model: `openrouter:${this.opts.model}`,
          promptHash,
          inputs: [],
          agentRunId: by.runId,
        },
      },
      { autonomyMode: by.autonomyMode },
    );
    return { status: 'pending' as const, next: `${INGEST_PREFIX}${intentId}` };
  }

  private async pollIngest(intentId: string) {
    const [upload] = await this.assets.status([intentId]);
    if (!upload) return { status: 'failed' as const, reason: 'unknown_job' };
    if (upload.state === 'rejected')
      return { status: 'failed' as const, reason: `ingest_rejected:${upload.reason}` };
    if (upload.state !== 'accepted') return { status: 'pending' as const };
    return {
      status: 'done' as const,
      video: {
        storageKey: upload.storageKey,
        contentHash: upload.contentHash,
        width: upload.width,
        height: upload.height,
      },
    };
  }

  private async download(
    renderId: string,
  ): Promise<{ ok: true; mime: string; bytes: Buffer } | { ok: false; status: number }> {
    const res = await this.call(
      `/videos/${encodeURIComponent(renderId)}/content?index=0`,
      { method: 'GET' },
      this.opts.downloadTimeoutMs ?? 90_000,
    );
    if (!res.ok) return { ok: false, status: res.status };
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await res.arrayBuffer());
    } catch {
      throw unavailable('download interrupted');
    }
    if (bytes.length === 0) throw new Error('video_generation_returned_no_video');
    // The declared type is only a hint: ingest sniffs the bytes and checks the container itself.
    const declared = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    return { ok: true, mime: declared === 'video/quicktime' ? declared : 'video/mp4', bytes };
  }

  /**
   * One request; transport failures, 429 and 5xx are the provider being unavailable. Before a job exists that is a
   * denial the model may retry; once it exists, videos.generate answers pending and videos.status polls again.
   */
  private async call(path: string, init: RequestInit, timeoutMs = this.opts.timeoutMs ?? 30_000) {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseURL}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw unavailable('connection failed or timed out');
    }
    if (res.status === 429 || res.status >= 500) throw unavailable(`status ${res.status}`);
    return res;
  }
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

function unavailable(detail: string): ProviderUnavailableError {
  logger().warn({ errorMessage: `openrouter video ${detail}` }, 'video provider unavailable');
  return new ProviderUnavailableError('openrouter');
}

/**
 * Registered at composition when OPENROUTER_API_KEY_REF and OREMEDIA_VIDEO_MODEL_ID are both set; videos.generate
 * uses it once VIDEO_GEN_PROVIDER=openrouter and the creative.video_generation flag is on for the tenant. The model
 * id is deployment configuration, never a default here.
 */
export function createOpenRouterVideoGeneratorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterVideoGenerator | null {
  const apiKey = openRouterApiKeyFromEnv(env);
  const model = env['OREMEDIA_VIDEO_MODEL_ID'];
  if (!apiKey || !model) return null;
  const baseURL = env['OREMEDIA_OPENROUTER_BASE_URL'];
  return new OpenRouterVideoGenerator(baseURL ? { apiKey, model, baseURL } : { apiKey, model });
}
