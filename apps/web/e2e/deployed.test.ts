import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTRPCClient, httpLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '@oremedia/api';
import { outOfBandFetch } from './deployed';

/**
 * The studio suite's out-of-band tRPC client against a deployed origin (OREMEDIA_E2E_WEB_ORIGIN): a local origin that
 * gzips its answer whenever the request accepts it (as the Railway edge does), and a global fetch that, like the
 * staging acceptance image's, hands back the encoded bytes without decoding them. Deployed, the client must not use
 * that fetch; locally it keeps the global fetch.
 */
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function edge(): Promise<{ origin: string; seen: Array<{ path: string; auth: string | undefined }> }> {
  const seen: Array<{ path: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', auth: req.headers.authorization });
    const body = JSON.stringify({
      result: { data: { json: { revision: { id: 'crev_2', number: 2, kind: 'graphic' } } } },
    });
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')))
      return res
        .writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
        .end(gzipSync(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** The image's global fetch as the acceptance probe saw it: no response headers, the body as the wire carried it. */
const imageFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const res = await new Promise<Buffer>((resolve, reject) => {
    request(url, { headers: { 'accept-encoding': 'gzip, deflate' } }, (m) => {
      const chunks: Buffer[] = [];
      m.on('data', (c: Buffer) => chunks.push(c));
      m.on('end', () => resolve(Buffer.concat(chunks)));
    })
      .on('error', reject)
      .end();
  });
  return new Response(new Uint8Array(res), { status: 200 });
});

const clientOn = (origin: string) =>
  createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${origin}/trpc`,
        transformer: superjson,
        fetch: outOfBandFetch(),
        headers: () => ({ authorization: 'Bearer ses_test', 'x-oremedia-tenant': 'ten_a' }),
      }),
    ],
  });

describe('outOfBandFetch', () => {
  it('against a deployed origin, reads a gzip-encoding edge through Node’s HTTP client, not the image’s fetch', async () => {
    const e = await edge();
    vi.stubEnv('OREMEDIA_E2E_WEB_ORIGIN', e.origin);
    vi.stubGlobal('fetch', imageFetch);
    const doc = await clientOn(e.origin).creative.documents.get.query({ documentId: 'cdoc_1' });
    expect(doc.revision.number).toBe(2);
    expect(imageFetch).not.toHaveBeenCalled();
    expect(e.seen).toEqual([
      { path: expect.stringContaining('/trpc/creative.documents.get?input='), auth: 'Bearer ses_test' },
    ]);
  });

  it('the image’s fetch is what fails there (the defect this transport avoids)', async () => {
    const e = await edge();
    const res = await imageFetch(`${e.origin}/trpc/creative.documents.get`);
    await expect(res.json()).rejects.toThrow(/not valid JSON/);
  });

  it('a local run (no deployed origin) keeps the global fetch', async () => {
    const e = await edge();
    vi.stubEnv('OREMEDIA_E2E_WEB_ORIGIN', '');
    const real = globalThis.fetch;
    const local = vi.fn((input: RequestInfo | URL, init?: RequestInit) => real(input, init));
    vi.stubGlobal('fetch', local);
    const doc = await clientOn(e.origin).creative.documents.get.query({ documentId: 'cdoc_1' });
    expect(doc.revision.number).toBe(2);
    expect(local).toHaveBeenCalledTimes(1);
  });
});
