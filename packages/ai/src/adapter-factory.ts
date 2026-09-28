import type { CapabilityCheck } from '@oremedia/observability';
import { createAnthropicAdapterFromEnv } from './anthropic-adapter';
import { FakeModelAdapter } from './fake-adapter';
import type { ModelAdapter } from './model-adapter';
import { createOpenRouterAdapterFromEnv } from './openrouter-adapter';

/**
 * ADR-11: OPENROUTER_API_KEY_REF selects the OpenRouter adapter (the default gateway); ANTHROPIC_API_KEY_REF selects
 * the direct Anthropic adapter when no OpenRouter key is set. Without either, production fails loudly at startup;
 * outside production OREMEDIA_FAKE_MODEL=1 selects the scripted fake (a model that always finishes) for local runs.
 */
export function createModelAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  const openRouter = createOpenRouterAdapterFromEnv(env);
  if (openRouter) return openRouter;
  const anthropic = createAnthropicAdapterFromEnv(env);
  if (anthropic) return anthropic;
  const production = env['NODE_ENV'] === 'production';
  if (!production && env['OREMEDIA_FAKE_MODEL'] === '1')
    return new FakeModelAdapter([{ kind: 'done', text: '{"note":"fake model: no work performed"}' }]);
  throw new Error(
    production
      ? 'OPENROUTER_API_KEY_REF (or ANTHROPIC_API_KEY_REF) is required in production (no model adapter configured)'
      : 'OPENROUTER_API_KEY_REF (or ANTHROPIC_API_KEY_REF) is required (set OREMEDIA_FAKE_MODEL=1 for the scripted fake outside production)',
  );
}

/**
 * Configuration report capability `models` (agents, the voice classifier, generators), following the selection above:
 * the OpenRouter key needs its default model (OREMEDIA_MODEL_ID, or a mounted routing policy) as routingPolicyFromEnv
 * requires; the direct Anthropic key stands alone. With neither, the default gateway's names are reported (ADR-11).
 */
export const modelsCapability: CapabilityCheck = {
  capability: 'models',
  missing: (env) => {
    if (env['OPENROUTER_API_KEY_REF'])
      return env['OREMEDIA_MODEL_ID'] || env['MODEL_ROUTING_POLICY_REF'] ? [] : ['OREMEDIA_MODEL_ID'];
    if (env['ANTHROPIC_API_KEY_REF']) return [];
    return ['OPENROUTER_API_KEY_REF', 'OREMEDIA_MODEL_ID'];
  },
};
