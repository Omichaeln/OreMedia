/**
 * Certification harness (docs/runbooks/certify-a-provider.md): drives an adapter against the real platform from a
 * person's machine, with test accounts, through the same ProviderIO (SSRF guard, timeouts, rate limiter) production
 * uses. It reaches uncertified adapters through the registries' `forCertification`, their internal-tooling path,
 * and never touches the database, the API or any tenant: what the running app allows is unchanged.
 *
 * RA-01: one harness for the three provider kinds. The channel commands live here, the source commands in
 * source.ts and the CMS commands in cms.ts; all share the session file, the recording IO and the evidence record
 * below. Every command records its step's evidence (passed or failed, with what was seen and the recording file)
 * in `.certify/<provider>/session.json`; `attest` writes `.certify/<provider>/certification.json` only when every
 * step the kind requires has passed, and refuses otherwise, naming the missing steps. Setting `certifiedAt` in the
 * adapter's capability stays a person's edit, made from that record.
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
  ProviderKind,
  PublishOutcome,
  RawMetricPoint,
} from '@oremedia/contracts/providers';
import {
  MemoryProviderRateLimiter,
  cmsRegistry,
  createProviderIO,
  providerRegistry,
  redactBody,
  sourceRegistry,
  textFingerprint,
  type CmsAdapter,
  type CmsSite,
  type ProviderAdapter,
  type ProviderIO,
  type SourceAdapter,
  type SourceGrant,
  type SourceTarget,
} from '@oremedia/providers';

export type CertifyKind = ProviderKind;

/**
 * The evidence procedure per kind: connect, read, write where applicable with its read-back, revoke. A provider is
 * attested only when every step of its kind has passed (status shows which are missing).
 */
export const REQUIRED_STEPS: Readonly<Record<CertifyKind, readonly string[]>> = {
  channel: ['connect', 'publish', 'find', 'refresh', 'metrics', 'comments', 'revoke'],
  source: ['connect', 'targets', 'read', 'refresh', 'revoke'],
  cms: ['connect', 'write', 'update', 'unpublish', 'delete', 'revoke'],
};

/** What one step's run established: the time, whether it passed, what was seen and the recording it came from. */
export interface EvidenceEntry {
  at: string;
  ok: boolean;
  detail: string;
  recordings?: string;
}

/** What `attest` writes: the record a person sets `certifiedAt` from (never written by the harness into code). */
export interface CertificationRecord {
  key: string;
  kind: CertifyKind;
  certifiedAt: string;
  steps: Record<string, EvidenceEntry>;
}

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
  /** A source's grant and the target chosen among those it can read (source.ts). */
  source?: { grant: SourceGrant; target?: SourceTarget };
  /** A CMS site with its integration identity's secret, and the article the write steps follow (cms.ts). */
  cms?: {
    site: CmsSite;
    credentials: DecryptedCredentials;
    article?: { remoteId: string; contentHash: string; modifiedAt: string | null; html: string };
  };
  /** When `revoke` was asked of a platform without a remote revoke: the next refused refresh or verify proves it. */
  revokeRequestedAt?: string;
  /** The evidence per step (REQUIRED_STEPS). */
  evidence?: Record<string, EvidenceEntry>;
}

/** What every kind's commands need: the session, the recording IO, the clock and the output. */
export interface CertifyBaseDeps {
  kind: CertifyKind;
  key: string;
  io: ProviderIO;
  client: () => ClientConfig;
  load: () => CertifySession;
  save: (s: CertifySession) => void;
  now: () => Date;
  out: (line: string) => void;
  /** The file this command's exchanges are recorded in (buildDeps sets it; tests may leave it out). */
  recordingsFile?: string;
}
export interface CertifyDeps extends CertifyBaseDeps {
  kind: 'channel';
  adapter: ProviderAdapter;
}
export interface SourceDeps extends CertifyBaseDeps {
  kind: 'source';
  adapter: SourceAdapter;
}
export interface CmsDeps extends CertifyBaseDeps {
  kind: 'cms';
  adapter: CmsAdapter;
}

/** Records a step's evidence in the session and says so; a failed step replaces an earlier pass (the latest run counts). */
export function recordEvidence(deps: CertifyBaseDeps, step: string, ok: boolean, detail: string): void {
  const session = deps.load();
  const entry: EvidenceEntry = {
    at: deps.now().toISOString(),
    ok,
    detail,
    ...(deps.recordingsFile ? { recordings: deps.recordingsFile } : {}),
  };
  deps.save({ ...session, evidence: { ...(session.evidence ?? {}), [step]: entry } });
  deps.out(`Evidence: ${step} ${ok ? 'passed' : 'FAILED'} (${detail})`);
}

