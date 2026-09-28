import { z } from 'zod';
import { PolicyDeniedError, ProviderUnavailableError } from '@oremedia/contracts/errors';
import type { ProviderJobKey } from '../provider-jobs';
import { assertRoutingAllowed } from '../routing-policy';
import { ToolDeniedError } from '../tool-dispatcher';
import type { ToolContext, ToolDefinition } from '../tool-registry';
import type { VideoGenerator } from './services';

const ASPECTS = ['16:9', '9:16', '1:1'] as const;

const GenerateInput = z
  .object({
    prompt: z.string().min(1).max(2000),
    seconds: z.number().int().min(1).max(20).default(5),
    aspect: z.enum(ASPECTS).default('9:16'),
  })
  .strict();

const StatusInput = z.object({ jobRef: z.string().min(3).max(300) }).strict();

const VideoOutput = z.object({
  /** Names the videos.generate call that owns the job; videos.status takes it. */
  jobRef: z.string(),
  status: z.enum(['done', 'pending']),
  video: z
    .object({ storageKey: z.string(), contentHash: z.string(), width: z.number(), height: z.number() })
    .nullable(),
});
type VideoOutput = z.infer<typeof VideoOutput>;

/** Placeholder price per generated second (D-08 price list); consumed from the reservation before the call. */
export const VIDEO_COST_MICROS_PER_SECOND = 100_000;
const POLL_INTERVAL_MS = 5000;
/**
 * A tool call runs inside one dispatchTool activity (5 minutes, agent-run workflow v1); the tool deadline leaves the
 * activity room to record the outcome. The poll that sees a render finish downloads the clip and uploads it, which
 * can take this long (the generator's status call, download and upload timeouts), so no poll starts unless it fits
 * before the deadline: the call answers `pending` with its job ref instead, and videos.status picks the job up.
 */
const TOOL_TIMEOUT_MS = 280_000;
const POLL_BUDGET_MS = 170_000;
const FLAG = 'creative.video_generation';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jobRefOf = (key: ProviderJobKey) => `${key.stepId}/${key.toolCallId}`;

/**
 * Polls the call's job until it is done, failed or out of time. A poll that hands the finished render to ingest
 * returns the next stage's job id, which is persisted before polling it (ProviderJobStore.advance). Once a job is
 * persisted the charge is spent, so every exit except a provider failure returns the job ref: a provider that is
 * briefly unavailable answers `pending` (videos.status retries it) rather than a denial that would strand the job.
 */
