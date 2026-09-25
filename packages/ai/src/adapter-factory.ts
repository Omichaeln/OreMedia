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
