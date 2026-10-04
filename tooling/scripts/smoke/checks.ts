import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { describeResponse } from '../acceptance/report';

/**
 * Production smoke checks (docs/runbooks/deploy-railway.md, "Production smoke check"): what a deployed Oremedia must
 * answer from outside, through the web origin as a browser reaches it. Each check reports pass, fail or skip with a
 * one-line detail that never carries a secret: no password, no session token, no signed URL query string.
 */
export type Outcome = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  name: string;
  outcome: Outcome;
  detail: string;
}

export interface SmokeConfig {
  /** The deployed web origin, e.g. https://oremedia.example.com (SMOKE_BASE_URL). */
  baseUrl: string;
  /** The object store origin the CSP must admit (SMOKE_EXPECT_STORE_ORIGIN); unset, any non-'self' origin is accepted. */
  expectStoreOrigin?: string;
  /** The smoke user's password sign-in and the tenant and brand it uploads into; all four or the upload is skipped. */
  upload?: { email: string; password: string; tenantId: string; brandId: string };
  /** How long to wait for ingest to accept or reject the upload (SMOKE_INGEST_TIMEOUT_MS, default 120 s). */
  ingestTimeoutMs?: number;
  pollIntervalMs?: number;
}

type Fetch = typeof fetch;

/** Reads the configuration from the environment; throws naming what is missing (names only). */
export function smokeConfigFromEnv(env: Record<string, string | undefined>): SmokeConfig {
  const base = env['SMOKE_BASE_URL']?.trim();
  if (!base) throw new Error('SMOKE_BASE_URL is required (the deployed web origin, https://...)');
  const baseUrl = new URL(base).origin;
  const upload = {
    email: env['SMOKE_EMAIL']?.trim() ?? '',
    password: env['SMOKE_PASSWORD'] ?? '',
    tenantId: env['SMOKE_TENANT_ID']?.trim() ?? '',
    brandId: env['SMOKE_BRAND_ID']?.trim() ?? '',
  };
  const store = env['SMOKE_EXPECT_STORE_ORIGIN']?.trim();
  const timeout = Number(env['SMOKE_INGEST_TIMEOUT_MS'] ?? '');
  return {
    baseUrl,
    ...(store ? { expectStoreOrigin: new URL(store).origin } : {}),
    ...(Object.values(upload).every(Boolean) ? { upload } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { ingestTimeoutMs: timeout } : {}),
  };
}

/**
 * The CSP's directives as a map (`connect-src` → its sources). The one parser: the web e2e (apps/web/e2e) uses it for
 * the headers it serves, the smoke check for the headers production serves.
 */
export function cspDirectives(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name.toLowerCase()] = sources;
  }
  return out;
}

/** A URL as it may be printed: origin and path, never the query (a signed URL's signature lives there). */
/** What a CORS preflight answered (the four response headers the Fetch standard's CORS-preflight check reads). */
export interface PreflightAnswer {
  allowOrigin: string | null;
  allowMethods: string | null;
  allowHeaders: string | null;
  allowCredentials: string | null;
}

