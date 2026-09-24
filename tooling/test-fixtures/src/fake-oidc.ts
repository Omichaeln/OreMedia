import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local OpenID Connect provider for tests (D-03 Google sign-in without network): discovery document, JWKS with
 * an RS256 key generated at start, an authorization endpoint that "approves" as the configured person, and a token
 * endpoint that checks client authentication, the redirect URI and the PKCE verifier before issuing a signed ID
 * token. Tests steer it with `identity` and `tamper` to produce every failure the adapter must refuse.
 */
export interface FakeIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
}

export interface TokenTamper {
  aud?: string;
  iss?: string;
  nonce?: string;
  /** Seconds relative to now for `exp` (negative = already expired). */
  expIn?: number;
  /** Sign with a key that is not in the JWKS (same kid). */
  foreignKey?: boolean;
  /** Omit the nonce claim even though the request carried one. */
  dropNonce?: boolean;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string | undefined;
  identity: FakeIdentity;
  used: boolean;
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export class FakeOidcProvider {
  issuer = '';
  identity: FakeIdentity = { sub: 'sub-default', email: 'person@example.test', email_verified: true };
  tamper: TokenTamper = {};
  /** When set, /authorize redirects back with this OAuth error instead of a code. */
  denyWith: string | null = null;
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  private readonly codes = new Map<string, IssuedCode>();
  private readonly kid = `kid-${randomBytes(4).toString('hex')}`;
  private readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private server: Server | null = null;

  constructor(
    readonly clientId: string,
    readonly clientSecret: string,
  ) {}

  static async start(clientId = 'test-client-id', clientSecret = `secret-${randomBytes(8).toString('hex')}`) {
    const p = new FakeOidcProvider(clientId, clientSecret);
    p.server = createServer((req, res) => {
      void p.handle(req).then(
        (r) => {
          res.writeHead(r.status, r.headers);
          res.end(r.body);
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
    await new Promise<void>((resolve) => p.server?.listen(0, '127.0.0.1', resolve));
    p.issuer = `http://127.0.0.1:${(p.server.address() as AddressInfo).port}`;
    return p;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Resets the steering knobs between tests. */
  reset(identity: FakeIdentity): void {
    this.identity = identity;
    this.tamper = {};
    this.denyWith = null;
  }

  private json(status: number, body: unknown) {
    return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }

  private async handle(req: IncomingMessage) {
    const url = new URL(req.url ?? '/', this.issuer);
    if (url.pathname === '/.well-known/openid-configuration')
      return this.json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    if (url.pathname === '/jwks')
      return this.json(200, {
        keys: [{ ...this.key.publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' }],
      });
    if (url.pathname === '/authorize') return this.authorize(url.searchParams);
    if (url.pathname === '/token' && req.method === 'POST') return this.token(req);
    return this.json(404, { error: 'not_found' });
  }

  private authorize(q: URLSearchParams) {
    this.authorizeRequests.push(q);
    const redirectUri = q.get('redirect_uri') ?? '';
    const back = new URL(redirectUri);
    if (q.get('state')) back.searchParams.set('state', q.get('state') as string);
    const invalid =
      q.get('client_id') !== this.clientId ||
      q.get('response_type') !== 'code' ||
      !(q.get('scope') ?? '').split(' ').includes('openid') ||
      q.get('code_challenge_method') !== 'S256' ||
      !q.get('code_challenge');
    if (invalid || this.denyWith) {
      back.searchParams.set('error', invalid ? 'invalid_request' : (this.denyWith as string));
      return { status: 302, headers: { location: back.href }, body: '' };
    }
    const code = b64url(randomBytes(16));
    this.codes.set(code, {
      clientId: this.clientId,
      redirectUri,
      codeChallenge: q.get('code_challenge') as string,
      nonce: q.get('nonce') ?? undefined,
      identity: { ...this.identity },
      used: false,
    });
    back.searchParams.set('code', code);
    back.searchParams.set('iss', this.issuer);
    return { status: 302, headers: { location: back.href }, body: '' };
  }

  private async token(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    this.tokenRequests.push(form);
    let clientId = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = req.headers.authorization;
    if (basic?.startsWith('Basic ')) {
      const [id, s] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id ?? '');
      secret = decodeURIComponent(s ?? '');
    }
    if (clientId !== this.clientId || secret !== this.clientSecret)
      return this.json(401, { error: 'invalid_client' });
    const issued = this.codes.get(form.get('code') ?? '');
    const verifier = form.get('code_verifier') ?? '';
    if (
      form.get('grant_type') !== 'authorization_code' ||
      !issued ||
      issued.used ||
      issued.redirectUri !== form.get('redirect_uri') ||
      b64url(createHash('sha256').update(verifier).digest()) !== issued.codeChallenge
    )
      return this.json(400, { error: 'invalid_grant' });
    issued.used = true;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.tamper.iss ?? this.issuer,
      aud: this.tamper.aud ?? this.clientId,
      sub: issued.identity.sub,
      iat: now,
      exp: now + (this.tamper.expIn ?? 300),
      ...((issued.nonce || this.tamper.nonce) && !this.tamper.dropNonce
        ? { nonce: this.tamper.nonce ?? issued.nonce }
        : {}),
      ...(issued.identity.email !== undefined ? { email: issued.identity.email } : {}),
      ...(issued.identity.email_verified !== undefined
        ? { email_verified: issued.identity.email_verified }
        : {}),
      ...(issued.identity.hd !== undefined ? { hd: issued.identity.hd } : {}),
      ...(issued.identity.name !== undefined ? { name: issued.identity.name } : {}),
    };
    return this.json(200, {
      access_token: b64url(randomBytes(24)),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid email profile',
      id_token: this.sign(claims, this.tamper.foreignKey ? this.foreign.privateKey : this.key.privateKey),
    });
  }

  private sign(claims: Record<string, unknown>, key: KeyObject): string {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.kid }));
    const body = b64url(JSON.stringify(claims));
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), key);
    return `${head}.${body}.${b64url(sig)}`;
  }
}

/** A minimal browser cookie jar for fetch with `redirect: 'manual'`. */
export class CookieJar {
  readonly cookies = new Map<string, string>();
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  /** Applies Set-Cookie headers; returns the raw headers for attribute assertions. */
  store(res: Response): string[] {
    const set = res.headers.getSetCookie();
    for (const line of set) {
      const [pair, ...attrs] = line.split(';');
      const i = (pair ?? '').indexOf('=');
      const name = (pair ?? '').slice(0, i).trim();
      const value = (pair ?? '').slice(i + 1).trim();
      const expired = attrs.some((a) => {
        const [k, v] = a.trim().split('=');
        const key = (k ?? '').toLowerCase();
        return (
          (key === 'max-age' && Number(v) <= 0) || (key === 'expires' && Date.parse(v ?? '') < Date.now())
        );
      });
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return set;
  }
}

export interface GoogleSignInRun {
  /** Where the callback finally sent the browser (relative path). */
  location: string;
  status: number;
  /** Set-Cookie headers of the callback response. */
  callbackSetCookies: string[];
  /** The authorization URL the start route produced. */
  authorizationUrl: URL;
}

/**
 * Drives start → provider → callback like a browser with `jar`. `mutateCallback` lets a test tamper with the URL
 * the provider sends the browser back to (state, code) before it reaches the API.
 */
export async function runGoogleSignIn(
  apiOrigin: string,
  jar: CookieJar,
  opts: { returnTo?: string; mutateCallback?: (url: URL) => void; dropFlowCookie?: boolean } = {},
): Promise<GoogleSignInRun> {
  const startUrl = new URL('/auth/google/start', apiOrigin);
  if (opts.returnTo !== undefined) startUrl.searchParams.set('returnTo', opts.returnTo);
  const start = await fetch(startUrl, { redirect: 'manual', headers: { cookie: jar.header() } });
  jar.store(start);
  const authorizationUrl = new URL(start.headers.get('location') ?? 'about:blank');
  const provider = await fetch(authorizationUrl, { redirect: 'manual' });
  const callback = new URL(provider.headers.get('location') ?? 'about:blank');
  opts.mutateCallback?.(callback);
  if (opts.dropFlowCookie) jar.cookies.delete('oremedia_oidc');
  // The browser follows the provider's redirect to the registered callback, served by the API under test.
  const res = await fetch(new URL(`${callback.pathname}${callback.search}`, apiOrigin), {
    redirect: 'manual',
    headers: { cookie: jar.header(), 'user-agent': 'fake-browser/1.0' },
  });
  const callbackSetCookies = jar.store(res);
  return {
    location: res.headers.get('location') ?? '',
    status: res.status,
    callbackSetCookies,
    authorizationUrl,
  };
}
