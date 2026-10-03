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
import {
  ProviderAuthError,
  arr,
  get,
  num,
  sourceReadError,
  str,
  summarise,
  type ProviderResponse,
} from '../../shared';
import {
  SOURCE_ACCESS_REQUIRED,
  type SourceAdapter,
  type SourceGrant,
  type SourceReportPage,
  type SourceReportRequest,
  type SourceReportRow,
  type SourceTarget,
} from '../../source-contract';
import {
  googleAuthorizationUrl,
  googleExchangeCode,
  googleGet,
  googleRefresh,
  googleRevoke,
} from '../google-oauth';
import { GBP_ACTION_METRICS, GBP_IMPRESSION_METRICS, gbpLocationCapability } from './capability';

export const GBP_ACCOUNT_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
export const GBP_INFORMATION_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
export const GBP_PERFORMANCE_API = 'https://businessprofileperformance.googleapis.com/v1';
/** accounts.list pages: 20 per request (the API's maximum), at most 10 pages per listing. */
const ACCOUNT_PAGE_SIZE = 20;
const ACCOUNT_MAX_PAGES = 10;
/** accounts.locations.list pages: 100 per request (the API's maximum), at most 10 pages per account. */
const LOCATION_PAGE_SIZE = 100;
const LOCATION_MAX_PAGES = 10;
/** The location fields the listing asks for (the Business Information API refuses a request without a read mask). */
const LOCATION_READ_MASK = 'name,title,storefrontAddress';
/**
 * The structured reasons of a 403 that mean the API is not enabled or approved for the deployment's Cloud project
 * rather than the person's grant being refused (`error.details[].reason` as google.rpc.ErrorInfo carries it, or the
 * legacy `error.errors[].reason`). Prose is never matched: a permission refusal stays a reconnect.
 */
const ACCESS_REQUIRED_REASONS = new Set(['SERVICE_DISABLED', 'accessNotConfigured']);

/**
 * Google Business Profile location source adapter (ledger R2-2, read-only slice under D-17): Google OAuth with
 * offline access and the `business.manage` scope (the only scope the Business Profile APIs accept; the product
 * reads with it and writes nothing), the locations of every account the grant can see (`locations/<id>`, the
 * externalId the Performance API is keyed by) and the location's daily performance metrics. Reviews, local posts
 * and replies are out of scope here.
 */
export class GbpLocationAdapter implements SourceAdapter {
  readonly key = 'gbp_location' as const;
  readonly capability = gbpLocationCapability;

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

