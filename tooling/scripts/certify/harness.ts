/**
 * Certification harness (docs/runbooks/certify-a-channel.md): drives an adapter against the real platform from a
 * person's machine, with test accounts, through the same ProviderIO (SSRF guard, timeouts, rate limiter) production
 * uses. It reaches uncertified adapters through `providerRegistry.forCertification`, the registry's internal-tooling
 * path, and never touches the database, the API or any tenant: what the running app allows is unchanged.
 *
 * Every request and response is recorded, redacted, under `.certify/<provider>/recordings/` so the runbook's
 * fixtures can be captured from real traffic. Credentials of the test account live in `.certify/<provider>/session.json`
 * (file mode 0600, git-ignored) until `forget` deletes them.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AccountGrant,
  ClientConfig,
  DecryptedCredentials,
  PendingState,
  PublishOutcome,
  RawMetricPoint,
} from '@oremedia/contracts/providers';
import {
  MemoryProviderRateLimiter,
  createProviderIO,
  providerRegistry,
  redactBody,
  textFingerprint,
  type ProviderAdapter,
  type ProviderIO,
} from '@oremedia/providers';

/** What a certification session keeps between commands (one file per provider). */
export interface CertifySession {
  providerKey: string;
  /** The OAuth round trip in progress. */
  auth?: { state: string; codeVerifier: string; redirectUri: string };
  grant?: AccountGrant;
  /** The last publish, so status, finalize and find can follow it. */
  lastPublish?: {
    publicationId: string;
    attemptStartedAt: string;
    text: string;
    textFingerprint: string;
    mediaFingerprints: string[];
    outcome: PublishOutcome;
    pending?: PendingState;
    remotePostId?: string;
  };
}

export interface CertifyDeps {
  adapter: ProviderAdapter;
  io: ProviderIO;
  client: () => ClientConfig;
  load: () => CertifySession;
  save: (s: CertifySession) => void;
  now: () => Date;
  out: (line: string) => void;
}

