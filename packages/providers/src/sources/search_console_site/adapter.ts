import type {
  ClientConfig,
  DecryptedCredentials,
  ProviderErrorClass,
  RefreshResult,
  RevokeResult,
} from '@oremedia/contracts/providers';
import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import { classifyByStatus } from '../../base';
import type { ProviderIO } from '../../io';
import { ProviderAuthError, arr, get, num, sourceReadError, str, summarise } from '../../shared';
import type {
  SourceAdapter,
  SourceGrant,
  SourceReportPage,
  SourceReportRequest,
  SourceReportRow,
  SourceTarget,
} from '../../source-contract';
import {
  googleAuthorizationUrl,
  googleExchangeCode,
  googleGet,
  googlePost,
  googleRefresh,
  googleRevoke,
} from '../google-oauth';
import { searchConsoleSiteCapability } from './capability';

export const SEARCH_CONSOLE_API = 'https://www.googleapis.com/webmasters/v3';
/** searchAnalytics/query rows per call (the API's documented page size); longer results page by startRow. */
export const GSC_REPORT_ROW_LIMIT = 1000;
/** A site the person has no verified access to cannot be read; the listing still names it. */
const UNVERIFIED = 'siteUnverifiedUser';

/**
 * Search Console site source adapter (ledger R2-1 part A): Google OAuth with offline access and the sites the
 * grant can read from the Webmasters API's site list. The externalId is the site URL as Search Console names it
 * (`https://acme.example/` or `sc-domain:acme.example`). Read-only.
 */
export class SearchConsoleSiteAdapter implements SourceAdapter {
  readonly key = 'search_console_site' as const;
  readonly capability = searchConsoleSiteCapability;

  async authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    client: ClientConfig;
  }): Promise<{ url: string }> {
    return { url: googleAuthorizationUrl({ ...input, scopes: this.capability.requiredScopes }) };
  }

  exchangeCode(
    input: { code: string; codeVerifier: string; redirectUri: string; client: ClientConfig },
    io: ProviderIO,
  ): Promise<SourceGrant> {
    return googleExchangeCode(this.key, io, input);
  }

  refresh(credentials: DecryptedCredentials, client: ClientConfig, io: ProviderIO): Promise<RefreshResult> {
    return googleRefresh(credentials, client, io);
  }

  /** RA-01: revokes the Google grant (the refresh token, and every access token under it). */
  async revokeAccess(
    credentials: DecryptedCredentials,
    _client: ClientConfig,
    io: ProviderIO,
  ): Promise<RevokeResult> {
    return googleRevoke(credentials, io);
  }

  /** Every verified site the grant can read (an unverified entry is listed by Google but readable by nobody). */
  async listTargets(credentials: DecryptedCredentials, _client: ClientConfig, io: ProviderIO) {
    const res = await googleGet(io, `${SEARCH_CONSOLE_API}/sites`, credentials.accessToken);
    if (res.status !== 200) throw new ProviderAuthError(this.key, 'identity_failed', summarise(res));
    const targets: SourceTarget[] = [];
    for (const site of arr(get(res.json, 'siteEntry'))) {
      const siteUrl = str(get(site, 'siteUrl'));
      if (!siteUrl || str(get(site, 'permissionLevel')) === UNVERIFIED) continue;
      targets.push({ externalId: siteUrl, displayName: siteUrl });
    }
    if (targets.length === 0)
      throw new ProviderAuthError(this.key, 'no_eligible_account', 'no verified Search Console site');
    return targets;
  }

  /**
   * One page of a search analytics report: `searchAnalytics/query` with `date` first among the dimensions, final
   * data only, `rowLimit` 1000 paged by `startRow` (a full page means there may be more; the token carries the
   * next start row).
   */
  async fetchReport(
    credentials: DecryptedCredentials,
    _client: ClientConfig,
    io: ProviderIO,
    request: SourceReportRequest,
  ): Promise<SourceReportPage> {
    const spec = this.capability.reports.find((r) => r.key === request.report);
    if (!spec)
      throw new CapabilityUnsupportedError([{ path: 'report', issue: `unknown_report:${request.report}` }]);
    const startRow = request.pageToken ? Number(request.pageToken) : 0;
    const res = await googlePost(
      io,
      `${SEARCH_CONSOLE_API}/sites/${encodeURIComponent(request.externalId)}/searchAnalytics/query`,
      credentials.accessToken,
      {
        startDate: request.dateRange.start,
        endDate: request.dateRange.end,
        dimensions: ['date', ...spec.dimensions],
        dataState: 'final',
        rowLimit: GSC_REPORT_ROW_LIMIT,
        startRow,
      },
    );
    if (res.status !== 200) throw sourceReadError(this.key, (i) => this.classifyError(i), res);
    const rows: SourceReportRow[] = [];
    for (const row of arr(get(res.json, 'rows'))) {
      const keys = arr(get(row, 'keys')).map((k) => str(k) ?? '');
      const date = keys[0];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // a row without its day cannot be stored by day
      const dimensions: Record<string, string> = {};
      spec.dimensions.forEach((name, i) => {
        dimensions[name] = keys[i + 1] ?? '';
      });
      const metrics: Record<string, number> = {};
      for (const { name } of spec.metrics) {
        const value = num(get(row, name));
        if (value !== undefined) metrics[name] = value; // a metric the API left out is absent, never zero
      }
      rows.push({ date, dimensions, metrics });
    }
    return {
      rows,
      nextPageToken: rows.length >= GSC_REPORT_ROW_LIMIT ? String(startRow + rows.length) : null,
    };
  }

  /** Read-only API: a 429 (quota) refused the read before any effect, so it is rate limited whatever the phase. */
  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass {
    if (input.status === 429) return { kind: 'rate_limited', phase: 'before_send' };
    return classifyByStatus(input);
  }
}

export const searchConsoleSiteAdapter = new SearchConsoleSiteAdapter();