  /**
   * Every location of every account the grant can see: the accounts from the Account Management API, then each
   * account's locations from the Business Information API with a read mask of name, title and storefront address.
   * A refused listing is identity_failed; when the refusal says the API is not enabled for the project, the detail
   * says so (the owner applies for access, the person cannot fix it by consenting again).
   */
  async listTargets(credentials: DecryptedCredentials, _client: ClientConfig, io: ProviderIO) {
    const targets: SourceTarget[] = [];
    const accounts: Array<{ name: string; displayName: string | undefined }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < ACCOUNT_MAX_PAGES; page++) {
      const u = new URL(`${GBP_ACCOUNT_API}/accounts`);
      u.searchParams.set('pageSize', String(ACCOUNT_PAGE_SIZE));
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const res = await googleGet(io, u.toString(), credentials.accessToken);
      if (res.status !== 200) throw this.listingRefused(res);
      for (const account of arr(get(res.json, 'accounts'))) {
        const name = str(get(account, 'name'));
        if (name) accounts.push({ name, displayName: str(get(account, 'accountName')) });
      }
      pageToken = str(get(res.json, 'nextPageToken'));
      if (!pageToken) break;
    }
    for (const account of accounts) {
      let locationToken: string | undefined;
      for (let page = 0; page < LOCATION_MAX_PAGES; page++) {
        const u = new URL(`${GBP_INFORMATION_API}/${account.name}/locations`);
        u.searchParams.set('readMask', LOCATION_READ_MASK);
        u.searchParams.set('pageSize', String(LOCATION_PAGE_SIZE));
        if (locationToken) u.searchParams.set('pageToken', locationToken);
        const res = await googleGet(io, u.toString(), credentials.accessToken);
        if (res.status !== 200) throw this.listingRefused(res);
        for (const location of arr(get(res.json, 'locations'))) {
          const externalId = str(get(location, 'name'));
          if (!externalId) continue;
          const title = str(get(location, 'title')) ?? externalId;
          const address = addressSummary(get(location, 'storefrontAddress'));
          const name = address ? `${title} (${address})` : title;
          targets.push({
            externalId,
            displayName: account.displayName ? `${account.displayName} · ${name}` : name,
          });
        }
        locationToken = str(get(res.json, 'nextPageToken'));
        if (!locationToken) break;
      }
    }
    if (targets.length === 0)
      throw new ProviderAuthError(
        this.key,
        'no_eligible_account',
        'no Business Profile location readable with this grant',
      );
    return targets;
  }

  private listingRefused(res: ProviderResponse): ProviderAuthError {
    const cls = this.classifyError({ status: res.status, body: res.body, phase: 'after_send' });
    return new ProviderAuthError(
      this.key,
      'identity_failed',
      cls.kind === 'rejected' && cls.code === SOURCE_ACCESS_REQUIRED
        ? `Business Profile API access required for this deployment: ${summarise(res)}`
        : summarise(res),
    );
  }

  /**
   * One report over the whole range in one `fetchMultiDailyMetricsTimeSeries` call (the API pages nothing, so a
   * page token is never issued): the day's metrics by name, the four impression surfaces summed into
   * `impressions` for `gbp.performance` and split by surface for `gbp.surfaces`. A day the API reports no value
   * for is absent, never zero.
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
    // request.pageToken is unused: the Performance API answers the whole range in one response and pages nothing.
    const bySurface = spec.dimensions.includes('surface');
    const dailyMetrics = bySurface
      ? Object.keys(GBP_IMPRESSION_METRICS)
      : [...Object.keys(GBP_IMPRESSION_METRICS), ...Object.keys(GBP_ACTION_METRICS)];
    const u = new URL(`${GBP_PERFORMANCE_API}/${request.externalId}:fetchMultiDailyMetricsTimeSeries`);
    for (const metric of dailyMetrics) u.searchParams.append('dailyMetrics', metric);
    const [startYear, startMonth, startDay] = request.dateRange.start.split('-');
    const [endYear, endMonth, endDay] = request.dateRange.end.split('-');
    u.searchParams.set('dailyRange.start_date.year', String(Number(startYear)));
    u.searchParams.set('dailyRange.start_date.month', String(Number(startMonth)));
    u.searchParams.set('dailyRange.start_date.day', String(Number(startDay)));
    u.searchParams.set('dailyRange.end_date.year', String(Number(endYear)));
    u.searchParams.set('dailyRange.end_date.month', String(Number(endMonth)));
    u.searchParams.set('dailyRange.end_date.day', String(Number(endDay)));
    const res = await googleGet(io, u.toString(), credentials.accessToken);
    if (res.status !== 200) throw sourceReadError(this.key, (i) => this.classifyError(i), res);
    // date → (API metric → value), in the order the days first appear.
    const days = new Map<string, Map<string, number>>();
    for (const multi of arr(get(res.json, 'multiDailyMetricTimeSeries')))
      for (const series of arr(get(multi, 'dailyMetricTimeSeries'))) {
        const metric = str(get(series, 'dailyMetric'));
        if (!metric) continue;
        for (const dated of arr(get(get(series, 'timeSeries'), 'datedValues'))) {
          const date = gbpDate(get(dated, 'date'));
          const value = num(get(dated, 'value'));
          if (!date || value === undefined) continue; // a day without a value is no row, never a zero
          let values = days.get(date);
          if (!values) days.set(date, (values = new Map()));
          values.set(metric, value);
        }
      }
    const rows: SourceReportRow[] = [];
    for (const [date, values] of [...days.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (bySurface) {
        for (const [apiMetric, surface] of Object.entries(GBP_IMPRESSION_METRICS)) {
          const impressions = values.get(apiMetric);
          if (impressions !== undefined)
            rows.push({ date, dimensions: { surface }, metrics: { impressions } });
        }
        continue;
      }
      const metrics: Record<string, number> = {};
      let impressions: number | undefined;
      for (const apiMetric of Object.keys(GBP_IMPRESSION_METRICS)) {
        const value = values.get(apiMetric);
        if (value !== undefined) impressions = (impressions ?? 0) + value;
      }
      if (impressions !== undefined) metrics['impressions'] = impressions;
      for (const [apiMetric, name] of Object.entries(GBP_ACTION_METRICS)) {
        const value = values.get(apiMetric);
        if (value !== undefined) metrics[name] = value;
      }
      if (Object.keys(metrics).length > 0) rows.push({ date, dimensions: {}, metrics });
    }
    return { rows, nextPageToken: null };
  }

  /**
   * Read-only APIs: a 429 (the project's low quota) refused the read before any effect, so it is rate limited
   * whatever the phase; a 403 that says the API is not enabled or approved for the project is `rejected` with
   * code access_required (the grant is intact: degraded with the reason, no reconnect, no tight retry); any other
   * 403 is the grant being refused (reconnect).
   */
  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass {
    if (input.status === 429) return { kind: 'rate_limited', phase: 'before_send' };
    if (input.status === 403 && accessRequired(input.body))
      return { kind: 'rejected', code: SOURCE_ACCESS_REQUIRED };
    return classifyByStatus(input);
  }
}

/** A 403 whose JSON names one of the structured reasons under a PERMISSION_DENIED status; anything else is not. */
const accessRequired = (body: string | undefined): boolean => {
  if (!body) return false;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return false;
  }
  const error = get(json, 'error');
  if (str(get(error, 'status')) !== 'PERMISSION_DENIED') return false;
  const reasons = [...arr(get(error, 'details')), ...arr(get(error, 'errors'))].map((d) =>
    str(get(d, 'reason')),
  );
  return reasons.some((reason) => reason !== undefined && ACCESS_REQUIRED_REASONS.has(reason));
};

/** The API's `google.type.Date` ({year, month, day}) as an ISO day; anything incomplete is not a day. */
const gbpDate = (value: unknown): string | undefined => {
  const year = num(get(value, 'year'));
  const month = num(get(value, 'month'));
  const day = num(get(value, 'day'));
  if (!year || !month || !day) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** A storefront address as the listing shows it: the first address line and the locality (never the full address). */
const addressSummary = (address: unknown): string | undefined => {
  const parts = [str(arr(get(address, 'addressLines'))[0]), str(get(address, 'locality'))].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length > 0 ? parts.join(', ') : undefined;
};

export const gbpLocationAdapter = new GbpLocationAdapter();
