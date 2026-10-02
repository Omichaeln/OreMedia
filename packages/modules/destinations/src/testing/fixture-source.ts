import type {
  DestinationKind,
  SourceReportQualityFlag,
  SourceTargetMetadataV1,
} from '@oremedia/contracts/destinations';
import type {
  ClientConfig,
  DecryptedCredentials,
  ProviderErrorClass,
  RefreshResult,
  RevokeResult,
} from '@oremedia/contracts/providers';
import {
  ProviderAuthError,
  ProviderTransportError,
  SOURCE_ACCESS_REQUIRED,
  SourceReadError,
  classifyByStatus,
  sourceRegistry,
  type ProviderIO,
  type SourceAdapter,
  type SourceCapabilityV1,
  type SourceGrant,
  type SourceReportPage,
  type SourceReportRequest,
  type SourceReportRow,
  type SourceTarget,
} from '@oremedia/providers';

/**
 * Test fixture only (never registered in production): an in-memory source whose grant, targets and refresh answer
 * a test scripts per call. `certifiedAt` is set so the registry's certification gate lets tests through. It makes
 * no network call: what the connect flow and the refresh do with a grant is the subject, not the platform.
 */
export const fixtureSourceCapability = (
  kind: DestinationKind,
  over: Partial<SourceCapabilityV1> = {},
): SourceCapabilityV1 => ({
  key: kind,
  version: 1,
  vendor: 'Fixture',
  requiredScopes: ['https://www.googleapis.com/auth/fixture.readonly'],
  latencyHours: 1,
  rateLimits: [],
  // The real kind's reports (ga4.*, gsc.*, gbp.*) and presentation, so the dictionary, the policy data types and
  // the read model's console and tiles apply as in production.
  reports: sourceRegistry.capability(kind)?.reports ?? [],
  ...(sourceRegistry.capability(kind)?.presentation
    ? { presentation: sourceRegistry.capability(kind)?.presentation }
    : {}),
  certifiedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

export type RefreshBehaviour = { kind: 'refresh' } | { kind: 'revoked' } | { kind: 'transient' };
/** What the next fetchReport does: answer the scripted rows, or fail as the platform would. */
export type ReportBehaviour =
  | { kind: 'rows' }
  | { kind: 'unauthorised' }
  | { kind: 'forbidden' }
  /** R2-2: the platform API is not enabled for the project (a 403 that is no reconnect). */
  | { kind: 'access_required' }
  | { kind: 'rate_limited' }
  | { kind: 'transient' };

export class FixtureSourceAdapter implements SourceAdapter {
  readonly key: DestinationKind;
  readonly capability: SourceCapabilityV1;
  /** What the next exchangeCode returns. */
  grant: SourceGrant = {
    credentials: {
      accessToken: 'at_fixture_src',
      refreshToken: 'rt_fixture_src',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    grantedScopes: ['https://www.googleapis.com/auth/fixture.readonly'],
  };
  /** What listTargets returns; empty means no_eligible_account. */
  targets: SourceTarget[] = [{ externalId: 'properties/1', displayName: 'Fixture property' }];
  refreshBehaviour: RefreshBehaviour = { kind: 'refresh' };
  /** Every refresh call with the credentials it was handed (a test proves the stored grant was opened). */
  readonly refreshCalls: DecryptedCredentials[] = [];
  /** The last code exchanged. */
  lastCode: string | null = null;
  /** Rows per report key the next fetches return (page size `reportPageSize`); a report not listed has none. */
  reportRows: Record<string, SourceReportRow[]> = {};
  reportPageSize = 1000;
  reportBehaviour: ReportBehaviour = { kind: 'rows' };
  /** Behaviours consumed one per call before `reportBehaviour` applies (a 401 on the first read, rows on the retry). */
  readonly nextReportBehaviours: ReportBehaviour[] = [];
  /** Every fetchReport call with the request and the access token it was handed. */
  readonly reportCalls: Array<SourceReportRequest & { accessToken: string }> = [];
  /**
   * RA-10: what describeTarget answers (the target's reporting zone and currency), or a platform refusal; null
   * leaves the method answering "not exposed" so the runtime keys UTC days as before.
   */
  targetMetadata: SourceTargetMetadataV1 | { kind: 'unauthorised' | 'forbidden' } | null = null;
  readonly describeCalls: Array<{ externalId: string; accessToken: string }> = [];
  /** RA-10: the zone and quality flags every report page carries (as a GA4 answer's metadata would). */
  reportTimeZone: string | null = null;
  reportQuality: SourceReportQualityFlag[] = [];

  constructor(kind: DestinationKind = 'ga4_property', capability?: SourceCapabilityV1) {
    this.key = kind;
    this.capability = capability ?? fixtureSourceCapability(kind);
  }

  async authorizationUrl(input: { state: string; redirectUri: string; client: ClientConfig }) {
    const u = new URL('https://source.fixture.test/oauth/authorize');
    u.searchParams.set('client_id', input.client.clientId);
    u.searchParams.set('redirect_uri', input.redirectUri);
    u.searchParams.set('state', input.state);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    return { url: u.toString() };
  }

  async exchangeCode(input: { code: string }, _io: ProviderIO): Promise<SourceGrant> {
    this.lastCode = input.code;
    if (input.code === 'bad') throw new ProviderAuthError(this.key, 'exchange_failed', 'invalid_grant');
    return { ...this.grant, credentials: { ...this.grant.credentials } };
  }

  async refresh(
    credentials: DecryptedCredentials,
    _client: ClientConfig,
    _io: ProviderIO,
  ): Promise<RefreshResult> {
    this.refreshCalls.push({ ...credentials });
    switch (this.refreshBehaviour.kind) {
      case 'revoked':
        return { ok: false, reason: 'reconnect_required' };
      case 'transient':
        return { ok: false, reason: 'transient' };
      case 'refresh': {
        const expiresAt = new Date(Date.now() + 3600_000).toISOString();
        return {
          ok: true,
          credentials: { ...credentials, accessToken: `${credentials.accessToken}_refreshed`, expiresAt },
          tokenExpiresAt: expiresAt,
        };
      }
    }
  }

  /** RA-01: what the vendor answers a remote revoke with; a revoked grant refuses the refreshes that follow. */
  revokeBehaviour: RevokeResult | null = { outcome: 'revoked' };
  readonly revokeCalls: DecryptedCredentials[] = [];
  async revokeAccess(credentials: DecryptedCredentials): Promise<RevokeResult> {
    this.revokeCalls.push({ ...credentials });
    const result = this.revokeBehaviour ?? { outcome: 'not_supported' };
    if (result.outcome === 'revoked') this.refreshBehaviour = { kind: 'revoked' };
    return result;
  }

  async listTargets(): Promise<SourceTarget[]> {
    if (this.targets.length === 0)
      throw new ProviderAuthError(this.key, 'no_eligible_account', 'nothing readable');
    return this.targets.map((t) => ({ ...t }));
  }

  async describeTarget(
    credentials: DecryptedCredentials,
    _client: ClientConfig,
    _io: ProviderIO,
    externalId: string,
  ): Promise<SourceTargetMetadataV1> {
    this.describeCalls.push({ externalId, accessToken: credentials.accessToken });
    const scripted = this.targetMetadata;
    if (scripted && 'kind' in scripted) {
      const status = scripted.kind === 'unauthorised' ? 401 : 403;
      throw new SourceReadError(
        this.key,
        status,
        this.classifyError({ status, phase: 'after_send' }),
        `fixture ${status}`,
      );
    }
    return scripted ? { ...scripted } : { reportingTimeZone: null, currencyCode: null };
  }

  async fetchReport(
    credentials: DecryptedCredentials,
    _client: ClientConfig,
    _io: ProviderIO,
    request: SourceReportRequest,
  ): Promise<SourceReportPage> {
    this.reportCalls.push({ ...request, accessToken: credentials.accessToken });
    const fail = (status: number) =>
      new SourceReadError(
        this.key,
        status,
        this.classifyError({ status, phase: 'after_send' }),
        `fixture ${status}`,
      );
    const behaviour = this.nextReportBehaviours.shift() ?? this.reportBehaviour;
    switch (behaviour.kind) {
      case 'unauthorised':
        throw fail(401);
      case 'forbidden':
        throw fail(403);
      case 'access_required':
        throw new SourceReadError(
          this.key,
          403,
          { kind: 'rejected', code: SOURCE_ACCESS_REQUIRED },
          'fixture 403 SERVICE_DISABLED',
        );
      case 'rate_limited':
        throw fail(429);
      case 'transient':
        throw new ProviderTransportError('fixture reset', 'after_send');
      case 'rows': {
        const all = (this.reportRows[request.report] ?? []).filter(
          (r) => r.date >= request.dateRange.start && r.date <= request.dateRange.end,
        );
        const from = request.pageToken ? Number(request.pageToken) : 0;
        const rows = all.slice(from, from + this.reportPageSize).map((r) => ({
          ...r,
          dimensions: { ...r.dimensions },
          metrics: { ...r.metrics },
        }));
        const next = from + rows.length;
        return {
          rows,
          nextPageToken: next < all.length ? String(next) : null,
          reportingTimeZone: this.reportTimeZone,
          currencyCode: null,
          quality: [...this.reportQuality],
        };
      }
    }
  }

  /** As the Google sources: a 429 on a read is rate limited whatever the phase. */
  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass {
    if (input.status === 429) return { kind: 'rate_limited', phase: 'before_send', retryAfterMs: 60_000 };
    return classifyByStatus(input);
  }
}
