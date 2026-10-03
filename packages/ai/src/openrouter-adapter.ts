import { existsSync, readFileSync } from 'node:fs';
import { fetch as undiciFetch } from 'undici';
import type {
  ModelCompletion,
  ModelContent,
  ModelMessage,
  ModelRequest,
  ModelToolCall,
} from '@oremedia/contracts/agents';
import type { GenerationRestrictions } from '@oremedia/contracts/brand';
import { ProviderUnavailableError, ValidationFailedError } from '@oremedia/contracts/errors';
import { logger } from '@oremedia/observability';
import type { ModelAdapter } from './model-adapter';

export interface OpenRouterAdapterOptions {
  apiKey: string;
  baseURL?: string;
  /** Test seam: the fetch implementation (request shape and response mapping are unit-tested through it). */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** OpenAI-compatible chat message as OpenRouter accepts it. */
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: OpenRouterError;
}

/** OpenRouter's error object; `metadata` names the upstream provider and carries its raw answer. */
interface OpenRouterError {
  code?: number;
  message?: string;
  metadata?: { provider_name?: string; raw?: unknown };
}

/**
 * The default transport for every OpenRouter call (chat, image, speech, video): undici's own fetch, as the provider
 * I/O layer and the Google sign-in use. On Railway, Node's built-in global fetch answers with empty Headers (the
 * staging acceptance probe records it) and the staging model evaluation saw OpenRouter answer `401: Missing
 * Authentication header` to a request that carried one. Tests inject their own fetch.
 */
export const openRouterFetch: typeof fetch = (input, init) =>
  undiciFetch(input as never, init as never) as unknown as Promise<Response>;

/**
 * ADR-11: every model call goes through OpenRouter's OpenAI-compatible chat API with tool use. The model id is the
 * routing policy's, never a literal here; OpenRouter's automatic router is not used. Retries belong to Temporal (no
 * retry here); the request timeout is the caller's timeoutMs. Providers that collect prompts are excluded
 * (`data_collection: deny`). Prompts and content are never logged; reasoning output is not requested and any
 * returned reasoning field is dropped. Stop reasons are mapped to the Anthropic-style names the runtime records.
 */
export class OpenRouterModelAdapter implements ModelAdapter {
  readonly provider = 'openrouter';
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenRouterAdapterOptions) {
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? openRouterFetch;
  }

  async complete(req: ModelRequest): Promise<ModelCompletion> {
    const body = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      messages: [{ role: 'system', content: req.system } as ChatMessage, ...req.messages.flatMap(toChat)],
      // A call without tools (the evaluation grader, for one) sends neither field: OpenAI-compatible providers
      // reject an empty `tools` array, and OpenRouter reports that as an upstream 400.
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: 'auto',
          }
        : {}),
      provider: { data_collection: 'deny' },
      user: req.metadata.runId,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch {
      throw unavailable('connection failed or timed out');
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw unavailable(`status ${res.status}`, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
    }
    if (!res.ok) throw rejected(res.status, await errorDetail(res));
    const json = (await res.json()) as ChatResponse;
    // OpenRouter can report an upstream failure inside a 200 body.
    if (json.error) {
      const code = json.error.code ?? 500;
      throw code === 429 || code >= 500
        ? unavailable(`upstream ${code}`)
        : rejected(code, errorMessageOf(json.error));
    }
    return toCompletion(json);
  }
}