const SENSITIVE_QUERY = /([?&](?:access_token|client_secret|code|refresh_token|fb_exchange_token)=)[^&#]+/gi;
/** Query parameters that carry credentials are replaced before a URL is recorded or printed. */
export const redactUrl = (url: string): string => url.replace(SENSITIVE_QUERY, '$1[redacted]');

/** Credentials never reach the terminal: tokens are shown by length only. */
const describeCredentials = (c: DecryptedCredentials) => ({
  accessToken: `[${c.accessToken.length} chars]`,
  ...(c.refreshToken ? { refreshToken: `[${c.refreshToken.length} chars]` } : {}),
  ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
  ...(c.extra ? { extra: Object.keys(c.extra) } : {}),
});

function requireGrant(s: CertifySession): AccountGrant {
  if (!s.grant) throw new Error(`no connected account for ${s.providerKey}: run auth-url, then exchange`);
  return s.grant;
}

function requirePublish(s: CertifySession): NonNullable<CertifySession['lastPublish']> {
  if (!s.lastPublish) throw new Error(`nothing published for ${s.providerKey} yet: run publish first`);
  return s.lastPublish;
}

const print = (deps: CertifyDeps, label: string, value: unknown) =>
  deps.out(`${label}\n${JSON.stringify(value, null, 2)}`);

/** Runbook step 3 (start): the consent URL, with a fresh state and PKCE verifier kept for the exchange. */
export async function authUrl(deps: CertifyDeps, redirectUri: string): Promise<void> {
  const state = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(48).toString('base64url');
  const { url } = await deps.adapter.authorizationUrl({
    state,
    codeVerifier,
    redirectUri,
    client: deps.client(),
  });
  deps.save({ ...deps.load(), auth: { state, codeVerifier, redirectUri } });
  deps.out(`Open this URL signed in as the test account, approve, then run exchange with the code:\n${url}`);
}

/** Runbook step 3: exchanges the code, checks the returned state, and reports scopes against requiredScopes. */
export async function exchange(deps: CertifyDeps, code: string, state?: string): Promise<void> {
  const session = deps.load();
  if (!session.auth) throw new Error('no authorisation in progress: run auth-url first');
  if (state !== undefined && state !== session.auth.state)
    throw new Error('state does not match the one issued by auth-url (possible CSRF or a stale URL)');
  const grant = await deps.adapter.exchangeCode(
    {
      code,
      codeVerifier: session.auth.codeVerifier,
      redirectUri: session.auth.redirectUri,
      client: deps.client(),
    },
    deps.io,
  );
  const { auth: _done, ...rest } = session;
  deps.save({ ...rest, grant });
  reportGrant(deps, grant);
}

function reportGrant(deps: CertifyDeps, grant: AccountGrant): void {
  const required = deps.adapter.capability.requiredScopes;
  const granted = new Set(grant.grantedScopes.map((s) => s.toLowerCase()));
  print(deps, 'Connected account', {
    remoteAccountId: grant.remoteAccountId,
    displayName: grant.displayName,
    grantedScopes: grant.grantedScopes,
    missingScopes: required.filter((s) => !granted.has(s.toLowerCase())),
    tokenExpiresAt: grant.tokenExpiresAt ?? null,
    credentials: describeCredentials(grant.credentials),
    alternatives: grant.alternatives ?? [],
  });
}

/** Runbook step 3: re-targets the grant at another page or organisation the same login can address. */
export async function selectAccount(deps: CertifyDeps, remoteAccountId: string): Promise<void> {
  const session = deps.load();
  const grant = requireGrant(session);
  const select = (deps.adapter as { selectAccount?: SelectAccount }).selectAccount;
  if (!select) throw new Error(`${deps.adapter.key} has no account selection`);
  const next = await select.call(
    deps.adapter,
    grant.credentials,
    remoteAccountId,
    deps.io,
    grant.grantedScopes,
  );
  deps.save({ ...session, grant: next });
  reportGrant(deps, next);
}
type SelectAccount = (
  credentials: DecryptedCredentials,
  remoteAccountId: string,
  io: ProviderIO,
  grantedScopes?: string[],
) => Promise<AccountGrant>;

/** Runbook step 7: refresh; after revoking the app on the platform, the same command must report reconnect_required. */
export async function refresh(deps: CertifyDeps): Promise<void> {
  const session = deps.load();
  const grant = requireGrant(session);
  const result = await deps.adapter.refresh(grant.credentials, deps.client(), deps.io);
  if (result.ok) {
    deps.save({
      ...session,
      grant: {
        ...grant,
        credentials: result.credentials,
        ...(result.tokenExpiresAt ? { tokenExpiresAt: result.tokenExpiresAt } : {}),
      },
    });
    print(deps, 'Refreshed', {
      credentials: describeCredentials(result.credentials),
      tokenExpiresAt: result.tokenExpiresAt ?? null,
    });
  } else print(deps, 'Refresh refused', result);
}

export interface PublishInput {
  text: string;
  media: Array<{ url: string; mime: string; width: number; height: number; bytes: number; altText?: string }>;
}

/**
 * Runbook step 4: one publish through the adapter, validated against the capability first (as the product does).
 * The publication and attempt ids are fresh per run, so a repeated command is a new post, never a replay.
 */
export async function publish(deps: CertifyDeps, input: PublishInput): Promise<void> {
  const session = deps.load();
  const grant = requireGrant(session);
  const validation = deps.adapter.validateVariant({
    text: input.text,
    altTexts: input.media.map((m) => m.altText ?? ''),
    media: input.media.map(({ mime, width, height, bytes }) => ({ mime, width, height, bytes })),
    settings: {},
  });
  if (!validation.ok) {
    print(deps, 'Refused by the capability before sending', validation);
    return;
  }
  const publicationId = `cert_${randomBytes(8).toString('hex')}`;
  const attemptStartedAt = deps.now();
  const mediaFingerprints = input.media.map((m) => createHash('sha256').update(m.url).digest('hex'));
  const outcome = await deps.adapter.publish(
    {
      publicationId,
      attemptId: `${publicationId}_a1`,
      idempotencyKey: `${publicationId}_a1`,
      remoteAccountId: grant.remoteAccountId,
      text: input.text,
      media: input.media.map((m) => ({
        ...m,
        contentHash: createHash('sha256').update(m.url).digest('hex'),
      })),
      settings: {},
      textFingerprint: textFingerprint(input.text),
      mediaFingerprints,
    },
    grant.credentials,
    deps.io,
  );
  deps.save({
    ...session,
    lastPublish: {
      publicationId,
      attemptStartedAt: attemptStartedAt.toISOString(),
      text: input.text,
      textFingerprint: textFingerprint(input.text),
      mediaFingerprints,
      outcome,
      ...(outcome.outcome === 'pending' ? { pending: outcome.pending } : {}),
      ...(outcome.outcome === 'accepted' ? { remotePostId: outcome.remotePostId } : {}),
    },
  });
  print(deps, 'Publish outcome', outcome);
}

/** Runbook step 4: checkStatus / finalize on the last pending publish; after finalize, status must be completed. */
export async function pendingStep(deps: CertifyDeps, step: 'status' | 'finalize'): Promise<void> {
  const session = deps.load();
  const grant = requireGrant(session);
  const last = requirePublish(session);
  if (!last.pending) throw new Error('the last publish is not pending');
  const fn = step === 'status' ? deps.adapter.checkStatus : deps.adapter.finalize;
  if (!fn) throw new Error(`${deps.adapter.key} has no ${step === 'status' ? 'checkStatus' : 'finalize'}`);
  const result = await fn.call(deps.adapter, last.pending, grant.credentials, deps.io);
  if (result.status === 'completed')
    deps.save({ ...session, lastPublish: { ...last, remotePostId: result.remotePostId } });
  print(deps, step === 'status' ? 'Status' : 'Finalize', result);
}

/**
 * Runbook step 5: reconciliation for the last publish. Run it after publishing (expect found), after deleting the post
 * on the platform (expect definitely_absent) and after revoking the read scope (expect cannot_determine).
 */
export async function find(deps: CertifyDeps): Promise<void> {
  const session = deps.load();
  const grant = requireGrant(session);
  const last = requirePublish(session);
  const result = await deps.adapter.findRemotePost(
    {
      publicationId: last.publicationId,
      attemptStartedAt: new Date(last.attemptStartedAt),
      textFingerprint: last.textFingerprint,
      mediaFingerprints: last.mediaFingerprints,
      remoteAccountId: grant.remoteAccountId,
    },
    grant.credentials,
    deps.io,
  );
  print(deps, 'Reconciliation', result);
}

/** Runbook step 9: post metrics (default: the last published post) or account metrics over the last `hours`. */
export async function metrics(
  deps: CertifyDeps,
  scope: 'post' | 'account',
  hours: number,
  remotePostId?: string,
): Promise<void> {
  const session = deps.load();
  const grant = requireGrant(session);
  const end = deps.now();
  const window = { start: new Date(end.getTime() - hours * 3_600_000).toISOString(), end: end.toISOString() };
  if (scope === 'account') {
    if (!deps.adapter.fetchAccountMetrics) throw new Error(`${deps.adapter.key} has no account metrics`);
    const points = await deps.adapter.fetchAccountMetrics(
      { remoteAccountId: grant.remoteAccountId, window },
      grant.credentials,
      deps.io,
    );
    print(deps, 'Account metrics', reportMetrics(deps.adapter.capability.analytics.account, points));
    return;
  }
  const postId = remotePostId ?? requirePublish(session).remotePostId;
  if (!postId) throw new Error('no remote post id: pass --post or finish the last publish first');
  if (!deps.adapter.fetchPostMetrics) throw new Error(`${deps.adapter.key} has no post metrics`);
  const points = await deps.adapter.fetchPostMetrics(
    { remotePostId: postId, window },
    grant.credentials,
    deps.io,
  );
  print(deps, 'Post metrics', reportMetrics(deps.adapter.capability.analytics.post, points));
}

/** Every metric the capability declares is either returned or listed as missing: never a silent zero. */
function reportMetrics(declared: readonly string[], points: RawMetricPoint[]) {
  const returned = new Set(points.map((p) => p.nativeName));
  return {
    points,
    notReturned: declared.filter((n) => !returned.has(n)),
    unavailable: points.filter((p) => p.completeness === 'unavailable').map((p) => p.nativeName),
  };
}

/** Runbook step 10: a page of comments on a post (default: the last published one), and optionally a reply. */
export async function comments(
  deps: CertifyDeps,
  opts: { remotePostId?: string; cursor?: string; reply?: string },
): Promise<void> {
  const session = deps.load();
  const grant = requireGrant(session);
  const postId = opts.remotePostId ?? requirePublish(session).remotePostId;
  if (!postId) throw new Error('no remote post id: pass --post or finish the last publish first');
  if (opts.reply !== undefined) {
    if (!deps.adapter.comment) throw new Error(`${deps.adapter.key} cannot reply to comments`);
    const outcome = await deps.adapter.comment(
      { remotePostId: postId, text: opts.reply, idempotencyKey: `cert_${randomBytes(8).toString('hex')}` },
      grant.credentials,
      deps.io,
    );
    print(deps, 'Reply outcome', outcome);
    return;
  }
  if (!deps.adapter.fetchComments) throw new Error(`${deps.adapter.key} has no comment reading`);
  const page = await deps.adapter.fetchComments(
    { remotePostId: postId, ...(opts.cursor ? { cursor: opts.cursor } : {}) },
    grant.credentials,
    deps.io,
  );
  print(deps, 'Comments', page);
}

// ---- wiring: session files, client credentials, recording IO ----

export const certifyRoot = (root: string) => path.join(root, '.certify');

export function fileStore(root: string, providerKey: string) {
  const dir = path.join(certifyRoot(root), providerKey);
  const file = path.join(dir, 'session.json');
  return {
    dir,
    load: (): CertifySession =>
      existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as CertifySession) : { providerKey },
    save: (s: CertifySession): void => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    },
    forget: (): void => rmSync(file, { force: true }),
  };
}

