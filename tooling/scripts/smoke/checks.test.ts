import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { formatResult, printable, randomPng, runSmoke, smokeConfigFromEnv, type SmokeConfig } from './checks';

/**
 * The smoke check's logic against a local fake deployment: a web origin (health, CSP, legal pages, brand pack,
 * password sign-in and the tRPC upload procedures) and an object store on another port. No real network.
 */
const PASSWORD = 'fake smoke password, must not print';
const TOKEN = 'ses fake token, must not print';
const SIGNATURE = 'SIGNATURE_MUST_NOT_PRINT';

interface FakeOptions {
  degraded?: string[];
  storeInCsp?: boolean;
  legal?: boolean;
  brand?: unknown;
  storeCors?: boolean;
  ingest?: Array<{ state: string; assetId?: string; rejectionReason?: string }>;
  retireDenied?: boolean;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const listen = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const bodyOf = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

async function fakeDeployment(o: FakeOptions = {}) {
  const seen = { puts: 0, signedOut: false, requests: [] as string[], retired: [] as string[] };
  const ingest = [...(o.ingest ?? [{ state: 'quarantined' }, { state: 'accepted', assetId: 'ast_smoke' }])];
  let web = '';
  const store = await listen(async (req, res) => {
    if (o.storeCors !== false && req.headers.origin === web) {
      res.setHeader('access-control-allow-origin', web);
      res.setHeader('access-control-allow-methods', 'GET, PUT');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.method === 'PUT') {
      await bodyOf(req);
      seen.puts++;
      return res.writeHead(200).end();
    }
    res.writeHead(404).end();
  });
  web = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.requests.push(`${req.method} ${url.pathname}`);
    const json = (status: number, v: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    const authed =
      req.headers.authorization === `Bearer ${TOKEN}` && req.headers['x-oremedia-tenant'] === 'ten_smoke';
    if (url.pathname === '/health') return json(200, { ok: true, degraded: o.degraded ?? [] });
    if (url.pathname === '/')
      return res
        .writeHead(200, {
          'content-type': 'text/html',
          'content-security-policy': `default-src 'self'; font-src 'self' https://fonts.gstatic.com ${o.storeInCsp === false ? '' : store}; connect-src 'self' ${o.storeInCsp === false ? '' : store}`,
        })
        .end('<!doctype html>');
    if (url.pathname.startsWith('/legal/'))
      return o.legal === false
        ? res.writeHead(404).end()
        : res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>Legal</h1>');
    if (url.pathname === '/deployment-brand/brand.json') return json(200, o.brand ?? { name: 'Ore & Tar' });
    if (url.pathname === '/auth/password/sign-in') {
      const b = JSON.parse(await bodyOf(req)) as { email: string; password: string };
      if (req.headers.origin !== web || b.password !== PASSWORD)
        return json(401, { ok: false, error: 'invalid_credentials' });
      res.setHeader('set-cookie', [
        `__Host-oremedia_session=${TOKEN}; Path=/; HttpOnly; Secure`,
        '__Host-oremedia_csrf=c; Path=/',
      ]);
      return json(200, { ok: true });
    }
    if (url.pathname === '/auth/sign-out') {
      seen.signedOut = req.headers.authorization === `Bearer ${TOKEN}`;
      return res.writeHead(204).end();
    }
    if (!authed)
      return json(401, {
        error: { json: { message: 'Not signed in', data: { envelope: { code: 'UNAUTHENTICATED' } } } },
      });
    if (url.pathname === '/trpc/assets.uploads.createIntent') {
      if (!req.headers['idempotency-key']) return json(400, {});
      const input = (JSON.parse(await bodyOf(req)) as { json: { brandId: string } }).json;
      if (input.brandId !== 'brd_smoke')
        return json(404, {
          error: { json: { message: 'Brand not found', data: { envelope: { code: 'NOT_FOUND' } } } },
        });
      return json(200, {
        result: {
          data: {
            json: {
              intentId: 'upi_smoke',
              uploadUrl: `${store}/quarantine/ten_smoke/upi_smoke?X-Amz-Signature=${SIGNATURE}`,
            },
          },
        },
      });
    }
    if (url.pathname === '/trpc/assets.uploads.complete')
      return json(200, { result: { data: { json: { intentId: 'upi_smoke', state: 'uploaded' } } } });
    if (url.pathname === '/trpc/assets.get')
      return json(200, { result: { data: { json: { id: 'ast_smoke', state: 'approved', version: 3 } } } });
    if (url.pathname === '/trpc/assets.retire') {
      const input = (JSON.parse(await bodyOf(req)) as { json: { assetId: string; expectedVersion: number } })
        .json;
      if (o.retireDenied)
        return json(403, {
          error: { json: { message: 'Not allowed', data: { envelope: { code: 'POLICY_DENIED' } } } },
        });
      seen.retired.push(`${input.assetId}@${input.expectedVersion}`);
      return json(200, { result: { data: { json: { assetId: input.assetId, state: 'retired' } } } });
    }
    if (url.pathname === '/trpc/assets.uploads.get') {
      const next = ingest.length > 1 ? (ingest.shift() as (typeof ingest)[number]) : ingest[0];
      return json(200, {
        result: { data: { json: { intentId: 'upi_smoke', assetId: null, rejectionReason: null, ...next } } },
      });
    }
    res.writeHead(404).end();
  });
  const config: SmokeConfig = {
    baseUrl: web,
    upload: { email: 'smoke@example.test', password: PASSWORD, tenantId: 'ten_smoke', brandId: 'brd_smoke' },
    ingestTimeoutMs: 200,
    pollIntervalMs: 1,
  };
  return { web, store, seen, config };
}