/** Methods and request headers a browser never asks a preflight about (Fetch standard: CORS-safelisted). */
const SAFELISTED_METHODS = new Set(['GET', 'HEAD', 'POST']);
const csvTokens = (value: string | null): string[] =>
  (value ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * Why a browser would refuse the request after this preflight, or null when it would send it: the Fetch standard's
 * CORS check and CORS-preflight fetch. Without credentials (a presigned PUT carries none: the signature is in the
 * URL), `*` is a wildcard in Access-Control-Allow-Origin, -Methods and -Headers; with credentials the origin must be
 * echoed exactly with Access-Control-Allow-Credentials: true, and `*` is a literal name only. Methods are matched
 * case-sensitively (as the browser does, after normalising the request's own method), header names
 * case-insensitively. A missing Access-Control-Allow-Methods admits only the safelisted methods.
 */
export function corsPreflightRefusal(
  answer: PreflightAnswer,
  request: { origin: string; method: string; headers: string[]; credentials: boolean },
): string | null {
  const origin = answer.allowOrigin?.trim() ?? null;
  if (origin === null) return 'no access-control-allow-origin';
  if (origin === '*') {
    if (request.credentials) return 'access-control-allow-origin * does not admit a credentialed request';
  } else if (origin !== request.origin)
    return `access-control-allow-origin ${origin} is not ${request.origin}`;
  if (request.credentials && answer.allowCredentials?.trim() !== 'true')
    return 'a credentialed request needs access-control-allow-credentials: true';
  const methods = csvTokens(answer.allowMethods);
  const method = request.method.toUpperCase();
  const methodAdmitted =
    SAFELISTED_METHODS.has(method) ||
    methods.includes(method) ||
    (!request.credentials && methods.includes('*'));
  if (!methodAdmitted)
    return `access-control-allow-methods ${answer.allowMethods?.trim() || '(none)'} does not admit ${method}`;
  const allowed = csvTokens(answer.allowHeaders).map((h) => h.toLowerCase());
  const missing = request.headers
    .map((h) => h.toLowerCase())
    .filter((h) => !allowed.includes(h) && (request.credentials || !allowed.includes('*')));
  if (missing.length)
    return `access-control-allow-headers ${answer.allowHeaders?.trim() || '(none)'} does not admit ${missing.join(', ')}`;
  return null;
}

export const printable = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(not a URL)';
  }
};

/** A small valid PNG with a random colour, so no two runs upload identical bytes (ingest refuses duplicates). */
export function randomPng(size = 8): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolour
  const [r, g, b] = [0, 1, 2].map(() => Math.floor(Math.random() * 256)) as [number, number, number];
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pass = (name: string, detail: string): CheckResult => ({ name, outcome: 'pass', detail });
const fail = (name: string, detail: string): CheckResult => ({ name, outcome: 'fail', detail });
const skip = (name: string, detail: string): CheckResult => ({ name, outcome: 'skip', detail });

async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** A failure's view of the response: status, content type, header names, body length (never a header's value). */
const seen = async (res: Response): Promise<string> =>
  describeResponse(res, (await res.text().catch(() => '')).length);

/** GET /health through the web origin (Caddy proxies it to the api): 200, ok, and no degraded capability. */
export async function checkHealth(cfg: SmokeConfig, f: Fetch = fetch): Promise<CheckResult> {
  const res = await f(`${cfg.baseUrl}/health`);
  const text = await res.text().catch(() => '');
  type Health = { ok?: unknown; degraded?: unknown };
  let body: Health | null = null;
  try {
    body = JSON.parse(text) as Health;
  } catch {
    body = null;
  }
  if (res.status !== 200 || !body || body.ok !== true)
    return fail('health', `ok=${String(body?.ok)} (${describeResponse(res, text.length)})`);
  if (!Array.isArray(body.degraded))
    return fail('health', 'no degraded list: the api predates the configuration report');
  if (body.degraded.length)
    return fail('health', `degraded capabilities: ${body.degraded.map(String).join(', ')}`);
  return pass('health', 'HTTP 200, no degraded capability');
}

/**
 * The web page's CSP admits the object store in connect-src (browser upload PUTs) and font-src (brand fonts): the
 * expected origin exactly when SMOKE_EXPECT_STORE_ORIGIN is given, otherwise the same origin beyond 'self' in both.
 */