async function follow(
  generator: VideoGenerator,
  key: ProviderJobKey,
  jobId: string,
  ctx: ToolContext,
  deadline: number,
): Promise<VideoOutput> {
  const by = {
    brandId: ctx.run.brandId,
    runId: ctx.run.runId,
    actor: ctx.actor,
    autonomyMode: ctx.run.policy.autonomyMode,
  };
  const pending = (): VideoOutput => ({ jobRef: jobRefOf(key), status: 'pending', video: null });
  for (;;) {
    if (Date.now() + POLL_BUDGET_MS > deadline) return pending();
    let status: Awaited<ReturnType<VideoGenerator['poll']>>;
    try {
      status = await generator.poll(jobId, by);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) return pending();
      throw err; // infrastructure failures retry through Temporal; the retry polls the persisted job
    }
    if (status.status === 'done') {
      await ctx.providerJobs.finish(key, 'succeeded');
      return { jobRef: jobRefOf(key), status: 'done', video: status.video };
    }
    if (status.status === 'failed') {
      await ctx.providerJobs.finish(key, 'failed');
      throw new ToolDeniedError(`provider_failed:${status.reason}`.slice(0, 80));
    }
    if (status.next) {
      await ctx.providerJobs.advance(key, jobId, status.next);
      jobId = status.next;
      continue;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * videos.generate: draft (costed per second), creative.edit, behind creative.video_generation. The clip becomes a
 * pending asset (provenance generated). The provider job id is persisted before waiting, so a retried activity polls
 * instead of resubmitting; a render that outlasts the wait answers `pending` with a job ref for videos.status. The
 * company routing policy is checked in `availability`, before the charge (spec 12.7); the brand's generation
 * restrictions from the run's context snapshot go with the submission (ADR-11 (5)).
 */
export const videosGenerate: ToolDefinition<z.infer<typeof GenerateInput>, VideoOutput> = {
  name: 'videos.generate',
  description:
    'Generates one short video clip from a prompt as a pending asset. Costed per second against the run budget. ' +
    'If the clip is still rendering when the call returns, status is "pending": call videos.status with the jobRef.',
  input: GenerateInput,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 2000 },
      seconds: { type: 'integer', minimum: 1, maximum: 20 },
      aspect: { type: 'string', enum: [...ASPECTS] },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  output: VideoOutput,
  action: 'creative.edit',
  effect: 'draft',
  costKind: 'video_generation',
  costEstimateMicros: (input) => input.seconds * VIDEO_COST_MICROS_PER_SECOND,
  async availability({ services, run }) {
    if (!(await services.flags.isEnabled(FLAG, run.tenantId))) return 'feature_disabled';
    if (!services.videos) return 'provider_not_configured';
    try {
      await assertRoutingAllowed(run.tenantId, services.videos.provider, services.videos.model);
    } catch (err) {
      if (err instanceof PolicyDeniedError) return err.reason;
      throw err;
    }
    return null;
  },
  timeoutMs: TOOL_TIMEOUT_MS,
  async run(input, ctx) {
    const deadline = Date.now() + TOOL_TIMEOUT_MS;
    const generator = ctx.services.videos;
    if (!generator) throw new ToolDeniedError('provider_not_configured');
    const key = {
      runId: ctx.run.runId,
      stepId: ctx.run.stepId,
      toolName: videosGenerate.name,
      toolCallId: ctx.toolCallId,
    };
    let jobId = await ctx.providerJobs.find(key);
    if (!jobId) {
      const submitted = await generator.submit({
        tenantId: ctx.run.tenantId,
        brandId: ctx.run.brandId,
        runId: ctx.run.runId,
        prompt: input.prompt,
        seconds: input.seconds,
        aspect: input.aspect,
        restrictions: ctx.snapshot?.brand.policy.generation ?? null,
      });
      jobId = submitted.jobId;
      // Before waiting, and committed on its own: the tool's unit of work rolls back on a timeout, the job id must not.
      await ctx.providerJobs.persist(key, {
        brandId: ctx.run.brandId,
        provider: generator.provider,
        providerJobId: jobId,
      });
    }
    return follow(generator, key, jobId, ctx, deadline);
  },
};

/**
 * videos.status: draft (no charge), creative.edit. Follows a job a videos.generate call of the same run started; the
 * job ref resolves only under the run's own id, so a ref from another run (or tenant) is unknown_job. Not gated by
 * the flag: a clip whose job ref the model already holds can still be collected after the flag is turned off (a
 * videos.generate retry after the flag went off is denied before it runs, like any new call).
 */
export const videosStatus: ToolDefinition<z.infer<typeof StatusInput>, VideoOutput> = {
  name: 'videos.status',
  description:
    'Waits for a clip that videos.generate returned as "pending" in this run, by its jobRef. No charge. ' +
    'Returns the pending asset when the clip is ready, or "pending" again.',
  input: StatusInput,
  inputSchema: {
    type: 'object',
    properties: { jobRef: { type: 'string', minLength: 3, maxLength: 300 } },
    required: ['jobRef'],
    additionalProperties: false,
  },
  output: VideoOutput,
  action: 'creative.edit',
  effect: 'draft',
  availability: ({ services }) => (services.videos ? null : 'provider_not_configured'),
  timeoutMs: TOOL_TIMEOUT_MS,
  async run(input, ctx) {
    const deadline = Date.now() + TOOL_TIMEOUT_MS;
    const generator = ctx.services.videos;
    if (!generator) throw new ToolDeniedError('provider_not_configured');
    const slash = input.jobRef.indexOf('/');
    if (slash <= 0) throw new ToolDeniedError('unknown_job');
    const key = {
      runId: ctx.run.runId,
      stepId: input.jobRef.slice(0, slash),
      toolName: videosGenerate.name,
      toolCallId: input.jobRef.slice(slash + 1),
    };
    const jobId = await ctx.providerJobs.find(key);
    if (!jobId) throw new ToolDeniedError('unknown_job');
    return follow(generator, key, jobId, ctx, deadline);
  },
};