const outcomes = (rs: Array<{ name: string; outcome: string }>) =>
  Object.fromEntries(rs.map((r) => [r.name, r.outcome]));
const noSecrets = (text: string) => {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(SIGNATURE);
};

describe('production smoke check', () => {
  it('a healthy deployment passes every check, and the upload round trip reaches an accepted asset', async () => {
    const d = await fakeDeployment();
    const results = await runSmoke(d.config);
    expect(outcomes(results)).toEqual({
      health: 'pass',
      csp: 'pass',
      'legal:privacy': 'pass',
      'legal:data-deletion': 'pass',
      'brand.json': 'pass',
      'upload:sign-in': 'pass',
      'upload:intent': 'pass',
      'upload:csp': 'pass',
      'upload:cors': 'pass',
      'upload:put': 'pass',
      'upload:complete': 'pass',
      'upload:ingest': 'pass',
      'upload:cleanup': 'pass',
    });
    expect(results.find((r) => r.name === 'upload:ingest')?.detail).toBe('accepted as ast_smoke');
    // The accepted asset is retired at the version assets.get reported.
    expect(d.seen.retired).toEqual(['ast_smoke@3']);
    expect(d.seen.puts).toBe(1);
    expect(d.seen.signedOut).toBe(true);
    noSecrets(results.map(formatResult).join('\n'));
  });

  it('names degraded capabilities, a CSP without the store, missing legal pages and a bad brand pack', async () => {
    const d = await fakeDeployment({
      degraded: ['uploads', 'channel:x'],
      storeInCsp: false,
      legal: false,
      brand: { name: '' },
    });
    const results = await runSmoke({ baseUrl: d.web });
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(by['health']).toMatchObject({
      outcome: 'fail',
      detail: 'degraded capabilities: uploads, channel:x',
    });
    expect(by['csp']).toMatchObject({ outcome: 'fail' });
    expect(by['csp']?.detail).toContain('OBJECT_STORE_PUBLIC_ORIGIN');
    expect(by['legal:privacy']?.outcome).toBe('fail');
    expect(by['legal:data-deletion']?.outcome).toBe('fail');
    expect(by['brand.json']).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('name') });
    expect(by['upload']?.outcome).toBe('skip');
  });

  it('SMOKE_EXPECT_STORE_ORIGIN pins the origin connect-src and font-src must admit', async () => {
    const d = await fakeDeployment();
    const [, csp] = await runSmoke({
      baseUrl: d.web,
      expectStoreOrigin: 'https://other.r2.cloudflarestorage.com',
    });
    expect(csp).toMatchObject({ name: 'csp', outcome: 'fail' });
    expect(csp?.detail).toContain('connect-src and font-src lack https://other.r2.cloudflarestorage.com');
    const [, ok] = await runSmoke({ baseUrl: d.web, expectStoreOrigin: d.store });
    expect(ok).toMatchObject({ name: 'csp', outcome: 'pass' });
  });

  it('a store without CORS for the web origin stops at the preflight, before any PUT, and still signs out', async () => {
    const d = await fakeDeployment({ storeCors: false });
    const results = await runSmoke(d.config);
    const last = results.at(-1);
    expect(last).toMatchObject({ name: 'upload:cors', outcome: 'fail' });
    expect(last?.detail).toContain(`the bucket CORS must admit PUT from ${d.web}`);
    expect(d.seen.puts).toBe(0);
    expect(d.seen.signedOut).toBe(true);
    noSecrets(results.map(formatResult).join('\n'));
  });

  it('a CSP that does not admit the signed URL origin stops the upload there', async () => {
    const d = await fakeDeployment({ storeInCsp: false });
    const results = await runSmoke(d.config);
    expect(results.at(-1)).toMatchObject({ name: 'upload:csp', outcome: 'fail' });
    expect(d.seen.puts).toBe(0);
  });

  it('reports a rejection with its reason, and a stuck ingest with the state it stopped in', async () => {
    const rejected = await fakeDeployment({
      ingest: [{ state: 'rejected', rejectionReason: 'mime_mismatch' }],
    });
    expect((await runSmoke(rejected.config)).at(-1)).toMatchObject({
      name: 'upload:ingest',
      outcome: 'fail',
      detail: 'rejected: mime_mismatch',
    });
    const stuck = await fakeDeployment({ ingest: [{ state: 'quarantined' }] });
    const last = (await runSmoke(stuck.config)).at(-1);
    expect(last).toMatchObject({ name: 'upload:ingest', outcome: 'fail' });
    expect(last?.detail).toMatch(/^still quarantined after/);
  });

  it('a refused cleanup fails the run, naming the step and the refusal', async () => {
    const d = await fakeDeployment({ retireDenied: true });
    const results = await runSmoke(d.config);
    expect(results.at(-1)).toMatchObject({
      name: 'upload:cleanup',
      outcome: 'fail',
      detail: 'assets.retire HTTP 403 POLICY_DENIED: Not allowed',
    });
    expect(d.seen.signedOut).toBe(true);
  });

  it('a refused sign-in or intent says where it stopped, without the password', async () => {
    const d = await fakeDeployment();
    const wrong = await runSmoke({
      ...d.config,
      upload: { ...(d.config.upload as NonNullable<SmokeConfig['upload']>), password: 'nope' },
    });
    expect(wrong.at(-1)).toMatchObject({
      name: 'upload:sign-in',
      outcome: 'fail',
      detail: 'HTTP 401 invalid_credentials',
    });
    const brand = await runSmoke({
      ...d.config,
      upload: { ...(d.config.upload as NonNullable<SmokeConfig['upload']>), brandId: 'brd_other' },
    });
    expect(brand.at(-1)).toMatchObject({
      name: 'upload:intent',
      outcome: 'fail',
      detail: 'HTTP 404 NOT_FOUND: Brand not found',
    });
    noSecrets([...wrong, ...brand].map(formatResult).join('\n'));
  });
});

