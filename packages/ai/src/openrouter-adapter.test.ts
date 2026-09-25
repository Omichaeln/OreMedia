import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ModelRequest } from '@oremedia/contracts/agents';
import { createModelAdapterFromEnv } from './adapter-factory';
import { OpenRouterModelAdapter, toCompletion } from './openrouter-adapter';
import { routingPolicyFromEnv } from './routing-policy';

const request: ModelRequest = {
  model: 'vendor/model-x',
  system: 'SYSTEM PROMPT',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Begin.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking facts.' },
        { type: 'tool_use', id: 'call_a', name: 'facts.list', input: { kind: 'offer' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'call_a', content: '{"kind":"denied"}', isError: true }],
    },
  ],
  tools: [
    { name: 'facts.list', description: 'Lists facts', inputSchema: { type: 'object', properties: {} } },
  ],
  maxOutputTokens: 1234,
  temperature: 0.2,
  timeoutMs: 5000,
  metadata: { runId: 'run_1', tenantId: 'ten_A' },
};

const okBody = {
  id: 'gen_1',
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: 'Calling a tool.',
        reasoning: 'PRIVATE REASONING',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'facts.list', arguments: '{"kind":"offer"}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 321, completion_tokens: 45 },
};

function fakeFetch(status = 200, body: unknown = okBody, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(await req.text()) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

describe('OpenRouterModelAdapter (ADR-11, OpenAI-compatible tool use)', () => {
  it('sends the mapped conversation, tools, explicit model and no-data-collection routing', async () => {
    const f = fakeFetch();
    const adapter = new OpenRouterModelAdapter({
      apiKey: 'or-key',
      baseURL: 'https://or.invalid/api/v1/',
      fetch: f.fetch,
    });
    await adapter.complete(request);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://or.invalid/api/v1/chat/completions');
    expect(call.headers.get('authorization')).toBe('Bearer or-key');
    expect(call.body).toMatchObject({
      model: 'vendor/model-x',
      max_tokens: 1234,
      temperature: 0.2,
      tool_choice: 'auto',
      provider: { data_collection: 'deny' },
      user: 'run_1',
      tools: [
        {
          type: 'function',
          function: { name: 'facts.list', parameters: { type: 'object', properties: {} } },
        },
      ],
    });
    expect(call.body['messages']).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'Begin.' },
      {
        role: 'assistant',
        content: 'Checking facts.',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'facts.list', arguments: '{"kind":"offer"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'ERROR: {"kind":"denied"}' },
    ]);
  });

  it('maps text, tool calls, usage and the stop reason; drops reasoning', async () => {
    const out = await new OpenRouterModelAdapter({ apiKey: 'k', fetch: fakeFetch().fetch }).complete(request);
    expect(out).toEqual({
      content: [{ type: 'text', text: 'Calling a tool.' }],
      toolCalls: [{ id: 'call_1', name: 'facts.list', arguments: { kind: 'offer' } }],
      usage: { inputTokens: 321, outputTokens: 45 },
      stopReason: 'tool_use',
    });
    expect(JSON.stringify(out)).not.toContain('PRIVATE REASONING');
  });

  it('keeps malformed tool arguments as a string so the dispatcher answers invalid', () => {
    const out = toCompletion({
      choices: [
        {
          finish_reason: 'length',
          message: { tool_calls: [{ id: 'c', function: { name: 't', arguments: '{bad' } }] },
        },
      ],
    });
    expect(out.toolCalls[0]!.arguments).toBe('{bad');
    expect(out.stopReason).toBe('max_tokens');
  });

  it('treats 429 and 5xx (and an upstream error in a 200 body) as unavailable, other 4xx as rejected', async () => {
    const run = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
      new OpenRouterModelAdapter({ apiKey: 'k', fetch: fakeFetch(status, body, headers).fetch }).complete(
        request,
      );
    const limited = await run(429, {}, { 'retry-after': '7' }).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(ProviderUnavailableError);
    expect((limited as ProviderUnavailableError).retryAfterMs).toBe(7000);
    await expect(run(502)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(run(200, { error: { code: 503, message: 'upstream' } })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(run(400)).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(run(200, { error: { code: 400, message: 'bad' } })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('treats a connection failure or timeout as unavailable', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      new OpenRouterModelAdapter({ apiKey: 'k', fetch: failing }).complete(request),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('adapter selection and routing policy with OpenRouter (ADR-11)', () => {
  it('prefers OpenRouter over Anthropic when both keys are set', () => {
    const adapter = createModelAdapterFromEnv({ OPENROUTER_API_KEY_REF: 'or', ANTHROPIC_API_KEY_REF: 'an' });
    expect(adapter.provider).toBe('openrouter');
  });

  it('permits the openrouter vendor and requires an explicit model id', () => {
    expect(
      routingPolicyFromEnv({ OPENROUTER_API_KEY_REF: 'or', OREMEDIA_MODEL_ID: 'vendor/model-x' }),
    ).toMatchObject({
      defaultModel: 'vendor/model-x',
      permittedVendors: ['openrouter'],
    });
    expect(() => routingPolicyFromEnv({ OPENROUTER_API_KEY_REF: 'or' })).toThrow(
      /OREMEDIA_MODEL_ID is required/,
    );
  });
});