export async function checkCsp(cfg: SmokeConfig, f: Fetch = fetch): Promise<CheckResult> {
  const res = await f(`${cfg.baseUrl}/`);
  const policy = res.headers.get('content-security-policy');
  if (res.status !== 200 || !policy)
    return fail('csp', `CSP ${policy ? 'present' : 'missing'} (${await seen(res)})`);
  const csp = cspDirectives(policy);
  const extra = (d: string) =>
    (csp[d] ?? []).filter((s) => s.startsWith('https://') || s.startsWith('http://'));
  const connect = extra('connect-src');
  const font = extra('font-src');
  if (cfg.expectStoreOrigin) {
    const missing = ['connect-src', 'font-src'].filter(
      (d) => !(csp[d] ?? []).includes(cfg.expectStoreOrigin as string),
    );
    return missing.length
      ? fail(
          'csp',
          `${missing.join(' and ')} lack ${cfg.expectStoreOrigin} (OBJECT_STORE_PUBLIC_ORIGIN on the web service)`,
        )
      : pass('csp', `connect-src and font-src admit ${cfg.expectStoreOrigin}`);
  }
  const shared = connect.filter((o) => font.includes(o));
  return shared.length
    ? pass(
        'csp',
        `connect-src and font-src admit ${shared.join(', ')} (set SMOKE_EXPECT_STORE_ORIGIN to pin it)`,
      )
    : fail(
        'csp',
        'connect-src admits no object store origin: browser uploads are blocked (OBJECT_STORE_PUBLIC_ORIGIN)',
      );
}

/** The deployment's public legal pages answer 200 as HTML (the platform apps link to them). */
export async function checkLegal(cfg: SmokeConfig, page: string, f: Fetch = fetch): Promise<CheckResult> {
  const name = `legal:${page}`;
  const res = await f(`${cfg.baseUrl}/legal/${page}`);
  const type = res.headers.get('content-type') ?? '';
  return res.status === 200 && type.includes('text/html')
    ? pass(name, 'HTTP 200 text/html')
    : fail(name, `${type || 'no content type'} (${await seen(res)})`);
}

