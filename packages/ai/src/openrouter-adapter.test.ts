import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ModelRequest } from '@oremedia/contracts/agents';
import { createModelAdapterFromEnv, modelsCapability } from './adapter-factory';
import { OpenRouterModelAdapter, toCompletion } from './openrouter-adapter';
import { ModelRequestRejectedError } from './model-adapter';
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
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'facts__list', arguments: '{"kind":"offer"}' },
          },
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
          // Providers accept only [a-zA-Z0-9_-] in tool names: the dotted platform name goes out encoded.
          function: { name: 'facts__list', parameters: { type: 'object', properties: {} } },
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
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'facts__list', arguments: '{"kind":"offer"}' },
          },
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
    // The status and the provider's own message reach the operator (a failed evaluation records the message).
    const named = (await run(401, { error: { message: 'No auth credentials  found\n' } }).catch(
      (e: unknown) => e,
    )) as ValidationFailedError;
    expect(named.message).toBe('The model provider rejected the request (401: No auth credentials found)');
    expect(named.details).toEqual([
      { path: 'model', issue: 'provider rejected the request (401: No auth credentials found)' },
    ]);
    const bare = (await run(404, 'not json').catch((e: unknown) => e)) as ValidationFailedError;
    expect(bare.message).toBe('The model provider rejected the request (404)');
    const inBody = (await run(200, { error: { code: 400, message: 'x'.repeat(300) } }).catch(
      (e: unknown) => e,
    )) as ValidationFailedError;
    expect(inBody.message).toBe(`The model provider rejected the request (400: ${'x'.repeat(200)})`);
  });

  it('a refusal carries the provider status and any usage reported with it, so a caller can tell it apart', async () => {
    const run = (status: number, body: unknown = {}) =>
      new OpenRouterModelAdapter({ apiKey: 'k', fetch: fakeFetch(status, body).fetch })
        .complete(request)
        .catch((e: unknown) => e);
    const schema = (await run(400, {
      error: { code: 400, message: 'Invalid schema for response_format' },
    })) as ModelRequestRejectedError;
    expect(schema).toBeInstanceOf(ModelRequestRejectedError);
    expect(schema).toBeInstanceOf(ValidationFailedError);
    expect(schema.status).toBe(400);
    expect(schema.name).toBe('ValidationFailedError');
    expect(schema.code).toBe('VALIDATION_FAILED');
    expect(schema.usage).toBeNull();
    expect(((await run(401)) as ModelRequestRejectedError).status).toBe(401);
    const inBody = (await run(200, {
      error: { code: 422, message: 'unprocessable' },
      usage: { prompt_tokens: 900, completion_tokens: 3 },
    })) as ModelRequestRejectedError;
    expect(inBody.status).toBe(422);
    expect(inBody.usage).toEqual({ inputTokens: 900, outputTokens: 3 });
    const withUsage = (await run(400, {
      error: { code: 400, message: 'bad' },
      usage: { prompt_tokens: 10 },
    })) as ModelRequestRejectedError;
    expect(withUsage.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
  });

  it('sends the key in the Authorization header through its default transport (no injected fetch)', async () => {
    const seen: Array<{ authorization?: string; contentType?: string }> = [];
    const server = createServer((req, res) => {
      seen.push({ authorization: req.headers.authorization, contentType: req.headers['content-type'] });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(okBody));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const out = await new OpenRouterModelAdapter({
        apiKey: 'k-test',
        baseURL: `http://127.0.0.1:${port}`,
      }).complete(request);
      expect(seen).toEqual([{ authorization: 'Bearer k-test', contentType: 'application/json' }]);
      expect(out.stopReason).toBe('tool_use'); // the fixture answer carries a tool call
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends neither tools nor tool_choice on a call without tools (OpenAI-compatible providers reject an empty list)', async () => {
    const { fetch: f, calls } = fakeFetch();
    await new OpenRouterModelAdapter({ apiKey: 'k', fetch: f }).complete({ ...request, tools: [] });
    expect(calls[0]!.body).not.toHaveProperty('tools');
    expect(calls[0]!.body).not.toHaveProperty('tool_choice');
  });

  it('sends a strict json_schema response_format when the request names a response schema, and none otherwise', async () => {
    const schema = {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string' } } },
      required: ['items'],
      additionalProperties: false,
    };
    const { fetch: f, calls } = fakeFetch();
    const adapter = new OpenRouterModelAdapter({ apiKey: 'k', fetch: f });
    await adapter.complete({ ...request, tools: [], responseSchema: { name: 'answer_v1', schema } });
    expect(calls[0]!.body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'answer_v1', strict: true, schema },
    });
    // The rest of the request is unchanged (routing still denies collection).
    expect(calls[0]!.body).toMatchObject({ model: 'vendor/model-x', provider: { data_collection: 'deny' } });
    await adapter.complete({ ...request, tools: [] });
    expect(calls[1]!.body).not.toHaveProperty('response_format');
  });

  it("names the upstream provider and its own message when OpenRouter answers 'Provider returned error'", async () => {
    const run = (status: number, body: unknown) =>
      new OpenRouterModelAdapter({ apiKey: 'k', fetch: fakeFetch(status, body).fetch }).complete(request);
    const relayed = (await run(400, {
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: {
          provider_name: 'OpenAI',
          raw: JSON.stringify({ error: { message: "[] is too short - 'tools'" } }),
        },
      },
    }).catch((e: unknown) => e)) as ValidationFailedError;
    expect(relayed.message).toBe(
      "The model provider rejected the request (400: Provider returned error (OpenAI: [] is too short - 'tools'))",
    );
    const plainRaw = (await run(200, {
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: { provider_name: 'X', raw: 'bad input' },
      },
    }).catch((e: unknown) => e)) as ValidationFailedError;
    expect(plainRaw.message).toBe(
      'The model provider rejected the request (400: Provider returned error (X: bad input))',
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

describe('models capability (startup configuration report)', () => {
  it('follows the adapter selection: OpenRouter needs its model id, Anthropic stands alone', () => {
    expect(modelsCapability.capability).toBe('models');
    expect(
      modelsCapability.missing({ OPENROUTER_API_KEY_REF: 'k', OREMEDIA_MODEL_ID: 'vendor/model-x' }),
    ).toEqual([]);
    expect(modelsCapability.missing({ OPENROUTER_API_KEY_REF: 'k' })).toEqual(['OREMEDIA_MODEL_ID']);
    expect(modelsCapability.missing({ ANTHROPIC_API_KEY_REF: 'k' })).toEqual([]);
    expect(modelsCapability.missing({})).toEqual(['OPENROUTER_API_KEY_REF', 'OREMEDIA_MODEL_ID']);
  });

  it('reports a gap exactly where the readers refuse', () => {
    expect(() => routingPolicyFromEnv({ OPENROUTER_API_KEY_REF: 'k' })).toThrow();
    expect(() => createModelAdapterFromEnv({ NODE_ENV: 'production' })).toThrow();
  });
});
