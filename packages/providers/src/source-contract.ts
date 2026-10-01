import type { DestinationKind } from '@oremedia/contracts/destinations';
import type {
  ClientConfig,
  DecryptedCredentials,
  ProviderCapabilityV1,
  ProviderErrorClass,
  RefreshResult,
} from '@oremedia/contracts/providers';
import type { ProviderIO } from './io';

/**
 * Ledger R2-1: the read-only source adapter contract behind a brand destination (an analytics property, a Search
 * Console site). A source adapter authorises a grant, lists the targets it can read and refreshes its token; it
 * publishes nothing, so it carries none of ProviderAdapter's publishing surface. Credentials are passed in
 * explicitly (never a DB row), every outbound call goes through ProviderIO (SSRF-safe, rate-limited, logged) and
 * errors are classified the same way (spec 14.5). Certification gates tenant use exactly as for channels (14.6).
 */
export interface SourceCapabilityV1 {
  key: DestinationKind;
  version: number;
  /** The platform the person authorises at, as the settings screen names it ("Google"). */
  vendor: string;
  /** The OAuth scopes the grant must carry for the source to be readable. */
  requiredScopes: string[];
  /** How long the platform takes to make a day's data final (reports and ingestion read behind this). */
  latencyHours: number;
  rateLimits: ProviderCapabilityV1['rateLimits'];
  /** The reports the source can read (part B); empty for a source that only authorises and lists targets. */
  reports: SourceReportSpec[];
  certifiedAt: string | null;
}

/**
 * One report a source adapter can read (R2-1 part B): its key is `<prefix>.<name>` (`ga4.acquisition`,
 * `gsc.queries`), the prefix naming the data type a source-use policy covers (`ga4.reports`). The date dimension is
 * always present; `dimensions` lists the others, `metrics` the platform's metric names as the rows carry them.
 * `latencyHours` is how far behind a day's figures become final (the sweep re-reads that far back) and
 * `maxRangeDays` the longest range one run asks for (quota-aware, bounded work).
 */
export interface SourceReportSpec {
  key: string;
  dimensions: string[];
  metrics: string[];
  latencyHours: number;
  maxRangeDays: number;
}

/** One row of a report: the UTC day, the dimension values by name and the metric values by name. */
export interface SourceReportRow {
  date: string;
  dimensions: Record<string, string>;
  metrics: Record<string, number>;
}

export interface SourceReportRequest {
  externalId: string;
  report: string;
  /** Inclusive ISO dates (YYYY-MM-DD). */
  dateRange: { start: string; end: string };
  pageToken?: string;
}

export interface SourceReportPage {
  rows: SourceReportRow[];
  nextPageToken: string | null;
}

/** What a code exchange yields: the sealed-to-be credentials and the scopes the person actually granted. */
export interface SourceGrant {
  credentials: DecryptedCredentials;
  grantedScopes: string[];
}

/** One remote thing the grant can read, in the form the destination's externalId takes (`properties/<id>`, a site URL). */
export interface SourceTarget {
  externalId: string;
  displayName: string;
}

export interface SourceAdapter {
  readonly key: DestinationKind;
  readonly capability: SourceCapabilityV1;

  /** Must request offline access and consent, so a refresh token is issued on every connect. */
  authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    client: ClientConfig;
  }): Promise<{ url: string }>;
  exchangeCode(
    input: { code: string; codeVerifier: string; redirectUri: string; client: ClientConfig },
    io: ProviderIO,
  ): Promise<SourceGrant>;
  refresh(credentials: DecryptedCredentials, client: ClientConfig, io: ProviderIO): Promise<RefreshResult>;
  /** Every target the grant can read, for the person to choose among (the connect flow's choice). */
  listTargets(
    credentials: DecryptedCredentials,
    client: ClientConfig,
    io: ProviderIO,
  ): Promise<SourceTarget[]>;
  /**
   * One page of one report for a target the grant can read (part B). A platform refusal is thrown as a
   * SourceReadError carrying the adapter's classification (a 401 refresh, a 403 reconnect, a 429 rate limited); a
   * transport failure propagates as ProviderTransportError. Rows are never invented: a day the platform did not
   * return is absent.
   */
  fetchReport(
    credentials: DecryptedCredentials,
    client: ClientConfig,
    io: ProviderIO,
    request: SourceReportRequest,
  ): Promise<SourceReportPage>;

  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass;
}
