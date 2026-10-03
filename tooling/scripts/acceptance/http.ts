import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * A `fetch`-shaped client over node:http(s) for the acceptance job (docs/runbooks/staging-acceptance.md): a thin
 * wrapper that performs the request with Node's HTTP client and builds a standard `Response`, headers included
 * (every raw header pair is appended, so repeated Set-Cookie headers survive and `getSetCookie()` reads them).
 * The job switches to it when its startup probe finds that the global fetch sees no response headers on the
 * deployment while Node's HTTP client does. Redirects are never followed (the job passes `redirect: 'manual'`
 * everywhere it matters and reads the status itself); bodies are read whole. Only what the job needs of the fetch
 * API: method, headers, a string or byte body, the URL.
 */
export type FetchLike = typeof fetch;

const bodyBytes = (body: RequestInit['body']): Buffer | null => {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError('nodeHttpFetch supports string and byte bodies only');
};

const headersOf = (init: RequestInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!init?.headers) return out;
  new Headers(init.headers).forEach((value, name) => {
    out[name] = value;
  });
  return out;
};

/** Status codes that carry no body: `new Response` refuses a body for them. */
const NO_BODY = new Set([101, 204, 205, 304]);

export const nodeHttpFetch: FetchLike = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
  ).toUpperCase();
  const body = bodyBytes(init?.body);
  const headers = headersOf(init);
  if (body && !('content-length' in headers)) headers['content-length'] = String(body.length);
  const options: RequestOptions = {
    method,
    headers,
    // The job's requests are short; a hung origin is reported, not waited for.
    timeout: 60_000,
  };
  const res = await new Promise<{ message: IncomingMessage; chunks: Buffer[] }>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, (message) => {
      const chunks: Buffer[] = [];
      message.on('data', (chunk: Buffer) => chunks.push(chunk));
      message.on('end', () => resolve({ message, chunks }));
      message.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  const responseHeaders = new Headers();
  for (let i = 0; i + 1 < res.message.rawHeaders.length; i += 2)
    responseHeaders.append(res.message.rawHeaders[i] as string, res.message.rawHeaders[i + 1] as string);
  const status = res.message.statusCode ?? 0;
  const payload = Buffer.concat(res.chunks);
  return new Response(NO_BODY.has(status) || payload.length === 0 ? null : new Uint8Array(payload), {
    status,
    statusText: res.message.statusMessage ?? '',
    headers: responseHeaders,
  });
};
