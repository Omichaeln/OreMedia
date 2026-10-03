import { randomUUID } from 'node:crypto';
import { BudgetExhaustedError } from '@oremedia/contracts/errors';
import type { StudioVideoJobRuntimeV1, VideoAiErrorCode } from '@oremedia/contracts/video-ai';
import {
  assembleVideoAiPrompt,
  assertRoutingAllowed,
  estimateCostMicros,
  parseVideoAiOutput,
  videoAiTool,
  type ModelAdapter,
  type ModelConfig,
} from '@oremedia/ai';
import { budgets } from '@oremedia/module-billing';
import { videoAiJobs, videoJobModelCallRef } from '@oremedia/module-creative';

/**
 * STU-3 runtime behind studioVideoJobWorkflowV1 (task queue `agents`, beside agent runs: it holds the model
 * adapter). The activity host establishes tenant context and resolves the requesting person as they are now; the
 * creative module owns the job row and every write. The model call is one bounded request whose answer must match
 * the strict schema; its cost is reserved before and charged once (the ledger key is the job attempt's call).
 */
export interface StudioVideoRuntimeOptions {
  adapter: ModelAdapter;
  modelConfig: ModelConfig;
}

/** A ValidationFailed whose message names a sharper reason gets that code on the job. */
function refine(code: VideoAiErrorCode, detail: string | undefined): VideoAiErrorCode {
  if (code !== 'validation_failed' || !detail) return code;
  if (detail.includes('stale_document') || detail.includes('changed while')) return 'stale_document';
  if (detail.includes('model_output_invalid')) return 'model_output_invalid';
  return code;
}

export function createStudioVideoRuntime(opts: StudioVideoRuntimeOptions): StudioVideoJobRuntimeV1 {
  return {
    begin: (input) => videoAiJobs.begin(input),
    reserve: (input) => videoAiJobs.reserve(input),

    async callModel(input, actor, hooks) {
      const ctx = await videoAiJobs.modelContext(actor, input);
      if (!ctx) return videoAiJobs.status(input); // output already stored, or the attempt is over
      const reservationId = await videoAiJobs.reservationIdOf(input);
      if (!reservationId) throw new BudgetExhaustedError('no_reservation');
      await assertRoutingAllowed(input.tenantId, opts.modelConfig.provider, opts.modelConfig.model); // before the call
      const prompt = assembleVideoAiPrompt(ctx);
      hooks?.heartbeat(`video-job:${input.jobId}:model`);
      const completion = await opts.adapter.complete({
        model: opts.modelConfig.model,
        system: prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        tools: [videoAiTool(ctx.request.kind)],
        maxOutputTokens: opts.modelConfig.maxOutputTokens,
        timeoutMs: opts.modelConfig.timeoutMs,
        metadata: { runId: input.jobId, tenantId: input.tenantId },
      });
      hooks?.heartbeat(`video-job:${input.jobId}:model:done`);
      const costMicros = estimateCostMicros(opts.modelConfig, completion.usage);
      // One ledger key per real call: a retried activity that calls the model again is billed again.
      const callRef = `${videoJobModelCallRef(input.jobId, input.attempt)}:${randomUUID()}`;
      // Incurred cost is always ledgered, even if a cancel closed the reservation while the call ran.
      const billed = await budgets.consumeIncurred(
        reservationId,
        ctx.brandId,
        'model_tokens',
        completion.usage.inputTokens + completion.usage.outputTokens,
        'tokens',
        costMicros,
        callRef,
        callRef,
      );
      let output;
      try {
        output = parseVideoAiOutput(completion, ctx.request.kind);
      } catch (err) {
        await videoAiJobs.addSpend(input, costMicros); // a refused answer still cost what it cost
        throw err;
      }
      if (billed.exceeded) {
        await videoAiJobs.addSpend(input, costMicros);
        throw new BudgetExhaustedError('run');
      }
      return videoAiJobs.recordModelOutput(input, { output, callRef, costMicros });
    },

    save: (input, actor) => videoAiJobs.save(actor, input),
    fail: (input, code, detail) => videoAiJobs.fail(input, refine(code, detail), detail),
    settle: (input) => videoAiJobs.settle(input),
  };
}
