import { BudgetExhaustedError } from '@oremedia/contracts/errors';
import type { GenerationErrorCode, StudioGenerationRuntimeV1 } from '@oremedia/contracts/generation';
import {
  assembleGenerationPrompt,
  assertRoutingAllowed,
  estimateCostMicros,
  generationTool,
  parseGenerationOutput,
  type ModelAdapter,
  type ModelConfig,
} from '@oremedia/ai';
import { budgets } from '@oremedia/module-billing';
import { generationJobs, generationModelCallRef } from '@oremedia/module-creative';

/**
 * STU-1b runtime behind studioGenerationWorkflowV1 (task queue `agents`, beside agent runs: it holds the model
 * adapter). The activity host establishes tenant context and resolves the requesting person as they are now; the
 * creative module owns the job row and every write. The model call is one bounded request whose answer must match
 * the strict schema; its cost is reserved before and charged once (the ledger key is the job attempt's call).
 */
export interface StudioGenerationRuntimeOptions {
  adapter: ModelAdapter;
  modelConfig: ModelConfig;
}

/** A ValidationFailed whose message names a sharper reason gets that code on the job. */
function refine(code: GenerationErrorCode, detail: string | undefined): GenerationErrorCode {
  if (code !== 'validation_failed' || !detail) return code;
  if (detail.includes('stale_document') || detail.includes('document changed')) return 'stale_document';
  if (detail.includes('model_output_invalid')) return 'model_output_invalid';
  return code;
}

export function createStudioGenerationRuntime(
  opts: StudioGenerationRuntimeOptions,
): StudioGenerationRuntimeV1 {
  return {
    begin: (input) => generationJobs.begin(input),
    reserve: (input) => generationJobs.reserve(input),

    async callModel(input, actor, hooks) {
      const ctx = await generationJobs.modelContext(actor, input);
      if (!ctx) return generationJobs.status(input); // output already stored, or the attempt is over
      const reservationId = await generationJobs.reservationIdOf(input);
      if (!reservationId) throw new BudgetExhaustedError('no_reservation');
      await assertRoutingAllowed(input.tenantId, opts.modelConfig.provider, opts.modelConfig.model); // before the call
      const prompt = assembleGenerationPrompt(ctx);
      hooks?.heartbeat(`generation:${input.jobId}:model`);
      const completion = await opts.adapter.complete({
        model: opts.modelConfig.model,
        system: prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        tools: [generationTool(ctx.variations)],
        maxOutputTokens: opts.modelConfig.maxOutputTokens,
        timeoutMs: opts.modelConfig.timeoutMs,
        metadata: { runId: input.jobId, tenantId: input.tenantId },
      });
      hooks?.heartbeat(`generation:${input.jobId}:model:done`);
      const costMicros = estimateCostMicros(opts.modelConfig, completion.usage);
      const callRef = generationModelCallRef(input.jobId, input.attempt);
      // Incurred cost is ledgered first (once per attempt's call); exceeding the reservation fails the job.
      await budgets.consume(
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
        output = parseGenerationOutput(completion, ctx.variations);
      } catch (err) {
        await generationJobs.addSpend(input, costMicros); // a refused answer still cost what it cost
        throw err;
      }
      return generationJobs.recordModelOutput(input, {
        output,
        callRef,
        structure: ctx.structure,
        costMicros,
      });
    },

    save: (input, actor) => generationJobs.save(actor, input),
    fail: (input, code, detail) => generationJobs.fail(input, refine(code, detail), detail),
    settle: (input) => generationJobs.settle(input),
  };
}