/** One OreMedia message becomes one chat message, except tool results, which OpenRouter takes as `tool` messages. */
function toChat(m: ModelMessage): ChatMessage[] {
  const text = m.content
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');
  if (m.role === 'assistant') {
    const toolCalls = m.content.flatMap((p) =>
      p.type === 'tool_use'
        ? [
            {
              id: p.id,
              type: 'function' as const,
              function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
            },
          ]
        : [],
    );
    return [
      { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    ];
  }
  const results: ChatMessage[] = m.content.flatMap((p) =>
    p.type === 'tool_result'
      ? [
          {
            role: 'tool' as const,
            tool_call_id: p.toolUseId,
            content: p.isError ? `ERROR: ${p.content}` : p.content,
          },
        ]
      : [],
  );
  return text ? [...results, { role: 'user', content: text }] : results;
}

const STOP_REASONS: Record<string, string> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

export function toCompletion(json: ChatResponse): ModelCompletion {
  const choice = json.choices?.[0];
  const content: ModelContent[] = choice?.message?.content
    ? [{ type: 'text', text: choice.message.content }]
    : [];
  const toolCalls: ModelToolCall[] = (choice?.message?.tool_calls ?? []).map((c) => ({
    id: c.id,
    name: c.function?.name ?? '',
    arguments: parseArguments(c.function?.arguments),
  }));
  const finish = choice?.finish_reason ?? 'stop';
  return {
    content,
    toolCalls,
    usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
    stopReason: STOP_REASONS[finish] ?? finish,
  };
}

/** Malformed arguments stay a string: the tool dispatcher's schema check then answers `invalid` to the model. */
function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function unavailable(detail: string, retryAfterMs?: number): ProviderUnavailableError {
  logger().warn({ errorMessage: `openrouter ${detail}` }, 'model provider unavailable');
  return new ProviderUnavailableError('openrouter', retryAfterMs);
}

/**
 * The provider's own error message, bounded and on one line, so the operator sees why (an unknown model id, an
 * invalid key, a malformed request) rather than only the status. It is the provider's text about the request,
 * never the prompt; the key never appears in it.
 */
export function rejectionDetail(message: string | undefined, status: number): string {
  const detail = (message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return detail ? `${status}: ${detail}` : String(status);
}

async function errorDetail(res: Response): Promise<string | undefined> {
  try {
    const json = (await res.json()) as ChatResponse;
    return json.error ? errorMessageOf(json.error) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OpenRouter's message, followed by the upstream provider's name and its own message when OpenRouter relays one
 * ("Provider returned error" alone names neither). The raw answer is parsed for its message when it is JSON; the
 * whole is bounded by rejectionDetail.
 */
export function errorMessageOf(error: OpenRouterError): string | undefined {
  const provider = error.metadata?.provider_name;
  const raw = upstreamMessage(error.metadata?.raw);
  const upstream = [provider, raw].filter(Boolean).join(': ');
  if (!upstream) return error.message;
  return error.message ? `${error.message} (${upstream})` : upstream;
}

function upstreamMessage(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  if (value && typeof value === 'object') {
    const v = value as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof v.error === 'string') return v.error;
    if (typeof v.error?.message === 'string') return v.error.message;
    if (typeof v.message === 'string') return v.message;
  }
  return typeof raw === 'string' ? raw : undefined;
}

function rejected(status: number, message?: string): ValidationFailedError {
  const detail = rejectionDetail(message, status);
  logger().warn({ errorMessage: `openrouter ${detail}` }, 'model provider rejected the request');
  return new ValidationFailedError(
    [{ path: 'model', issue: `provider rejected the request (${detail})` }],
    `The model provider rejected the request (${detail})`,
  );
}

/** OpenRouter's provider-routing object for one request (only / ignore / data_collection / zdr). */
export interface OpenRouterProviderPreferences {
  data_collection: 'deny';
  only?: string[];
  ignore?: string[];
  zdr?: true;
}

/**
 * ADR-11 (5): the provider object for a generation request made for a brand. Collection is always denied; the
 * brand's restrictions (its active policy, as the step's context snapshot resolved it) narrow which providers may
 * serve it.
 */
export function openRouterProviderPreferences(
  restrictions: GenerationRestrictions | null | undefined,
): OpenRouterProviderPreferences {
  const prefs: OpenRouterProviderPreferences = { data_collection: 'deny' };
  if (restrictions?.permittedProviders.length) prefs.only = [...restrictions.permittedProviders];
  if (restrictions?.deniedProviders.length) prefs.ignore = [...restrictions.deniedProviders];
  if (restrictions?.zeroRetention) prefs.zdr = true;
  return prefs;
}

/** OPENROUTER_API_KEY_REF (ADR-11): a mounted secret file path, or the key material itself. */
export function openRouterApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const ref = env['OPENROUTER_API_KEY_REF'];
  if (!ref) return null;
  const value = existsSync(ref) ? readFileSync(ref, 'utf8') : ref;
  const key = value.trim();
  return key.length ? key : null;
}

export function createOpenRouterAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterModelAdapter | null {
  const apiKey = openRouterApiKeyFromEnv(env);
  if (!apiKey) return null;
  const baseURL = env['OREMEDIA_OPENROUTER_BASE_URL'];
  return new OpenRouterModelAdapter(baseURL ? { apiKey, baseURL } : { apiKey });
}