/** /deployment-brand/brand.json is a pack the web app accepts (apps/web/src/lib/deployment-brand.tsx rules). */
export async function checkBrandJson(cfg: SmokeConfig, f: Fetch = fetch): Promise<CheckResult> {
  const res = await f(`${cfg.baseUrl}/deployment-brand/brand.json`);
  if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('json'))
    return fail('brand.json', `not JSON (${await seen(res)})`);
  const v = (await jsonOf(res)) as {
    name?: unknown;
    fonts?: unknown;
    logo?: { light?: unknown; dark?: unknown };
  };
  const problems: string[] = [];
  if (typeof v?.name !== 'string' || !v.name.trim() || v.name.length > 80) problems.push('name');
  if (
    v?.fonts !== undefined &&
    !(typeof v.fonts === 'string' && /^https:\/\/fonts\.googleapis\.com\/css2\?[^"'<>\s]+$/.test(v.fonts))
  )
    problems.push('fonts');
  const svg = (x: unknown) => typeof x === 'string' && /^[a-z0-9-]+\.svg$/.test(x);
  if (v?.logo !== undefined && !(svg(v.logo?.light) && svg(v.logo?.dark))) problems.push('logo');
  return problems.length
    ? fail('brand.json', `invalid ${problems.join(', ')}: the app falls back to the neutral brand`)
    : pass('brand.json', `valid pack "${String(v.name)}"`);
}

interface TrpcFailure {
  error?: { json?: { message?: string; data?: { envelope?: { code?: string; message?: string } } } };
}
const trpcError = (body: unknown, status: number): string => {
  const env = (body as TrpcFailure | null)?.error?.json;
  const code = env?.data?.envelope?.code;
  return `HTTP ${status}${code ? ` ${code}` : ''}${env?.message ? `: ${env.message}` : ''}`;
};

/**
 * The upload round trip a browser makes, step by step, stopping at the first failure with where it stopped: sign in
 * (the smoke user's password), create an upload intent, the CSP admits the signed URL's origin, the store answers the
 * CORS preflight for the web origin (bucket CORS), PUT a tiny PNG, complete, then poll the intent until ingest
 * accepts it (or rejects it, with the reason), and retires the accepted asset. Always signs out. Asset upload is a person's action (an API key's
 * service principal may only propose uploads), hence a user, not an API key.
 */
export async function checkUpload(
  cfg: SmokeConfig,
  f: Fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<CheckResult[]> {
  if (!cfg.upload)
    return [skip('upload', 'SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_TENANT_ID and SMOKE_BRAND_ID not all set')];
  const { email, password, tenantId, brandId } = cfg.upload;
  const origin = cfg.baseUrl;
  const out: CheckResult[] = [];

  const signIn = await f(`${origin}/auth/password/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => /^(?:__Host-)?oremedia_session=([^;]+)/.exec(c)?.[1])
    .find(Boolean);
  if (signIn.status !== 200 || !cookie) {
    const body = (await jsonOf(signIn)) as { error?: string } | null;
    return [fail('upload:sign-in', `HTTP ${signIn.status}${body?.error ? ` ${body.error}` : ''}`)];
  }
  out.push(pass('upload:sign-in', 'session issued'));
  const auth = { authorization: `Bearer ${decodeURIComponent(cookie)}`, 'x-oremedia-tenant': tenantId };
  const mutate = (path: string, input: unknown) =>
    f(`${origin}/trpc/${path}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ json: input }),
    });
  const query = (path: string, input: unknown) =>
    f(`${origin}/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`, {
      headers: auth,
    });
  const data = (body: unknown) =>
    (body as { result?: { data?: { json?: unknown } } } | null)?.result?.data?.json;

  /** Cleanup: the accepted smoke asset is retired (assets.retire at its current version), so the brand stays empty. */
  const retire = async (assetId: string): Promise<CheckResult> => {
    const got = await query('assets.get', { assetId });
    const gotBody = await jsonOf(got);
    const version = (data(gotBody) as { version?: number } | undefined)?.version;
    if (got.status !== 200 || typeof version !== 'number')
      return fail('upload:cleanup', `assets.get ${trpcError(gotBody, got.status)}`);
    const retired = await mutate('assets.retire', {
      assetId,
      expectedVersion: version,
      reason: 'smoke check',
    });
    return retired.status === 200
      ? pass('upload:cleanup', `${assetId} retired`)
      : fail('upload:cleanup', `assets.retire ${trpcError(await jsonOf(retired), retired.status)}`);
  };

  try {
    const png = randomPng();
    const created = await mutate('assets.uploads.createIntent', {
      brandId,
      kind: 'photo',
      declaredMime: 'image/png',
      declaredBytes: png.length,
      originalFilename: 'oremedia-smoke.png',
    });
    const createdBody = await jsonOf(created);
    const intent = data(createdBody) as { intentId?: string; uploadUrl?: string } | undefined;
    if (created.status !== 200 || !intent?.intentId || !intent.uploadUrl) {
      out.push(fail('upload:intent', trpcError(createdBody, created.status)));
      return out;
    }
    const { intentId, uploadUrl } = intent;
    const storeOrigin = new URL(uploadUrl, origin).origin;
    out.push(pass('upload:intent', `${intentId} → ${printable(new URL(uploadUrl, origin).href)}`));

    const page = await f(`${origin}/`);
    const connect = cspDirectives(page.headers.get('content-security-policy') ?? '')['connect-src'] ?? [];
    const admitted = storeOrigin === origin ? connect.includes("'self'") : connect.includes(storeOrigin);
    if (!admitted) {
      out.push(
        fail('upload:csp', `connect-src does not admit ${storeOrigin}: the browser would block the PUT`),
      );
      return out;
    }
    out.push(pass('upload:csp', `connect-src admits ${storeOrigin}`));

    const preflight = await f(uploadUrl, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });
    // The browser's PUT (apps/web use-upload.ts) is a credential-less fetch with a non-safelisted content type.
    const refusal =
      preflight.status >= 300
        ? `HTTP ${preflight.status}`
        : corsPreflightRefusal(
            {
              allowOrigin: preflight.headers.get('access-control-allow-origin'),
              allowMethods: preflight.headers.get('access-control-allow-methods'),
              allowHeaders: preflight.headers.get('access-control-allow-headers'),
              allowCredentials: preflight.headers.get('access-control-allow-credentials'),
            },
            { origin, method: 'PUT', headers: ['content-type'], credentials: false },
          );
    if (refusal) {
      out.push(
        fail(
          'upload:cors',
          `preflight HTTP ${preflight.status}, allow-origin ${preflight.headers.get('access-control-allow-origin') ?? '(none)'}, allow-methods ${preflight.headers.get('access-control-allow-methods') ?? '(none)'}, allow-headers ${preflight.headers.get('access-control-allow-headers') ?? '(none)'}: ${refusal}; the bucket CORS must admit PUT from ${origin}`,
        ),
      );
      return out;
    }
    out.push(pass('upload:cors', `preflight admits PUT from ${origin}`));

    const put = await f(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', origin },
      // A copy on a plain ArrayBuffer: a BodyInit under both the Node and the DOM typings (the web e2e imports this).
      body: new Uint8Array(png),
    });
    if (put.status >= 300) {
      out.push(fail('upload:put', `HTTP ${put.status} from ${printable(uploadUrl)}`));
      return out;
    }
    out.push(pass('upload:put', `HTTP ${put.status}, ${png.length} bytes`));

    const completed = await mutate('assets.uploads.complete', { intentId });
    if (completed.status !== 200) {
      out.push(fail('upload:complete', trpcError(await jsonOf(completed), completed.status)));
      return out;
    }
    out.push(pass('upload:complete', 'ingest started'));

    const deadline = Date.now() + (cfg.ingestTimeoutMs ?? 120_000);
    let state = 'uploaded';
    for (;;) {
      const res = await query('assets.uploads.get', { intentId });
      const body = await jsonOf(res);
      const status = data(body) as {
        state?: string;
        assetId?: string | null;
        rejectionReason?: string | null;
      };
      if (res.status !== 200 || !status?.state) {
        out.push(fail('upload:ingest', trpcError(body, res.status)));
        return out;
      }
      state = status.state;
      if (state === 'accepted') {
        out.push(pass('upload:ingest', `accepted as ${status.assetId ?? '(no asset id)'}`));
        if (status.assetId) out.push(await retire(status.assetId));
        return out;
      }
      if (state === 'rejected') {
        out.push(fail('upload:ingest', `rejected: ${status.rejectionReason ?? 'no reason recorded'}`));
        return out;
      }
      if (Date.now() >= deadline) {
        out.push(
          fail(
            'upload:ingest',
            `still ${state} after ${(cfg.ingestTimeoutMs ?? 120_000) / 1000} s (worker-render's media queue)`,
          ),
        );
        return out;
      }
      await sleep(cfg.pollIntervalMs ?? 3000);
    }
  } finally {
    await f(`${origin}/auth/sign-out`, {
      method: 'POST',
      headers: { authorization: auth.authorization },
    }).catch(() => undefined);
  }
}

