/**
 * RA-01: the source commands of the certification harness (a GA4 property, a Search Console site, a Business
 * Profile location): connect through the vendor's consent, list the targets the grant can read, read one report
 * of the chosen target, refresh, revoke. Each command records its step's evidence (harness.ts REQUIRED_STEPS.source).
 */
import { randomBytes } from 'node:crypto';
import type { DecryptedCredentials } from '@oremedia/contracts/providers';
import type { SourceGrant } from '@oremedia/providers';
import { recordEvidence, type SourceDeps } from './harness';

const describeCredentials = (c: DecryptedCredentials) => ({
  accessToken: `[${c.accessToken.length} chars]`,
  ...(c.refreshToken ? { refreshToken: `[${c.refreshToken.length} chars]` } : {}),
  ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
});

const print = (deps: SourceDeps, label: string, value: unknown) =>
  deps.out(`${label}\n${JSON.stringify(value, null, 2)}`);

function requireSource(deps: SourceDeps) {
  const session = deps.load();
  if (!session.source) throw new Error(`no connected grant for ${deps.key}: run auth-url, then exchange`);
  return { session, source: session.source };
}

/** The consent URL (offline access, consent), with a fresh state and PKCE verifier kept for the exchange. */
export async function sourceAuthUrl(deps: SourceDeps, redirectUri: string): Promise<void> {
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

/** Exchanges the code, checks the state and reports the granted scopes against the capability's requiredScopes. */
export async function sourceExchange(deps: SourceDeps, code: string, state?: string): Promise<void> {
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
  deps.save({ ...rest, source: { grant } });
  reportGrant(deps, grant);
}

function reportGrant(deps: SourceDeps, grant: SourceGrant): void {
  const granted = new Set(grant.grantedScopes.map((s) => s.toLowerCase()));
  const missing = deps.adapter.capability.requiredScopes.filter((s) => !granted.has(s.toLowerCase()));
  print(deps, 'Connected grant', {
    grantedScopes: grant.grantedScopes,
    missingScopes: missing,
    credentials: describeCredentials(grant.credentials),
  });
  recordEvidence(
    deps,
    'connect',
    missing.length === 0,
    missing.length ? `missing scopes ${missing.join(',')}` : 'grant with every required scope',
  );
}

/** Every target the grant can read; `--target <externalId>` chooses the one the read step uses. */
export async function sourceTargets(deps: SourceDeps, externalId?: string): Promise<void> {
  const { session, source } = requireSource(deps);
  const targets = await deps.adapter.listTargets(source.grant.credentials, deps.client(), deps.io);
  print(deps, 'Targets', targets);
  const chosen = externalId ? targets.find((t) => t.externalId === externalId) : targets[0];
  if (externalId && !chosen) throw new Error(`${externalId} is not among the targets the grant can read`);
  if (chosen) deps.save({ ...session, source: { ...source, target: chosen } });
  recordEvidence(
    deps,
    'targets',
    targets.length > 0,
    chosen ? `${targets.length} targets; chose ${chosen.externalId}` : 'no target the grant can read',
  );
}

/** One page of one report of the chosen target over the last `days` days: the read with its read-back of rows. */
export async function sourceRead(deps: SourceDeps, report: string | undefined, days: number): Promise<void> {
  const { source } = requireSource(deps);
  if (!source.target) throw new Error('no target chosen: run targets first');
  const key = report ?? deps.adapter.capability.reports[0]?.key;
  if (!key) throw new Error(`${deps.key} declares no report to read`);
  if (!deps.adapter.capability.reports.some((r) => r.key === key))
    throw new Error(
      `${key} is not a report of ${deps.key}: ${deps.adapter.capability.reports.map((r) => r.key).join(', ')}`,
    );
  const end = deps.now();
  const start = new Date(end.getTime() - days * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const page = await deps.adapter.fetchReport(source.grant.credentials, deps.client(), deps.io, {
    externalId: source.target.externalId,
    report: key,
    dateRange: { start: day(start), end: day(end) },
  });
  print(deps, `Report ${key}`, {
    rows: page.rows.length,
    nextPageToken: page.nextPageToken,
    first: page.rows[0] ?? null,
  });
  recordEvidence(deps, 'read', true, `${key}: ${page.rows.length} rows over ${days} days`);
}

/** Refresh; after `revoke` (or revoking the app at the vendor by hand) it must report reconnect_required. */
export async function sourceRefresh(deps: SourceDeps): Promise<void> {
  const { session, source } = requireSource(deps);
  const result = await deps.adapter.refresh(source.grant.credentials, deps.client(), deps.io);
  if (result.ok) {
    deps.save({
      ...session,
      source: { ...source, grant: { ...source.grant, credentials: result.credentials } },
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
    recordEvidence(deps, 'revoke', true, 'refresh refused with reconnect_required after revoke');
  else recordEvidence(deps, 'refresh', false, `refused: ${result.reason}`);
}

/** Revokes the grant at the vendor through the adapter where it can; the next refresh proves it. */
export async function sourceRevoke(deps: SourceDeps): Promise<void> {
  const { session, source } = requireSource(deps);
  deps.save({ ...session, revokeRequestedAt: deps.now().toISOString() });
  if (!deps.adapter.revokeAccess) {
    deps.out(
      `${deps.key} has no remote revoke: remove the app's access from the test account at the vendor, then run refresh (it must report reconnect_required).`,
    );
    return;
  }
  const result = await deps.adapter.revokeAccess(source.grant.credentials, deps.client(), deps.io);
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