/** The steps the kind requires that have not passed yet. */
export function missingSteps(kind: CertifyKind, session: CertifySession): string[] {
  return REQUIRED_STEPS[kind].filter((step) => !session.evidence?.[step]?.ok);
}

/** `status`: every required step with what its last run established. */
export function status(deps: CertifyBaseDeps): void {
  const session = deps.load();
  const lines = REQUIRED_STEPS[deps.kind].map((step) => {
    const e = session.evidence?.[step];
    return `${e ? (e.ok ? 'passed ' : 'FAILED ') : 'missing'}  ${step}${e ? `  ${e.at}  ${e.detail}` : ''}`;
  });
  const missing = missingSteps(deps.kind, session);
  deps.out(
    `Certification evidence for ${deps.key} (${deps.kind})\n${lines.join('\n')}\n${
      missing.length ? `Not attestable: ${missing.join(', ')} still to pass.` : 'Every required step passed.'
    }`,
  );
}

/**
 * `attest`: the certification record, written only when every required step passed; otherwise refused with the
 * steps still missing. The record is what a person copies `certifiedAt` from into the adapter's capability (with
 * the decision log entry); the harness never edits code.
 */
export function attest(
  deps: CertifyBaseDeps,
  write: (record: CertificationRecord) => void,
): CertificationRecord {
  const session = deps.load();
  const missing = missingSteps(deps.kind, session);
  if (missing.length)
    throw new Error(
      `${deps.key} cannot be attested: ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} not passed (run status)`,
    );
  const steps = Object.fromEntries(REQUIRED_STEPS[deps.kind].map((s) => [s, session.evidence![s]!]));
  const record: CertificationRecord = {
    key: deps.key,
    kind: deps.kind,
    certifiedAt: deps.now().toISOString(),
    steps,
  };
  write(record);
  deps.out(
    `Attested ${deps.key} (${deps.kind}) at ${record.certifiedAt}: set certifiedAt to this value in the adapter's capability and record the run in docs/decisions/DECISIONS.md.`,
  );
  return record;
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
  const missing = required.filter((s) => !granted.has(s.toLowerCase()));
  print(deps, 'Connected account', {
    remoteAccountId: grant.remoteAccountId,
    displayName: grant.displayName,
    grantedScopes: grant.grantedScopes,
    missingScopes: missing,
    tokenExpiresAt: grant.tokenExpiresAt ?? null,
    credentials: describeCredentials(grant.credentials),
    alternatives: grant.alternatives ?? [],
  });
  recordEvidence(
    deps,
    'connect',
    missing.length === 0,
    missing.length ? `missing scopes ${missing.join(',')}` : `account ${grant.remoteAccountId}`,
  );
}

/** Runbook step 3: re-targets the grant at another page or organisation the same login can address. */
export async function selectAccount(deps: CertifyDeps, remoteAccountId: string): Promise<void> {
  const session = deps.load();
  const grant = requireGrant(session);
  if (!deps.adapter.selectAccount) throw new Error(`${deps.adapter.key} has no account selection`);
  const next = await deps.adapter.selectAccount(
    grant.credentials,
    remoteAccountId,
    deps.io,
    grant.grantedScopes,
  );
  deps.save({ ...session, grant: next });
  reportGrant(deps, next);
}

/**
 * Runbook step 7: refresh; after `revoke` (or revoking the app on the platform by hand), the same command must
 * report reconnect_required, which is the proof of the revoke step.
 */
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
    recordEvidence(deps, 'refresh', true, `token expires ${result.tokenExpiresAt ?? 'never'}`);
    return;
  }
  print(deps, 'Refresh refused', result);
  if (session.revokeRequestedAt && result.reason === 'reconnect_required')
    recordEvidence(deps, 'revoke', true, `refresh refused with reconnect_required after revoke`);
  else recordEvidence(deps, 'refresh', false, `refused: ${result.reason}`);
}

/**
 * RA-01: asks the platform to revoke the test account's grant through the adapter's `revokeAccess` (what a
 * disconnect does in production). An adapter without one is revoked by hand at the platform; either way the next
 * `refresh` must report reconnect_required, which completes the step.
 */
