import { existsSync, readFileSync } from 'node:fs';
import type {
  ModelCompletion,
  ModelContent,
  ModelMessage,
  ModelRequest,
  ModelToolCall,
} from '@oremedia/contracts/agents';
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
  error?: { code?: number; message?: string };
}

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
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async complete(req: ModelRequest): Promise<ModelCompletion> {
    const body = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      messages: [{ role: 'system', content: req.system } as ChatMessage, ...req.messages.flatMap(toChat)],
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      tool_choice: req.tools.length ? 'auto' : 'none',
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
    if (!res.ok) throw rejected(res.status);
    const json = (await res.json()) as ChatResponse;
    // OpenRouter can report an upstream failure inside a 200 body.
    if (json.error) {
      const code = json.error.code ?? 500;
      throw code === 429 || code >= 500 ? unavailable(`upstream ${code}`) : rejected(code);
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

function rejected(status: number): ValidationFailedError {
  return new ValidationFailedError(
    [{ path: 'model', issue: `provider rejected the request (${status})` }],
    'The model provider rejected the request',
  );
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
