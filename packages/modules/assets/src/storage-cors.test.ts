import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bucketCorsRules, ensureObjectStoreCors, objectStoreCorsOrigins } from './storage';

/**
 * Opt-in bucket CORS (OBJECT_STORE_CORS_ORIGINS), against a local HTTP server speaking the two S3 calls involved
 * (PutBucketCors and GetBucketCors, path-style), so the real SDK serialises and parses the XML.
 */
type Mode = 'echo' | 'drop';
let server: Server;
let endpoint = '';
let mode: Mode = 'echo';
const stored = new Map<string, string>();
const requests: Array<{ method: string; url: string }> = [];

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://store');
    requests.push({
      method: req.method ?? '',
      url: `${url.pathname}?${[...url.searchParams.keys()].join('&')}`,
    });
    const bucket = url.pathname.split('/')[1] ?? '';
    if (!url.searchParams.has('cors')) {
      res.writeHead(400).end();
      return;
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (mode === 'echo') stored.set(bucket, body);
      res.writeHead(200).end();
      return;
    }
    const body = stored.get(bucket);
    if (!body) {
      res
        .writeHead(404, { 'content-type': 'application/xml' })
        .end('<Error><Code>NoSuchCORSConfiguration</Code><Message>none</Message></Error>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  mode = 'echo';
  stored.clear();
  requests.length = 0;
});

const env = (extra: Record<string, string> = {}) => ({
  OBJECT_STORE_ENDPOINT: endpoint,
  OBJECT_STORE_REGION: 'auto',
  OBJECT_STORE_ACCESS_KEY_ID: 'test-id',
  OBJECT_STORE_SECRET_ACCESS_KEY: 'test-secret',
  OBJECT_STORE_BUCKET_ASSETS: 'media-assets',
  OBJECT_STORE_BUCKET_RELEASES: 'media-releases',
  ...extra,
});

describe('objectStoreCorsOrigins', () => {
  it('is null when unset or blank (production behaviour unchanged)', () => {
    expect(objectStoreCorsOrigins({})).toBeNull();
    expect(objectStoreCorsOrigins({ OBJECT_STORE_CORS_ORIGINS: '  ' })).toBeNull();
  });
  it('reads comma-separated bare origins, once each', () => {
    expect(
      objectStoreCorsOrigins({
        OBJECT_STORE_CORS_ORIGINS: 'https://app.example.com, https://app.example.com,http://localhost:5173',
      }),
    ).toEqual(['https://app.example.com', 'http://localhost:5173']);
  });
  it.each([
    'https://app.example.com/',
    'https://app.example.com/path',
    'app.example.com',
    'ftp://x.example',
    // Plain http only for a developer's own machine.
    'http://app.example.com',
    'http://10.0.0.5:8080',
    'http://localhost.app.example.com',
    'https://app.example.com,http://staging.example.com',
  ])('refuses %s', (value) => {
    expect(() => objectStoreCorsOrigins({ OBJECT_STORE_CORS_ORIGINS: value })).toThrow(
      /bare https origins .*\(http only for localhost and 127\.0\.0\.1\)/,
    );
  });
  it('accepts plain http for localhost and 127.0.0.1 only', () => {
    expect(
      objectStoreCorsOrigins({
        OBJECT_STORE_CORS_ORIGINS: 'http://localhost,http://127.0.0.1:5173,https://localhost:8443',
      }),
    ).toEqual(['http://localhost', 'http://127.0.0.1:5173', 'https://localhost:8443']);
  });
});

describe('ensureObjectStoreCors', () => {
  it('sends nothing to the store when the opt-in is unset', async () => {
    await expect(ensureObjectStoreCors(env())).resolves.toBeNull();
    expect(requests).toEqual([]);
  });

  it('puts the rules on both buckets, then reads each back', async () => {
    const origin = 'https://web.example.com';
    const applied = await ensureObjectStoreCors(env({ OBJECT_STORE_CORS_ORIGINS: origin }));
    expect(applied).toEqual({ buckets: ['media-assets', 'media-releases'], origins: [origin] });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'PUT /media-assets/?cors',
      'GET /media-assets/?cors',
      'PUT /media-releases/?cors',
      'GET /media-releases/?cors',
    ]);
    const xml = stored.get('media-assets') ?? '';
    for (const part of [
      `<AllowedOrigin>${origin}</AllowedOrigin>`,
      '<AllowedMethod>PUT</AllowedMethod>',
      '<AllowedMethod>GET</AllowedMethod>',
      '<AllowedMethod>HEAD</AllowedMethod>',
      '<AllowedHeader>content-type</AllowedHeader>',
      '<AllowedHeader>content-length</AllowedHeader>',
      '<ExposeHeader>ETag</ExposeHeader>',
    ])
      expect(xml).toContain(part);
    // Idempotent: a second start sends the same configuration and succeeds.
    await expect(ensureObjectStoreCors(env({ OBJECT_STORE_CORS_ORIGINS: origin }))).resolves.not.toBeNull();
    expect(stored.get('media-assets')).toBe(xml);
  });

  it('configures a bucket shared by assets and releases once', async () => {
    const applied = await ensureObjectStoreCors(
      env({
        OBJECT_STORE_BUCKET_RELEASES: 'media-assets',
        OBJECT_STORE_CORS_ORIGINS: 'https://web.example.com',
      }),
    );
    expect(applied?.buckets).toEqual(['media-assets']);
    expect(requests).toHaveLength(2);
  });

  it('refuses when the store accepts the PUT but does not report the rules', async () => {
    mode = 'drop';
    await expect(
      ensureObjectStoreCors(env({ OBJECT_STORE_CORS_ORIGINS: 'https://web.example.com' })),
    ).rejects.toThrow();
  });

  it('refuses when the store reports rules that do not admit the origin', async () => {
    mode = 'drop';
    const other = bucketCorsRules(['https://other.example.com'])[0];
    stored.set(
      'media-assets',
      `<CORSConfiguration><CORSRule><AllowedOrigin>${other?.AllowedOrigins?.[0]}</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>`,
    );
    await expect(
      ensureObjectStoreCors(env({ OBJECT_STORE_CORS_ORIGINS: 'https://web.example.com' })),
    ).rejects.toThrow(/PUT from https:\/\/web\.example\.com.*media-assets/);
  });

  it('refuses when the opt-in is set without an object store', async () => {
    await expect(
      ensureObjectStoreCors({ OBJECT_STORE_CORS_ORIGINS: 'https://web.example.com' }),
    ).rejects.toThrow(/object store is not configured/);
    expect(requests).toEqual([]);
  });
});