/** The same variable names the product reads (PROVIDER_<KEY>_CLIENT_ID_REF / _SECRET_REF), from the local shell. */
export function clientFromEnv(providerKey: string, env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const upper = providerKey.toUpperCase();
  const clientId = env[`PROVIDER_${upper}_CLIENT_ID_REF`];
  const clientSecret = env[`PROVIDER_${upper}_SECRET_REF`];
  if (!clientId || !clientSecret)
    throw new Error(`set PROVIDER_${upper}_CLIENT_ID_REF and PROVIDER_${upper}_SECRET_REF in this shell`);
  return { clientId, clientSecret };
}

export interface Recording {
  at: string;
  method: string;
  url: string;
  mutation: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
}

/** Response headers worth keeping in a fixture: rate limits, retry hints, request ids. Never cookies or auth. */
const KEPT_HEADERS =
  /^(retry-after|x-rate-limit.*|x-ratelimit.*|x-app-usage|x-business-use-case-usage|x-fb-trace-id|x-li-uuid|x-restli-id|x-restli-protocol-version|content-type)$/i;

/** Wraps a ProviderIO so every exchange is recorded (URL and body redacted) without consuming the adapter's response. */
export function recordingIO(inner: ProviderIO, record: (r: Recording) => void, now: () => Date): ProviderIO {
  return {
    async request(url, init, meta) {
      const method = (init.method ?? 'GET').toUpperCase();
      const base = { at: now().toISOString(), method, url: redactUrl(url), mutation: meta.mutation };
      try {
        const out = await inner.request(url, init, meta);
        const headers: Record<string, string> = {};
        out.res.headers.forEach((v, k) => {
          if (KEPT_HEADERS.test(k)) headers[k] = v;
        });
        const body = redactBody(await out.res.clone().text());
        record({ ...base, status: out.res.status, headers, body });
        return out;
      } catch (err) {
        record({ ...base, error: (err as Error).message });
        throw err;
      }
    },
  };
}

