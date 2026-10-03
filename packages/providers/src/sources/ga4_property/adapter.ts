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
import type { SourceReportQualityFlag, SourceTargetMetadataV1 } from '@oremedia/contracts/destinations';
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
import { ga4PropertyCapability } from './capability';

export const GA4_ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
export const GA4_DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
/**
 * runReport rows per call: one call covers a report's whole range in the common case (a quota-friendly single
 * call per report and day range); longer results page by offset, which the page token carries.
 */
export const GA4_REPORT_PAGE_LIMIT = 10_000;
/** accountSummaries pages: 200 per request (the API's maximum), at most 10 pages per listing. */
const SUMMARY_PAGE_SIZE = 200;
const SUMMARY_MAX_PAGES = 10;

/**
 * GA4 property source adapter (ledger R2-1 part A): Google OAuth with offline access, the properties the person
 * can read from the Analytics Admin API's account summaries (`properties/<id>`, the externalId form the Data API
 * reports of part B are keyed by). Read-only: it writes nothing anywhere.
 */
export class Ga4PropertyAdapter implements SourceAdapter {
  readonly key = 'ga4_property' as const;
  readonly capability = ga4PropertyCapability;

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

  /** Every property of every account the grant can see, account by account as the summaries list them. */
  async listTargets(credentials: DecryptedCredentials, _client: ClientConfig, io: ProviderIO) {
    const targets: SourceTarget[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < SUMMARY_MAX_PAGES; page++) {
      const u = new URL(`${GA4_ADMIN_API}/accountSummaries`);
      u.searchParams.set('pageSize', String(SUMMARY_PAGE_SIZE));
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const res = await googleGet(io, u.toString(), credentials.accessToken);
      if (res.status !== 200) throw new ProviderAuthError(this.key, 'identity_failed', summarise(res));
      for (const account of arr(get(res.json, 'accountSummaries'))) {
        const accountName = str(get(account, 'displayName'));
        for (const property of arr(get(account, 'propertySummaries'))) {
          const externalId = str(get(property, 'property'));
          if (!externalId) continue;
          const name = str(get(property, 'displayName')) ?? externalId;
          targets.push({ externalId, displayName: accountName ? `${accountName} · ${name}` : name });
        }
      }
      pageToken = str(get(res.json, 'nextPageToken'));
      if (!pageToken) break;
    }
    if (targets.length === 0)
      throw new ProviderAuthError(
        this.key,
        'no_eligible_account',
        'no GA4 property readable with this grant',
      );
    return targets;
  }

  /**
   * RA-10: the property's own reporting zone and currency from the Admin API's property resource (`timeZone`,
   * `currencyCode`: the same metadata call pattern as the account summaries, one GET, read-only). The Data API
   * keys every `date` by this zone, so the sweep plans and stores days in it.
   */
  async describeTarget(
    credentials: DecryptedCredentials,
    _client: ClientConfig,
    io: ProviderIO,
    externalId: string,
  ): Promise<SourceTargetMetadataV1> {
    const res = await googleGet(io, `${GA4_ADMIN_API}/${externalId}`, credentials.accessToken);
    if (res.status !== 200) throw sourceReadError(this.key, (i) => this.classifyError(i), res);
    return {
      reportingTimeZone: str(get(res.json, 'timeZone')) ?? null,
      currencyCode: str(get(res.json, 'currencyCode')) ?? null,
    };
  }

  /**
   * One page of a Data API report: `runReport` with the date dimension first, the spec's dimensions and metrics,
   * paged by offset. A GA4 date comes back as YYYYMMDD (the property's local day) and leaves here as an ISO
   * date, with the response metadata's zone, currency and quality (RA-10) beside the rows.
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
    const offset = request.pageToken ? Number(request.pageToken) : 0;
    const res = await googlePost(
      io,
      `${GA4_DATA_API}/${request.externalId}:runReport`,
      credentials.accessToken,
      {
        dateRanges: [{ startDate: request.dateRange.start, endDate: request.dateRange.end }],
        dimensions: ['date', ...spec.dimensions].map((name) => ({ name })),
        metrics: spec.metrics.map(({ name }) => ({ name })),
        limit: GA4_REPORT_PAGE_LIMIT,
        offset,
        keepEmptyRows: false,
      },
    );
    if (res.status !== 200) throw sourceReadError(this.key, (i) => this.classifyError(i), res);
    const dimensionNames = arr(get(res.json, 'dimensionHeaders')).map((h) => str(get(h, 'name')) ?? '');
    const metricNames = arr(get(res.json, 'metricHeaders')).map((h) => str(get(h, 'name')) ?? '');
    const rows: SourceReportRow[] = [];
    for (const row of arr(get(res.json, 'rows'))) {
      const dimensionValues = arr(get(row, 'dimensionValues')).map((v) => str(get(v, 'value')) ?? '');
      const metricValues = arr(get(row, 'metricValues')).map((v) => num(get(v, 'value')));
      const date = ga4Date(dimensionValues[dimensionNames.indexOf('date')]);
      if (!date) continue; // a row without its day cannot be stored by day
      const dimensions: Record<string, string> = {};
      for (const name of spec.dimensions)
        dimensions[name] = dimensionValues[dimensionNames.indexOf(name)] ?? '';
      const metrics: Record<string, number> = {};
      for (const { name } of spec.metrics) {
        const value = metricValues[metricNames.indexOf(name)];
        if (value !== undefined) metrics[name] = value; // a metric the API left out is absent, never zero
      }
      rows.push({ date, dimensions, metrics });
    }
    const rowCount = num(get(res.json, 'rowCount')) ?? 0;
    const next = offset + rows.length;
    const metadata = get(res.json, 'metadata');
    return {
      rows,
      nextPageToken: rows.length > 0 && next < rowCount ? String(next) : null,
      reportingTimeZone: str(get(metadata, 'timeZone')) ?? null,
      currencyCode: str(get(metadata, 'currencyCode')) ?? null,
      quality: ga4Quality(metadata),
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

/**
 * The quality the Data API states in `ResponseMetaData` (RA-10): `samplingMetadatas` with fewer samples read
 * than the sampling space means a sampled answer, `subjectToThresholding` that rows were withheld, and
 * `dataLossFromOtherRow` that rows were folded into "(other)". Nothing is inferred beyond what the answer says.
 */
const ga4Quality = (metadata: unknown): SourceReportQualityFlag[] => {
  const flags: SourceReportQualityFlag[] = [];
  const sampled = arr(get(metadata, 'samplingMetadatas')).some((m) => {
    const read = num(get(m, 'samplesReadCount'));
    const space = num(get(m, 'samplingSpaceSize'));
    return read !== undefined && space !== undefined && read < space;
  });
  if (sampled) flags.push('sampled');
  if (get(metadata, 'subjectToThresholding') === true) flags.push('thresholded');
  if (get(metadata, 'dataLossFromOtherRow') === true) flags.push('data_loss');
  return flags;
};

/** GA4's date dimension is `YYYYMMDD`; anything else is not a day. */
const ga4Date = (value: string | undefined): string | undefined =>
  value && /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : undefined;

export const ga4PropertyAdapter = new Ga4PropertyAdapter();