/** Every check, in order; independent checks run even when an earlier one failed. */
export async function runSmoke(
  cfg: SmokeConfig,
  f: Fetch = fetch,
  sleep?: (ms: number) => Promise<void>,
): Promise<CheckResult[]> {
  const guard = async (
    name: string,
    run: () => Promise<CheckResult | CheckResult[]>,
  ): Promise<CheckResult[]> => {
    try {
      const r = await run();
      return Array.isArray(r) ? r : [r];
    } catch (err) {
      // Network errors name the failure, never a URL's query or a header.
      return [
        fail(name, err instanceof Error ? `${err.name}: ${err.message.split('?')[0]}` : 'request failed'),
      ];
    }
  };
  return [
    ...(await guard('health', () => checkHealth(cfg, f))),
    ...(await guard('csp', () => checkCsp(cfg, f))),
    ...(await guard('legal:privacy', () => checkLegal(cfg, 'privacy', f))),
    ...(await guard('legal:data-deletion', () => checkLegal(cfg, 'data-deletion', f))),
    ...(await guard('brand.json', () => checkBrandJson(cfg, f))),
    ...(await guard('upload', () => checkUpload(cfg, f, sleep))),
  ];
}

export const formatResult = (r: CheckResult): string =>
  `${r.outcome.toUpperCase().padEnd(4)}  ${r.name.padEnd(20)}  ${r.detail}`;