export function buildDeps(opts: {
  root: string;
  providerKey: string;
  command: string;
  out: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}): CertifyDeps & { forget: () => void; recordingsFile: string } {
  const adapter = providerRegistry.forCertification(opts.providerKey);
  if (!adapter) throw new Error(`unknown provider ${opts.providerKey}`);
  const store = fileStore(opts.root, opts.providerKey);
  const now = () => new Date();
  const recordingsDir = path.join(store.dir, 'recordings');
  const recordingsFile = path.join(
    recordingsDir,
    `${now().toISOString().replace(/[:.]/g, '-')}-${opts.command}.json`,
  );
  const recordings: Recording[] = [];
  const io = recordingIO(
    createProviderIO({
      providerKey: opts.providerKey,
      tenantId: 'certification',
      timeoutMs: 30_000,
      limiter: new MemoryProviderRateLimiter((key) => providerRegistry.capability(key), 30_000),
    }),
    (r) => {
      recordings.push(r);
      mkdirSync(recordingsDir, { recursive: true, mode: 0o700 });
      writeFileSync(recordingsFile, `${JSON.stringify(recordings, null, 2)}\n`, { mode: 0o600 });
    },
    now,
  );
  return {
    adapter,
    io,
    client: () => clientFromEnv(opts.providerKey, opts.env),
    load: store.load,
    save: store.save,
    forget: store.forget,
    now,
    out: opts.out,
    recordingsFile,
  };
}