describe('smoke helpers', () => {
  it('reads its configuration from the environment; the upload needs all four settings', () => {
    expect(() => smokeConfigFromEnv({})).toThrow(/SMOKE_BASE_URL is required/);
    expect(smokeConfigFromEnv({ SMOKE_BASE_URL: 'https://app.example.com/path' })).toEqual({
      baseUrl: 'https://app.example.com',
    });
    const full = smokeConfigFromEnv({
      SMOKE_BASE_URL: 'https://app.example.com',
      SMOKE_EXPECT_STORE_ORIGIN: 'https://acct.r2.cloudflarestorage.com/',
      SMOKE_EMAIL: 'smoke@example.test',
      SMOKE_PASSWORD: 'p',
      SMOKE_TENANT_ID: 'ten_1',
      SMOKE_BRAND_ID: 'brd_1',
    });
    expect(full.expectStoreOrigin).toBe('https://acct.r2.cloudflarestorage.com');
    expect(full.upload).toEqual({
      email: 'smoke@example.test',
      password: 'p',
      tenantId: 'ten_1',
      brandId: 'brd_1',
    });
    expect(
      smokeConfigFromEnv({ SMOKE_BASE_URL: 'https://a.example', SMOKE_EMAIL: 'x' }).upload,
    ).toBeUndefined();
  });

  it('prints URLs without their query, and makes a distinct valid PNG each time', () => {
    expect(printable(`https://s.example/k/1?X-Amz-Signature=${SIGNATURE}`)).toBe('https://s.example/k/1');
    const a = randomPng();
    expect(a.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const distinct = new Set(Array.from({ length: 5 }, () => randomPng().toString('hex')));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
