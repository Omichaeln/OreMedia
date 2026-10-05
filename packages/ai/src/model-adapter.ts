import type { ZodTypeAny } from 'zod';
import type { ModelCompletion, ModelRequest, ModelUsage } from '@oremedia/contracts/agents';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import { routingPolicyFromEnv } from './routing-policy';

/** Spec 12.7 / CONVENTIONS "Model calls": every model call goes through ModelAdapter.complete. */
export interface ModelAdapter {
  readonly provider: 'anthropic' | string;
  complete(req: ModelRequest): Promise<ModelCompletion>;
}

/**
 * The model provider refused a request (an HTTP 4xx other than 429, or the same code in an OpenRouter error body):
 * a ValidationFailedError with the same code, message and detail as before, which also carries the provider's status
 * and any usage it reported with the refusal, so a caller can tell the provider's refusal from its own validation
 * and account an attempt the provider billed.
 */
export class ModelRequestRejectedError extends ValidationFailedError {
  readonly status: number;
  readonly usage: ModelUsage | null;
  /** `detail` is the status and the provider's bounded message (`rejectionDetail`). */
  constructor(status: number, detail: string, usage: ModelUsage | null = null) {
    super(
      [{ path: 'model', issue: `provider rejected the request (${detail})` }],
      `The model provider rejected the request (${detail})`,
    );
    // Failure types and retry policies read the name (`ValidationFailedError` non-retryable): it stays the same.
    this.name = 'ValidationFailedError';
    this.status = status;
    this.usage = usage;
  }
}

/**
 * Providers accept tool names matching `^[a-zA-Z0-9_-]{1,64}$` (OpenAI and Anthropic alike); the platform's tool
 * names are dotted (`facts.list`). Adapters send this wire form and map each tool call back to the platform name
 * through the request's own tools (`toolNamesOf`), so policies, audit and workflows keep the dotted names.
 */
export const wireToolName = (name: string): string => name.replace(/\./g, '__');
export const toolNamesOf = (tools: readonly { name: string }[]): ReadonlyMap<string, string> =>
  new Map(tools.map((t) => [wireToolName(t.name), t.name]));

type ZodDef = { typeName?: string } & Record<string, unknown>;
const defOf = (schema: ZodTypeAny): ZodDef => schema._def as ZodDef;

/**
 * A request's `responseSchema` from the zod schema its answer is validated with, so the two never disagree. Strict
 * structured output accepts a closed object whose properties are all required, so an optional field is written as
 * nullable (`withoutNullOptionals` turns the null back into an absent field before validation). Bounds (lengths,
 * counts, numeric limits) are left out, as providers reject or ignore them in strict mode; zod still enforces them.
 * Covers the subset answer schemas use and throws on anything else, so a new construct is never sent loosened.
 */
export function strictJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (def['shape'] as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(shape)) properties[k] = strictJsonSchema(v);
      return { type: 'object', properties, required: Object.keys(shape), additionalProperties: false };
    }
    case 'ZodOptional':
    case 'ZodNullable':
      return { anyOf: [strictJsonSchema(def['innerType'] as ZodTypeAny), { type: 'null' }] };
    case 'ZodArray':
      return { type: 'array', items: strictJsonSchema(def['type'] as ZodTypeAny) };
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber': {
      const checks = (def['checks'] ?? []) as Array<{ kind: string }>;
      return { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: [...(def['values'] as string[])] };
    default:
      throw new Error(`strictJsonSchema: ${def.typeName ?? 'unknown'} is not supported`);
  }
}

/**
 * The answer as its zod schema reads it: a null in an optional, non-nullable field (how strict structured output
 * writes "left out") becomes an absent field. Nothing else changes; a null anywhere else is still refused by zod.
 */
export function withoutNullOptionals(schema: ZodTypeAny, value: unknown): unknown {
  const def = defOf(schema);
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable')
    return value === null ? value : withoutNullOptionals(def['innerType'] as ZodTypeAny, value);
  if (def.typeName === 'ZodArray' && Array.isArray(value))
    return value.map((v) => withoutNullOptionals(def['type'] as ZodTypeAny, v));
  if (def.typeName === 'ZodObject' && value && typeof value === 'object' && !Array.isArray(value)) {
    const shape = (def['shape'] as () => Record<string, ZodTypeAny>)();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const field = shape[k];
      if (!field) out[k] = v;
      else if (v === null && field.isOptional() && !field.isNullable()) continue;
      else out[k] = withoutNullOptionals(field, v);
    }
    return out;
  }
  return value;
}

/** The model configuration a run records (agent_runs.model_config) and prices its usage with. */
export interface ModelConfig {
  provider: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Price list in micro-units per million tokens; configuration, not a literal at a call site. */
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
}

const DEFAULT_INPUT_MICROS_PER_MTOKEN = 5_000_000; // USD 5 / 1M input tokens (placeholder price list, D-08)
const DEFAULT_OUTPUT_MICROS_PER_MTOKEN = 25_000_000; // USD 25 / 1M output tokens

const intFrom = (value: string | undefined, fallback: number): number => {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const policy = routingPolicyFromEnv(env);
  return {
    provider: env['OREMEDIA_MODEL_PROVIDER'] ?? policy.permittedVendors[0] ?? 'anthropic',
    model: policy.defaultModel,
    maxOutputTokens: intFrom(env['OREMEDIA_MODEL_MAX_OUTPUT_TOKENS'], 4096),
    timeoutMs: intFrom(env['OREMEDIA_MODEL_TIMEOUT_MS'], 120_000),
    inputMicrosPerMillionTokens: intFrom(
      env['OREMEDIA_MODEL_INPUT_MICROS_PER_MTOKEN'],
      DEFAULT_INPUT_MICROS_PER_MTOKEN,
    ),
    outputMicrosPerMillionTokens: intFrom(
      env['OREMEDIA_MODEL_OUTPUT_MICROS_PER_MTOKEN'],
      DEFAULT_OUTPUT_MICROS_PER_MTOKEN,
    ),
  };
}

/** Cost of one call in micro-units, rounded up so a run never under-reports (spec 12.6). */
export function estimateCostMicros(config: ModelConfig, usage: ModelUsage): number {
  return Math.ceil(
    (usage.inputTokens * config.inputMicrosPerMillionTokens +
      usage.outputTokens * config.outputMicrosPerMillionTokens) /
      1_000_000,
  );
}