export async function revoke(deps: CertifyDeps): Promise<void> {
  const session = deps.load();
  const grant = requireGrant(session);
  deps.save({ ...session, revokeRequestedAt: deps.now().toISOString() });
  if (!deps.adapter.revokeAccess) {
    deps.out(
      `${deps.adapter.key} has no remote revoke: remove the app from the test account at the platform, then run refresh (it must report reconnect_required).`,
    );
    return;
  }
  const result = await deps.adapter.revokeAccess(grant.credentials, deps.client(), deps.io);
  print(deps, 'Revoke outcome', result);
  if (result.outcome === 'revoked') deps.out('Now run refresh: it must report reconnect_required.');
  else
    recordEvidence(
      deps,
      'revoke',
      false,
      result.outcome === 'failed' ? `failed: ${result.reason}` : 'not supported by the adapter',
    );
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
  if (outcome.outcome === 'accepted') recordEvidence(deps, 'publish', true, `post ${outcome.remotePostId}`);
  else if (outcome.outcome !== 'pending')
    recordEvidence(deps, 'publish', false, `${outcome.outcome}: ${outcome.code}`);
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
  if (result.status === 'completed') recordEvidence(deps, 'publish', true, `post ${result.remotePostId}`);
  else if (result.status === 'failed')
    recordEvidence(deps, 'publish', false, `${result.code}: ${result.message}`);
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
  recordEvidence(
    deps,
    'find',
    result.status === 'found',
    result.status === 'found' ? `found by ${result.matchedBy}` : result.status,
  );
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
  const report = reportMetrics(deps.adapter.capability.analytics.post, points);
  print(deps, 'Post metrics', report);
  const returned = points.filter((p) => p.completeness !== 'unavailable').length;
  recordEvidence(deps, 'metrics', returned > 0, `${returned} of ${points.length} points returned`);
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
  recordEvidence(deps, 'comments', true, `${page.items.length} comments read`);
}

// ---- wiring: session files, client credentials, recording IO ----

export const certifyRoot = (root: string) => path.join(root, '.certify');

export function fileStore(root: string, providerKey: string) {
  const dir = path.join(certifyRoot(root), providerKey);
  const file = path.join(dir, 'session.json');
  const certification = path.join(dir, 'certification.json');
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
    /** The attested record (no credentials in it): kept beside the session, readable by its owner only. */
    writeCertification: (record: CertificationRecord): void => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(certification, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    },
    certificationFile: certification,
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

/** The registry a key belongs to, with its adapter: a channel, a source or a CMS (every kind certifies the same way). */
export function resolveAdapter(
  key: string,
):
  | { kind: 'channel'; adapter: ProviderAdapter }
  | { kind: 'source'; adapter: SourceAdapter }
  | { kind: 'cms'; adapter: CmsAdapter } {
  const channel = providerRegistry.forCertification(key);
  if (channel) return { kind: 'channel', adapter: channel };
  const source = sourceRegistry.forCertification(key);
  if (source) return { kind: 'source', adapter: source };
  const cms = cmsRegistry.forCertification(key);
  if (cms) return { kind: 'cms', adapter: cms };
  throw new Error(`unknown provider ${key}`);
}

interface BuiltExtras {
  forget: () => void;
  recordingsFile: string;
  writeCertification: (record: CertificationRecord) => void;
  certificationFile: string;
}
export type BuiltDeps = (CertifyDeps & BuiltExtras) | (SourceDeps & BuiltExtras) | (CmsDeps & BuiltExtras);

export function buildDeps(opts: {
  root: string;
  providerKey: string;
  command: string;
  out: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}): BuiltDeps {
  const resolved = resolveAdapter(opts.providerKey);
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
      limiter: new MemoryProviderRateLimiter(
        (key) =>
          providerRegistry.capability(key) ?? sourceRegistry.capability(key) ?? cmsRegistry.capability(key),
        30_000,
      ),
    }),
    (r) => {
      recordings.push(r);
      mkdirSync(recordingsDir, { recursive: true, mode: 0o700 });
      writeFileSync(recordingsFile, `${JSON.stringify(recordings, null, 2)}\n`, { mode: 0o600 });
    },
    now,
  );
  return {
    ...resolved,
    key: opts.providerKey,
    io,
    client: () => clientFromEnv(opts.providerKey, opts.env),
    load: store.load,
    save: store.save,
    forget: store.forget,
    now,
    out: opts.out,
    recordingsFile,
    writeCertification: store.writeCertification,
    certificationFile: store.certificationFile,
  } as BuiltDeps;
}
