import { z } from 'zod';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { assertRoutingAllowed } from '../routing-policy';
import { ToolDeniedError } from '../tool-dispatcher';
import type { ToolDefinition } from '../tool-registry';

const GenerateInput = z
  .object({
    text: z.string().min(1).max(4000),
    voice: z.string().min(1).max(50).optional(),
  })
  .strict();

const GenerateOutput = z.object({
  jobId: z.string(),
  audio: z.object({ storageKey: z.string(), contentHash: z.string() }),
});

/** Placeholder price per started 1,000 characters (D-08 price list); consumed from the reservation before the call. */
export const SPEECH_COST_MICROS_PER_1K_CHARS = 30_000;
const POLL_INTERVAL_MS = 1000;
const FLAG = 'creative.audio_generation';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * speech.generate: draft (costed per started 1,000 characters), creative.edit, behind creative.audio_generation. The
 * narration is a pending audio asset (provenance generated). The provider answers synchronously, so the job id names
 * the ingest upload; it is persisted before waiting so a retried activity polls instead of generating again. The
 * company routing policy is checked in `availability`, before the charge (spec 12.7); the brand's generation
 * restrictions from the run's context snapshot go with the request (ADR-11 (5)).
 */
export const speechGenerate: ToolDefinition<z.infer<typeof GenerateInput>, z.infer<typeof GenerateOutput>> = {
  name: 'speech.generate',
  description:
    'Reads text aloud as a narration audio file (a pending asset). Costed per 1,000 characters against the run ' +
    'budget. voice is optional and must be one the configured speech model offers.',
  input: GenerateInput,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 4000 },
      voice: { type: 'string', minLength: 1, maxLength: 50 },
    },
    required: ['text'],
    additionalProperties: false,
  },
  output: GenerateOutput,
  action: 'creative.edit',
  effect: 'draft',
  costKind: 'audio_generation',
  costEstimateMicros: (input) => Math.ceil(input.text.length / 1000) * SPEECH_COST_MICROS_PER_1K_CHARS,
  async availability({ services, run }) {
    if (!(await services.flags.isEnabled(FLAG, run.tenantId))) return 'feature_disabled';
    if (!services.speech) return 'provider_not_configured';
    try {
      await assertRoutingAllowed(run.tenantId, services.speech.provider, services.speech.model);
    } catch (err) {
      if (err instanceof PolicyDeniedError) return err.reason;
      throw err;
    }
    return null;
  },
  timeoutMs: 180_000,
  async run(input, ctx) {
    const generator = ctx.services.speech;
    if (!generator) throw new ToolDeniedError('provider_not_configured');
    const key = {
      runId: ctx.run.runId,
      stepId: ctx.run.stepId,
      toolName: speechGenerate.name,
      toolCallId: ctx.toolCallId,
    };
    let jobId = await ctx.providerJobs.find(key);
    if (!jobId) {
      const submitted = await generator.submit({
        tenantId: ctx.run.tenantId,
        brandId: ctx.run.brandId,
        runId: ctx.run.runId,
        text: input.text,
        voice: input.voice ?? null,
        actor: ctx.actor,
        autonomyMode: ctx.run.policy.autonomyMode,
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
    for (;;) {
      const status = await generator.poll(jobId);
      if (status.status === 'done') {
        await ctx.providerJobs.finish(key, 'succeeded');
        return { jobId, audio: status.audio };
      }
      if (status.status === 'failed') {
        await ctx.providerJobs.finish(key, 'failed');
        throw new ToolDeniedError(`provider_failed:${status.reason}`.slice(0, 80));
      }
      await sleep(POLL_INTERVAL_MS);
    }
  },
};
