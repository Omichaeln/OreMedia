import { createHash } from 'node:crypto';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { ProviderUnavailableError } from '@oremedia/contracts/errors';
import { withTransaction } from '@oremedia/db';
import { assetService } from '@oremedia/module-assets';
import { logger } from '@oremedia/observability';
import { openRouterApiKeyFromEnv } from './openrouter-adapter';
import type { ImageGenerator } from './tools/services';

type GeneratedUpload = Parameters<typeof assetService.uploadGenerated>[1];

/** The asset-module surface the generator needs; a narrow seam so unit tests supply a fake without a database. */
export interface GeneratedAssetSink {
  /** Commits on its own: a retried tool call must find the uploads even when the tool's unit of work rolls back. */
  upload(
    actor: ResolvedActor,
    input: GeneratedUpload,
    opts: { autonomyMode: AutonomyMode },
  ): Promise<{ intentId: string }>;
  status: typeof assetService.generatedUploadStatus;
}

const assetSink: GeneratedAssetSink = {
  upload: (actor, input, opts) =>
    withTransaction((tx) => assetService.uploadGenerated(actor, input, tx, opts)),
  status: (intentIds, tx) => assetService.generatedUploadStatus(intentIds, tx),
};

export interface OpenRouterImageGeneratorOptions {
  apiKey: string;
  /** An OpenRouter image model id (OREMEDIA_IMAGE_MODEL_ID), e.g. a Nano Banana model; never a literal here. */
  model: string;
  baseURL?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  assets?: GeneratedAssetSink;
}

interface ImageResponse {
  choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
  error?: { code?: number; message?: string };
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const JOB_PREFIX = 'gen:';
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s;

/**
 * ADR-11 image generation through OpenRouter (chat completions with image output). OpenRouter answers
 * synchronously, so `submit` generates, then hands each image to the asset pipeline as a generated upload, each in
 * its own committed transaction so a retried tool call finds them; the job id names those upload intents. `poll`
 * reports done once ingest has accepted every image, failed if any was rejected. Providers that collect prompts are
 * excluded. Prompts are never logged; provenance records the prompt's hash, the model and the run.
 */
export class OpenRouterImageGenerator implements ImageGenerator {
  readonly provider = 'openrouter';
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly assets: GeneratedAssetSink;

  constructor(private readonly opts: OpenRouterImageGeneratorOptions) {
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.assets = opts.assets ?? assetSink;
  }

  async submit(input: {
    tenantId: string;
    brandId: string;
    runId: string;
    prompt: string;
    count: number;
    aspect: string;
    actor: ResolvedActor;
    autonomyMode: AutonomyMode;
  }): Promise<{ jobId: string }> {
    const images: Array<{ mime: string; bytes: Buffer }> = [];
    // One request per image: image models return one image per completion.
    for (let i = 0; i < input.count; i++)
      images.push(await this.generateOne(input.prompt, input.aspect, input.runId));
    const promptHash = createHash('sha256').update(input.prompt).digest('hex');
    const intentIds: string[] = [];
    for (const [i, img] of images.entries()) {
      const { intentId } = await this.assets.upload(
        input.actor,
        {
          brandId: input.brandId,
          kind: 'illustration',
          mime: img.mime,
          bytes: img.bytes,
          originalFilename: `generated-${input.runId}-${i + 1}.${img.mime.split('/')[1]}`,
          provenance: {
            kind: 'generated',
            model: `openrouter:${this.opts.model}`,
            promptHash,
            inputs: [],
            agentRunId: input.runId,
          },
        },
        { autonomyMode: input.autonomyMode },
      );
      intentIds.push(intentId);
    }
    return { jobId: `${JOB_PREFIX}${intentIds.join(',')}` };
  }

  async poll(jobId: string) {
    if (!jobId.startsWith(JOB_PREFIX)) return { status: 'failed' as const, reason: 'unknown_job' };
    const intentIds = jobId.slice(JOB_PREFIX.length).split(',').filter(Boolean);
    const statuses = await this.assets.status(intentIds);
    const rejected = statuses.find((s) => s.state === 'rejected');
    if (rejected) return { status: 'failed' as const, reason: `ingest_rejected:${rejected.reason}` };
    const accepted = statuses.flatMap((s) => (s.state === 'accepted' ? [s] : []));
    if (accepted.length < statuses.length) return { status: 'pending' as const };
    return {
      status: 'done' as const,
      images: accepted.map((s) => ({
        storageKey: s.storageKey,
        contentHash: s.contentHash,
        width: s.width,
        height: s.height,
      })),
    };
  }

  private async generateOne(
    prompt: string,
    aspect: string,
    runId: string,
  ): Promise<{ mime: string; bytes: Buffer }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.model,
          modalities: ['image', 'text'],
          image_config: { aspect_ratio: aspect },
          messages: [{ role: 'user', content: prompt }],
          provider: { data_collection: 'deny' },
          user: runId,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
    } catch {
      throw unavailable('connection failed or timed out');
    }
    if (res.status === 429 || res.status >= 500) throw unavailable(`status ${res.status}`);
    const json = (await res.json().catch(() => ({}))) as ImageResponse;
    if (!res.ok || json.error) {
      const code = json.error?.code ?? res.status;
      if (code === 429 || code >= 500) throw unavailable(`upstream ${code}`);
      throw new Error(`image_generation_rejected:${code}`);
    }
    const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? '';
    const m = DATA_URL.exec(url);
    if (!m) throw new Error('image_generation_returned_no_image');
    return { mime: m[1] as string, bytes: Buffer.from(m[2] as string, 'base64') };
  }
}

function unavailable(detail: string): ProviderUnavailableError {
  logger().warn({ errorMessage: `openrouter image ${detail}` }, 'image provider unavailable');
  return new ProviderUnavailableError('openrouter');
}

/**
 * Registered at composition when OPENROUTER_API_KEY_REF and OREMEDIA_IMAGE_MODEL_ID are both set; images.generate
 * uses it once IMAGE_GEN_PROVIDER=openrouter. The model id is deployment configuration, never a default here.
 */
export function createOpenRouterImageGeneratorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterImageGenerator | null {
  const apiKey = openRouterApiKeyFromEnv(env);
  const model = env['OREMEDIA_IMAGE_MODEL_ID'];
  if (!apiKey || !model) return null;
  const baseURL = env['OREMEDIA_OPENROUTER_BASE_URL'];
  return new OpenRouterImageGenerator(baseURL ? { apiKey, model, baseURL } : { apiKey, model });
}
