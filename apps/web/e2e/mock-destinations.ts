import { randomUUID } from 'node:crypto';
import {
  DestinationConnectCancel,
  DestinationConnectComplete,
  DestinationConnectSelect,
  DestinationConnectStart,
  DestinationConnectWithSecret,
  DestinationDisconnect,
  DestinationGet,
  DestinationList,
  DestinationRegister,
  DestinationReportOpportunities,
  DestinationReportRows,
  DestinationReportSummary,
  DestinationSetArticleSelector,
  DestinationSetHealth,
  OPPORTUNITY_RATE_FRACTION,
  OPPORTUNITY_WINDOW_DAYS,
  SourceUseCheck,
  SourceUsePolicyList,
  SourceUsePolicySet,
  reportDataType,
  reportPrimaryMetric,
  sourceUseIssues,
  webMetricSums,
  webMetricValues,
  type DestinationConnectTarget,
  type DestinationReportOpportunityKind,
  type DestinationReportOpportunityV1,
  type DestinationReportPresentationV1,
  type DestinationReportRowV1,
  type DestinationReportSummaryEntryV1,
  type DestinationReportSummaryV1,
  type DestinationSourceV1,
  type DestinationV1,
  type SourceReportMetricV1,
  type SourceUseCheckResult,
  type SourceUsePolicyV1,
} from '@oremedia/contracts/destinations';
import {
  SEO_AUDIT_DATA_NOTE,
  SeoAuditFindings,
  SeoAuditPagesList,
  SeoAuditRun,
  SeoAuditRunsList,
  SeoAuditSummary,
  type SeoAuditFindingV1,
  type SeoAuditPageV1,
  type SeoAuditRunV1,
  type SeoAuditSummaryV1,
  SeoAuditCreateWork,
  seoFindingId,
  type SeoFindingWorkV1,
} from '@oremedia/contracts/seo-audit';
import {
  CapabilityUnsupportedError,
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import { COMPARISON_MINIMUM_SAMPLE } from '@oremedia/contracts/measurement';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import type { MockBuilders, t } from './mock-api';

/**
 * Brand destinations slice of the UI-only transport (see mock-api.ts): destinations.list/get/register/setHealth/
 * setArticleSelector/disconnect, destinations.sourceUse.list/set/check, (R2-1) destinations.sources.list and
 * destinations.connect.start/complete/select/cancel, and (R2-1 part B) destinations.reports.summary/rows/
 * opportunities over seeded report rows, with the same paths, DTO shapes, role gates, dictionary rules (the
 * contracts' webMetricSums / webMetricValues) and error envelope as apps/api (packages/modules/destinations).
 * A test double, never a second implementation.
 */
export const PD = {
  destinations: { ga4: 'dst_e2e_ga4', gbp: 'dst_e2e_gbp', gsc: 'dst_e2e_gsc', cms: 'dst_e2e_cms' },
  policies: {
    ga4Reports: 'sup_e2e_ga4_reports',
    gbpReviews: 'sup_e2e_gbp_reviews',
    gbpReports: 'sup_e2e_gbp_reports',
    cmsAudit: 'sup_e2e_cms_audit',
  },
  auditRun: 'sar_e2e_1',
  /** What a completed grant can read (connect.complete offers both; the person confirms one). */
  targets: [
    { externalId: 'properties/9001', displayName: 'Acme · Acme web (new)' },
    { externalId: 'properties/9002', displayName: 'Acme · Acme app' },
  ] as readonly DestinationConnectTarget[],
} as const;

/**
 * The deployment's sources: GA4 certified and enabled; Search Console registered but not enabled here; the
 * Business Profile location (R2-2) registered, uncertified and off (OREMEDIA_ENABLE_GBP unset), so the settings
 * screen does not offer it while the Performance screen still reads a connected location.
 */
const SOURCES: readonly DestinationSourceV1[] = [
  {
    kind: 'ga4_property',
    label: 'Google Analytics 4 property',
    vendor: 'Google',
    certified: true,
    enabled: true,
  },
  {
    kind: 'search_console_site',
    label: 'Search Console site',
    vendor: 'Google',
    certified: false,
    enabled: false,
  },
  {
    kind: 'gbp_location',
    label: 'Google Business Profile location',
    vendor: 'Google',
    certified: false,
    enabled: false,
  },
  // R2-3: the website CMS, connected with a site address and an application password (D-16).
  {
    kind: 'cms_site',
    label: 'Website CMS',
    vendor: 'WordPress',
    certified: true,
    enabled: true,
    connect: 'secret',
    credential: {
      label: 'Application password',
      hint: 'Created under the site user’s profile (Users → Profile → Application Passwords); the user needs the editor or administrator role.',
    },
  },
];

/** Spec 5.5 default grants of destination.connect / destination.manage and source_use.manage. */
/** RA-01: the kinds whose adapter revokes the grant at the platform on disconnect (the others are shredded at once). */
const REMOTE_REVOKE_KINDS: ReadonlySet<string> = new Set([
  'ga4_property',
  'search_console_site',
  'gbp_location',
  'cms_site',
]);
const CONNECTORS: ReadonlySet<MembershipRole> = new Set(['owner', 'admin', 'publisher']);
/** insight.manage (RA-11 create work): managers and analysts. */
const WORK_CREATORS: ReadonlySet<MembershipRole> = new Set(['owner', 'admin', 'brand_manager', 'analyst']);
const POLICY_MANAGERS: ReadonlySet<MembershipRole> = new Set(['owner', 'admin']);

const now = () => new Date().toISOString();
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const DAY_MS = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) =>
  dayKey(new Date(Date.parse(`${date}T00:00:00.000Z`) + n * DAY_MS));

/**
 * The report specs the adapters declare (packages/providers/src/sources/<kind>/capability.ts) in the descriptor
 * shape the summary carries, as the mock knows them (apps/web may not import the providers package).
 */
interface MockReportSpec {
  key: string;
  label: string;
  dimensions: string[];
  dimensionLabels: Record<string, string>;
  metrics: SourceReportMetricV1[];
  derived: SourceReportMetricV1[];
  latencyHours: number;
  opportunity?: {
    kind: DestinationReportOpportunityKind;
    rateMetric: string;
    volumeMetric: string;
    minVolume: number;
    task(input: { subject: string; volume: number; rate: number; benchmark: number }): string;
  };
}
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const GA4_METRIC: Record<string, SourceReportMetricV1> = {
  sessions: { name: 'sessions', label: 'Sessions', kind: 'flow' },
  totalUsers: { name: 'totalUsers', label: 'Users (daily, summed)', kind: 'flow' },
  engagedSessions: { name: 'engagedSessions', label: 'Engaged sessions', kind: 'flow' },
  keyEvents: { name: 'keyEvents', label: 'Key events', kind: 'flow' },
  averageSessionDuration: {
    name: 'averageSessionDuration',
    label: 'Avg. session duration (s)',
    kind: 'gauge',
    weight: 'sessions',
  },
};
const ENGAGEMENT_RATE: SourceReportMetricV1 = {
  name: 'engagementRate',
  label: 'Engagement rate',
  kind: 'rate',
  numerator: 'engagedSessions',
  denominator: 'sessions',
};
const ga4 = (...names: string[]) => names.map((n) => GA4_METRIC[n] as SourceReportMetricV1);
const GSC_METRICS: SourceReportMetricV1[] = [
  { name: 'clicks', label: 'Clicks', kind: 'flow' },
  { name: 'impressions', label: 'Impressions', kind: 'flow' },
  { name: 'ctr', label: 'CTR', kind: 'rate', numerator: 'clicks', denominator: 'impressions' },
  { name: 'position', label: 'Position', kind: 'gauge', weight: 'impressions' },
];
const lowCtr = (
  kind: DestinationReportOpportunityKind,
  what: (subject: string) => string,
): MockReportSpec['opportunity'] => ({
  kind,
  rateMetric: 'ctr',
  volumeMetric: 'impressions',
  minVolume: 100,
  task: ({ subject, volume, rate, benchmark }) =>
    `Rewrite the title and description of ${what(subject)} (${volume} impressions, CTR ${pct(rate)} against ${pct(benchmark)} for the site)`,
});
const GBP_METRIC: Record<string, SourceReportMetricV1> = {
  impressions: { name: 'impressions', label: 'Impressions', kind: 'flow' },
  websiteClicks: { name: 'websiteClicks', label: 'Website clicks', kind: 'flow' },
  callClicks: { name: 'callClicks', label: 'Calls', kind: 'flow' },
  directionRequests: { name: 'directionRequests', label: 'Direction requests', kind: 'flow' },
  conversations: { name: 'conversations', label: 'Conversations', kind: 'flow' },
  bookings: { name: 'bookings', label: 'Bookings', kind: 'flow' },
};
const gbp = (...names: string[]) => names.map((n) => GBP_METRIC[n] as SourceReportMetricV1);
const WEBSITE_CLICK_RATE: SourceReportMetricV1 = {
  name: 'websiteClickRate',
  label: 'Website click rate',
  kind: 'rate',
  numerator: 'websiteClicks',
  denominator: 'impressions',
};
const REPORTS: Readonly<Record<string, MockReportSpec[]>> = {
  ga4_property: [
    {
      key: 'ga4.acquisition',
      label: 'Acquisition channels',
      dimensions: ['sessionDefaultChannelGroup'],
      dimensionLabels: { sessionDefaultChannelGroup: 'Channel' },
      metrics: ga4('sessions', 'totalUsers', 'engagedSessions', 'keyEvents'),
      derived: [ENGAGEMENT_RATE],
      latencyHours: 48,
    },
    {
      key: 'ga4.landing_pages',
      label: 'Landing pages',
      dimensions: ['landingPage'],
      dimensionLabels: { landingPage: 'Landing page' },
      metrics: ga4('sessions', 'engagedSessions', 'keyEvents'),
      derived: [ENGAGEMENT_RATE],
      latencyHours: 48,
      opportunity: {
        kind: 'low_engagement_page',
        rateMetric: 'engagementRate',
        volumeMetric: 'sessions',
        minVolume: 50,
        task: ({ subject, volume, rate, benchmark }) =>
          `Review the content and next step on landing page ${subject} (${volume} sessions, engagement rate ${pct(rate)} against ${pct(benchmark)} for the property)`,
      },
    },
    {
      key: 'ga4.engagement',
      label: 'Engagement',
      dimensions: [],
      dimensionLabels: {},
      metrics: ga4('sessions', 'engagedSessions', 'averageSessionDuration', 'keyEvents', 'totalUsers'),
      derived: [ENGAGEMENT_RATE],
      latencyHours: 48,
    },
  ],
  search_console_site: [
    {
      key: 'gsc.queries',
      label: 'Queries',
      dimensions: ['query'],
      dimensionLabels: { query: 'Query' },
      metrics: GSC_METRICS,
      derived: [],
      latencyHours: 72,
      opportunity: lowCtr('low_ctr_query', (subject) => `the page ranking for "${subject}"`),
    },
    {
      key: 'gsc.pages',
      label: 'Pages',
      dimensions: ['page'],
      dimensionLabels: { page: 'Page' },
      metrics: GSC_METRICS,
      derived: [],
      latencyHours: 72,
      opportunity: lowCtr('low_ctr_page', (subject) => subject),
    },
    {
      key: 'gsc.countries_devices',
      label: 'Countries and devices',
      dimensions: ['country', 'device'],
      dimensionLabels: { country: 'Country', device: 'Device' },
      metrics: GSC_METRICS,
      derived: [],
      latencyHours: 72,
    },
  ],
  // R2-2: a destination is one location, so the performance report carries the day alone; no opportunity rule.
  gbp_location: [
    {
      key: 'gbp.performance',
      label: 'Profile performance',
      dimensions: [],
      dimensionLabels: {},
      metrics: gbp(
        'impressions',
        'websiteClicks',
        'callClicks',
        'directionRequests',
        'conversations',
        'bookings',
      ),
      derived: [WEBSITE_CLICK_RATE],
      latencyHours: 120,
    },
    {
      key: 'gbp.surfaces',
      label: 'Impressions by surface',
      dimensions: ['surface'],
      dimensionLabels: { surface: 'Surface' },
      metrics: gbp('impressions'),
      derived: [],
      latencyHours: 120,
    },
  ],
};
const PRESENTATION: Readonly<Record<string, DestinationReportPresentationV1>> = {
  ga4_property: {
    console: { label: 'Google Analytics', href: 'https://analytics.google.com/' },
    tiles: {
      reportKey: 'ga4.engagement',
      metrics: ['sessions', 'engagedSessions', 'keyEvents', 'engagementRate'],
    },
  },
  search_console_site: {
    console: { label: 'Search Console', href: 'https://search.google.com/search-console' },
    tiles: { reportKey: 'gsc.countries_devices', metrics: ['clicks', 'impressions', 'ctr', 'position'] },
  },
  gbp_location: {
    console: { label: 'Google Business Profile', href: 'https://business.google.com/' },
    tiles: {
      reportKey: 'gbp.performance',
      metrics: ['impressions', 'websiteClicks', 'callClicks', 'directionRequests'],
    },
  },
};

export interface SeededReportRow {
  destinationId: string;
  reportKey: string;
  date: string;
  dimensions: Record<string, string>;
  metrics: Record<string, number>;
}

/**
 * The GA4 property's last 20 days (to yesterday): three acquisition channels, three landing pages (of which
 * /pricing engages a tenth of its sessions against the property's near-half) and the day's engagement; the Search
 * Console site's last 20 days of queries, pages and countries; the Business Profile location's last 20 days of
 * performance (150 impressions, 6 website clicks, 3 calls, 4 direction requests a day) and the impressions by
 * surface (R2-2). A 7-day period therefore compares against a full previous week; a 30-day period has no previous
 * days and reads "insufficient sample".
 */
function seededReportRows(ga4Id: string, gscId: string, gbpId: string): SeededReportRow[] {
  const rows: SeededReportRow[] = [];
  const yesterday = addDays(dayKey(new Date()), -1);
  for (let i = -19; i <= 0; i++) {
    const date = addDays(yesterday, i);
    const wobble = ((i % 5) + 5) % 5;
    for (const [channel, sessions, users, engaged, keyEvents] of [
      ['Organic Search', 60 + wobble, 50, 35, 2],
      ['Direct', 30, 25, 12, 1],
      ['Organic Social', 10, 9, 1, 0],
    ] as const)
      rows.push({
        destinationId: ga4Id,
        reportKey: 'ga4.acquisition',
        date,
        dimensions: { sessionDefaultChannelGroup: channel },
        metrics: { sessions, totalUsers: users, engagedSessions: engaged, keyEvents },
      });
    for (const [page, sessions, engaged, keyEvents] of [
      ['/', 70 + wobble, 40, 2],
      ['/pricing', 20, 2, 0],
      ['/blog', 10, 6, 1],
    ] as const)
      rows.push({
        destinationId: ga4Id,
        reportKey: 'ga4.landing_pages',
        date,
        dimensions: { landingPage: page },
        metrics: { sessions, engagedSessions: engaged, keyEvents },
      });
    rows.push({
      destinationId: ga4Id,
      reportKey: 'ga4.engagement',
      date,
      dimensions: {},
      metrics: {
        sessions: 100 + wobble,
        engagedSessions: 48,
        averageSessionDuration: 62.5,
        keyEvents: 3,
        totalUsers: 84,
      },
    });
    for (const [query, clicks, impressions, position] of [
      ['acme login', 30, 100, 1.2],
      ['acme pricing', 2, 200, 8.4],
    ] as const)
      rows.push({
        destinationId: gscId,
        reportKey: 'gsc.queries',
        date,
        dimensions: { query },
        metrics: { clicks, impressions, ctr: clicks / impressions, position },
      });
    rows.push({
      destinationId: gscId,
      reportKey: 'gsc.pages',
      date,
      dimensions: { page: 'https://acme.example/pricing' },
      metrics: { clicks: 2, impressions: 200, ctr: 0.01, position: 8.4 },
    });
    rows.push({
      destinationId: gscId,
      reportKey: 'gsc.countries_devices',
      date,
      dimensions: { country: 'zwe', device: 'MOBILE' },
      metrics: { clicks: 32, impressions: 300, ctr: 32 / 300, position: 4 },
    });
    rows.push({
      destinationId: gbpId,
      reportKey: 'gbp.performance',
      date,
      dimensions: {},
      metrics: { impressions: 150, websiteClicks: 6, callClicks: 3, directionRequests: 4 },
    });
    for (const [surface, impressions] of [
      ['mobile_search', 75],
      ['desktop_search', 40],
      ['mobile_maps', 25],
      ['desktop_maps', 10],
    ] as const)
      rows.push({
        destinationId: gbpId,
        reportKey: 'gbp.surfaces',
        date,
        dimensions: { surface },
        metrics: { impressions },
      });
  }
  return rows;
}

export class DestinationsBackend {
  readonly destinations: DestinationV1[] = [];
  readonly policies: SourceUsePolicyV1[] = [];
  /** connect.start's states (spec 14.7 pattern), consumed once by connect.complete. */
  readonly connectStates = new Map<string, { brandId: string; kind: DestinationV1['kind'] }>();
  /** The flows connect.complete offered (one-shot), keyed by pending id. */
  readonly connectChoices = new Map<
    string,
    { brandId: string; kind: DestinationV1['kind']; targets: DestinationConnectTarget[] }
  >();
  /** R2-1 part B: what the daily sweep would have stored (seeded for the GA4 property and the Search Console site). */
  readonly reportRows: SeededReportRow[] = [];
  /** R2-4: the website's last audit (one finished run with its pages); `run` opens a second, left running. */
  readonly auditRuns: SeoAuditRunV1[] = [];
  readonly auditPages: SeoAuditPageV1[] = [];
  /** RA-11: the work findings were turned into (one open row per check), as the API's link table holds it. */
  readonly findingWork: SeoFindingWorkV1[] = [];

  constructor(
    readonly brandId: string,
    readonly role: () => MembershipRole,
    seed = true,
  ) {
    if (!seed) return;
    const at = '2026-09-20T09:00:00.000Z';
    this.destinations.push(
      {
        id: PD.destinations.ga4,
        brandId,
        kind: 'ga4_property',
        externalId: 'properties/424242',
        displayName: 'Acme web',
        ownerUserId: 'usr_e2e',
        grantedScopes: ['analytics.readonly'],
        health: 'healthy',
        healthCheckedAt: '2026-09-30T06:00:00.000Z',
        capabilityVersion: 1,
        status: 'active',
        reportingTimeZone: 'Africa/Johannesburg',
        currencyCode: 'ZAR',
        writeSafety: 'unknown',
        writeSafetyCheckedAt: null,
        articleSelector: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: PD.destinations.gsc,
        brandId,
        kind: 'search_console_site',
        externalId: 'https://acme.example/',
        displayName: 'Acme site',
        ownerUserId: 'usr_e2e',
        grantedScopes: ['webmasters.readonly'],
        health: 'healthy',
        healthCheckedAt: '2026-09-30T06:00:00.000Z',
        capabilityVersion: 1,
        status: 'active',
        reportingTimeZone: null,
        currencyCode: null,
        writeSafety: 'unknown',
        writeSafetyCheckedAt: null,
        articleSelector: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: PD.destinations.cms,
        brandId,
        kind: 'cms_site',
        externalId: 'https://acme.example',
        displayName: 'acme.example',
        ownerUserId: 'usr_e2e',
        grantedScopes: ['articles:write'],
        health: 'healthy',
        healthCheckedAt: '2026-09-30T06:00:00.000Z',
        capabilityVersion: 1,
        status: 'active',
        reportingTimeZone: null,
        currencyCode: null,
        // PR-03: the site has no conditional-write plugin (the verification found it in limited mode).
        writeSafety: 'limited',
        writeSafetyCheckedAt: '2026-09-30T06:00:00.000Z',
        articleSelector: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: PD.destinations.gbp,
        brandId,
        kind: 'gbp_location',
        externalId: 'locations/777',
        displayName: 'Acme Harare',
        ownerUserId: 'usr_e2e',
        grantedScopes: [],
        health: 'unknown',
        healthCheckedAt: null,
        capabilityVersion: 1,
        status: 'active',
        reportingTimeZone: null,
        currencyCode: null,
        writeSafety: 'unknown',
        writeSafetyCheckedAt: null,
        articleSelector: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      },
    );
    this.policies.push(
      {
        id: PD.policies.ga4Reports,
        brandId,
        destinationKind: 'ga4_property',
        dataType: 'ga4.reports',
        allowedUses: ['read'],
        retentionDays: null,
        version: 1,
        reviewedAt: at,
        reviewDueAt: inDays(60),
        reviewedById: 'usr_e2e',
        createdAt: at,
        updatedAt: at,
      },
      {
        id: PD.policies.gbpReviews,
        brandId,
        destinationKind: 'gbp_location',
        dataType: 'gbp.reviews',
        allowedUses: ['read'],
        retentionDays: null,
        version: 2,
        reviewedAt: at,
        reviewDueAt: inDays(30),
        reviewedById: 'usr_e2e',
        createdAt: at,
        updatedAt: at,
      },
      // R2-2: reads of the location's performance allowed (the kind offers no retention, D-17).
      {
        id: PD.policies.gbpReports,
        brandId,
        destinationKind: 'gbp_location',
        dataType: 'gbp.reports',
        allowedUses: ['read'],
        retentionDays: null,
        version: 1,
        reviewedAt: at,
        reviewDueAt: inDays(60),
        reviewedById: 'usr_e2e',
        createdAt: at,
        updatedAt: at,
      },
    );
    this.policies.push({
      id: PD.policies.cmsAudit,
      brandId,
      destinationKind: 'cms_site',
      dataType: 'cms.audit',
      allowedUses: ['read'],
      retentionDays: null,
      version: 1,
      reviewedAt: at,
      reviewDueAt: inDays(45),
      reviewedById: 'usr_e2e',
      createdAt: at,
      updatedAt: at,
    });
    // No policy for gsc.reports: the Search Console site's reads are refused until an admin sets one (D-17).
    this.reportRows.push(...seededReportRows(PD.destinations.ga4, PD.destinations.gsc, PD.destinations.gbp));
    this.auditRuns.push(seededAuditRun(brandId, PD.destinations.cms));
    this.auditPages.push(...seededAuditPages(PD.auditRun));
  }
}

const ORIGIN = 'https://acme.example';
const check = (
  key: string,
  ok: boolean,
  severity: 'critical' | 'major' | 'minor' | null = null,
  detail: string | null = null,
) => ({
  key: key as SeoAuditPageV1['checks'][number]['key'],
  ok,
  severity,
  detail,
});
/** The last weekly run of the website: 42 pages, two with issues, the depth cap hit. */
function seededAuditRun(brandId: string, destinationId: string): SeoAuditRunV1 {
  return {
    id: PD.auditRun,
    brandId,
    destinationId,
    origin: ORIGIN,
    trigger: 'scheduled',
    startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    finishedAt: new Date(Date.now() - 2 * 86_400_000 + 240_000).toISOString(),
    outcome: 'completed',
    reason: null,
    pagesCrawled: 42,
    limitsHit: ['max_depth'],
    summary: { critical: 1, major: 1, minor: 1, byCheck: { robots_meta: 1, broken_links: 2, title: 1 } },
  };
}
function seededAuditPages(runId: string): SeoAuditPageV1[] {
  const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const ok = (url: string): SeoAuditPageV1 => ({
    id: `sap_${url.replace(/\W/g, '')}`,
    runId,
    url,
    depth: 1,
    status: 200,
    bytes: 24_000,
    severity: 'ok',
    checks: [check('status', true), check('title', true)],
    fetchedAt: at,
  });
  return [
    {
      id: 'sap_e2e_home',
      runId,
      url: `${ORIGIN}/`,
      depth: 0,
      status: 200,
      bytes: 51_000,
      severity: 'major',
      checks: [check('status', true), check('title', true), check('broken_links', false, 'major', 'count=1')],
      fetchedAt: at,
    },
    {
      id: 'sap_e2e_old',
      runId,
      url: `${ORIGIN}/old-offer`,
      depth: 1,
      status: 200,
      bytes: 30_000,
      severity: 'critical',
      checks: [
        check('status', true),
        check('title', false, 'minor', 'length=68'),
        check('robots_meta', false, 'critical', 'noindex'),
        check('broken_links', false, 'major', 'count=1'),
      ],
      fetchedAt: at,
    },
    ok(`${ORIGIN}/about`),
    ok(`${ORIGIN}/contact`),
  ];
}
/** The findings of the seeded run, as the audit module's rule table words them (one per failing check). */
const seededFindings = (): SeoAuditFindingV1[] => [
  {
    findingId: seoFindingId(PD.auditRun, 'robots_meta'),
    status: 'open',
    work: null,
    check: 'robots_meta',
    label: 'Pages excluded by robots meta',
    severity: 'critical',
    count: 1,
    examples: [`${ORIGIN}/old-offer`],
    suggestedTask:
      'Confirm 1 page should carry noindex or nofollow; remove the directive where they should rank.',
  },
  {
    findingId: seoFindingId(PD.auditRun, 'broken_links'),
    status: 'open',
    work: null,
    check: 'broken_links',
    label: 'Broken internal links',
    severity: 'major',
    count: 2,
    examples: [`${ORIGIN}/`, `${ORIGIN}/old-offer`],
    suggestedTask: 'Fix or remove the internal links on 2 pages that lead to pages answering with an error.',
  },
  {
    findingId: seoFindingId(PD.auditRun, 'title'),
    status: 'open',
    work: null,
    check: 'title',
    label: 'Missing or long titles',
    severity: 'minor',
    count: 1,
    examples: [`${ORIGIN}/old-offer`],
    suggestedTask:
      'Write a unique title of 60 characters or fewer for 1 page whose title is missing or too long.',
  },
];

export interface DestinationsBuilders {
  router: typeof t.router;
  query: MockBuilders['query'];
  mutation: MockBuilders['mutation'];
}

export function destinationsRouters(
  b: DestinationsBackend,
  { router, query, mutation }: DestinationsBuilders,
) {
  const brandOf = (brandId: string) => {
    if (brandId !== b.brandId) throw new NotFoundError('Brand', brandId);
  };
  const destinationOf = (brandId: string, id: string) => {
    const d = b.destinations.find((x) => x.id === id && x.brandId === brandId);
    if (!d) throw new NotFoundError('Destination', id);
    return d;
  };
  const policyOf = (brandId: string, kind: string, dataType: string) =>
    b.policies.find((p) => p.brandId === brandId && p.destinationKind === kind && p.dataType === dataType) ??
    null;
  /** The source-use reading of `read` for a kind's reports, as sourceUsePolicyService.check answers it. */
  const readDecision = (kind: string, dataType: string): SourceUseCheckResult => {
    const p = policyOf(b.brandId, kind, dataType);
    if (!p) return { allowed: false, reason: 'no_policy', policy: null };
    if (new Date(p.reviewDueAt).getTime() < Date.now())
      return { allowed: false, reason: 'review_overdue', policy: p };
    if (!p.allowedUses.includes('read')) return { allowed: false, reason: 'not_allowed', policy: p };
    return { allowed: true, reason: 'allowed', policy: p };
  };
  const rowsOf = (destinationId: string, reportKey: string, start = '0000-00-00', end = '9999-99-99') =>
    b.reportRows.filter(
      (r) =>
        r.destinationId === destinationId && r.reportKey === reportKey && r.date >= start && r.date <= end,
    );
  const windowOf = (destinationId: string, spec: MockReportSpec, start: string, end: string) => {
    const rows = rowsOf(destinationId, spec.key, start, end);
    return {
      windowStart: start,
      windowEnd: end,
      days: new Set(rows.map((r) => r.date)).size,
      rows: rows.length,
      metrics: webMetricValues(
        spec.metrics,
        spec.derived,
        webMetricSums(
          spec.metrics,
          rows.map((r) => r.metrics),
        ),
      ),
    };
  };
  const byDimension = (
    destinationId: string,
    spec: MockReportSpec,
    start: string,
    end: string,
  ): DestinationReportRowV1[] => {
    const groups = new Map<string, SeededReportRow[]>();
    for (const r of rowsOf(destinationId, spec.key, start, end)) {
      const key = JSON.stringify(Object.entries(r.dimensions).sort());
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const primary = reportPrimaryMetric(spec.metrics);
    return [...groups.entries()]
      .map(([dimensionKey, rows]) => ({
        dimensionKey,
        dimensions: rows[0]?.dimensions ?? {},
        days: new Set(rows.map((r) => r.date)).size,
        metrics: webMetricValues(
          spec.metrics,
          spec.derived,
          webMetricSums(
            spec.metrics,
            rows.map((r) => r.metrics),
          ),
        ),
      }))
      .sort(
        (x, y) =>
          (y.metrics[primary] ?? -1) - (x.metrics[primary] ?? -1) ||
          x.dimensionKey.localeCompare(y.dimensionKey),
      );
  };
  return router({
    list: query.input(DestinationList).query(({ input }) => {
      brandOf(input.brandId);
      const items = b.destinations
        .filter((d) => d.brandId === input.brandId && (!input.kind || d.kind === input.kind))
        .sort((x, y) => x.kind.localeCompare(y.kind) || x.displayName.localeCompare(y.displayName));
      return { items };
    }),
    get: query.input(DestinationGet).query(({ input }) => destinationOf(input.brandId, input.destinationId)),
    register: mutation.input(DestinationRegister).mutation(({ input }) => {
      brandOf(input.brandId);
      if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
      const existing = b.destinations.find((d) => d.kind === input.kind && d.externalId === input.externalId);
      if (existing && existing.brandId !== input.brandId)
        throw new ValidationFailedError(
          [{ path: 'externalId', issue: 'remote_identity_registered_to_another_brand' }],
          'This remote identity is already registered to another brand',
        );
      if (existing) throw new ConflictError('Destination', existing.id, existing.version);
      const row: DestinationV1 = {
        id: `dst_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        brandId: input.brandId,
        kind: input.kind,
        externalId: input.externalId,
        displayName: input.displayName,
        ownerUserId: 'usr_e2e',
        grantedScopes: input.grantedScopes,
        health: 'unknown',
        healthCheckedAt: null,
        capabilityVersion: input.capabilityVersion,
        status: 'active',
        reportingTimeZone: null,
        currencyCode: null,
        writeSafety: 'unknown',
        writeSafetyCheckedAt: null,
        articleSelector: null,
        version: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      b.destinations.push(row);
      return row;
    }),
    setHealth: mutation.input(DestinationSetHealth).mutation(({ input }) => {
      const d = destinationOf(input.brandId, input.destinationId);
      if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
      if (d.version !== input.expectedVersion)
        throw new ConflictError('Destination', d.id, input.expectedVersion);
      Object.assign(d, {
        health: input.health,
        healthCheckedAt: now(),
        updatedAt: now(),
        version: d.version + 1,
      });
      return d;
    }),
    /** PR-04: the website's article-region selector (the API validates it with the same contract). */
    setArticleSelector: mutation.input(DestinationSetArticleSelector).mutation(({ input }) => {
      const d = destinationOf(input.brandId, input.destinationId);
      if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
      if (d.version !== input.expectedVersion)
        throw new ConflictError('Destination', d.id, input.expectedVersion);
      Object.assign(d, { articleSelector: input.articleSelector, updatedAt: now(), version: d.version + 1 });
      return d;
    }),
    sources: router({ list: query.query(() => ({ items: [...SOURCES] })) }),
    connect: router({
      start: mutation.input(DestinationConnectStart).mutation(({ input }) => {
        brandOf(input.brandId);
        if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
        const source = SOURCES.find((s) => s.kind === input.kind);
        if (!source)
          throw new CapabilityUnsupportedError([{ path: 'kind', issue: `unknown_provider:${input.kind}` }]);
        if (!source.certified)
          throw new CapabilityUnsupportedError([
            { path: 'kind', issue: `provider_not_certified:${input.kind}` },
          ]);
        const state = `st_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        b.connectStates.set(state, { brandId: input.brandId, kind: input.kind });
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.searchParams.set('state', state);
        url.searchParams.set('redirect_uri', input.redirectUri ?? '');
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
        return { state, url: url.toString(), expiresAt: inDays(1) };
      }),
      complete: mutation.input(DestinationConnectComplete).mutation(({ input }) => {
        const pending = b.connectStates.get(input.state);
        b.connectStates.delete(input.state);
        if (!pending)
          throw new ValidationFailedError(
            [{ path: 'state', issue: 'connect_state_invalid_or_expired' }],
            'The connect flow has expired; start again',
          );
        const pendingId = `pdg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const targets = PD.targets.map((t) => ({ ...t }));
        b.connectChoices.set(pendingId, { ...pending, targets });
        return { pendingId, brandId: pending.brandId, kind: pending.kind, targets, expiresAt: inDays(1) };
      }),
      select: mutation.input(DestinationConnectSelect).mutation(({ input }) => {
        const choice = b.connectChoices.get(input.pendingId);
        if (!choice)
          throw new ValidationFailedError(
            [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
            'The connect flow has expired; start again',
          );
        const target = choice.targets.find((t) => t.externalId === input.externalId);
        if (!target)
          throw new ValidationFailedError(
            [{ path: 'externalId', issue: 'target_not_offered' }],
            'Choose one of the targets offered',
          );
        const existing = b.destinations.find(
          (d) => d.kind === choice.kind && d.externalId === target.externalId,
        );
        if (existing && existing.brandId !== choice.brandId)
          throw new ValidationFailedError(
            [{ path: 'externalId', issue: 'remote_identity_registered_to_another_brand' }],
            'This remote identity is already registered to another brand',
          );
        if (existing) throw new ConflictError('Destination', existing.id, existing.version);
        b.connectChoices.delete(input.pendingId);
        const row: DestinationV1 = {
          id: `dst_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          brandId: choice.brandId,
          kind: choice.kind,
          externalId: target.externalId,
          displayName: target.displayName,
          ownerUserId: 'usr_e2e',
          grantedScopes: ['https://www.googleapis.com/auth/analytics.readonly'],
          health: 'healthy',
          healthCheckedAt: now(),
          capabilityVersion: 1,
          status: 'active',
          reportingTimeZone: null,
          currencyCode: null,
          writeSafety: 'unknown',
          writeSafetyCheckedAt: null,
          articleSelector: null,
          version: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        b.destinations.push(row);
        return row;
      }),
      /**
       * R2-3: a website connected with its integration identity and secret. The mock keeps the DTO shape the API
       * returns (never the secret) and registers the destination with health unknown: the worker verifies it.
       */
      withSecret: mutation.input(DestinationConnectWithSecret).mutation(({ input }) => {
        brandOf(input.brandId);
        if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
        let site: URL;
        try {
          site = new URL(input.siteUrl);
        } catch {
          site = new URL('https://invalid.example');
        }
        if (site.protocol !== 'https:' || site.hostname === 'localhost')
          throw new ValidationFailedError(
            [{ path: 'siteUrl', issue: 'site_url_not_allowed' }],
            'The site address must be https on a public host',
          );
        const existing = b.destinations.find((d) => d.kind === 'cms_site' && d.externalId === site.origin);
        if (existing) throw new ConflictError('Destination', existing.id, existing.version);
        const row: DestinationV1 = {
          id: `dst_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          brandId: input.brandId,
          kind: 'cms_site',
          externalId: site.origin,
          displayName: input.displayName ?? site.host,
          ownerUserId: 'usr_e2e',
          grantedScopes: input.allowPublish ? ['articles:write', 'articles:publish'] : ['articles:write'],
          health: 'unknown',
          healthCheckedAt: null,
          capabilityVersion: 1,
          status: 'active',
          reportingTimeZone: null,
          currencyCode: null,
          writeSafety: 'unknown',
          writeSafetyCheckedAt: null,
          articleSelector: null,
          version: 0,
          createdAt: now(),
          updatedAt: now(),
        };
        b.destinations.push(row);
        return row;
      }),
      cancel: mutation.input(DestinationConnectCancel).mutation(({ input }) => {
        if (!b.connectChoices.delete(input.pendingId))
          throw new ValidationFailedError(
            [{ path: 'pendingId', issue: 'connect_choice_invalid_or_expired' }],
            'The connect flow has expired; start again',
          );
        return { pendingId: input.pendingId, cancelled: true as const };
      }),
    }),
    disconnect: mutation.input(DestinationDisconnect).mutation(({ input }) => {
      const d = destinationOf(input.brandId, input.destinationId);
      if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
      if (d.status === 'disconnected')
        throw new ValidationFailedError(
          [{ path: 'destinationId', issue: 'already_disconnected' }],
          'This destination is already disconnected',
        );
      if (d.version !== input.expectedVersion)
        throw new ConflictError('Destination', d.id, input.expectedVersion);
      Object.assign(d, { status: 'disconnected', updatedAt: now(), version: d.version + 1 });
      // RA-01, as the API: where the kind's adapter revokes the grant at the platform the worker does it later.
      return {
        ...d,
        remoteRevoke: REMOTE_REVOKE_KINDS.has(d.kind) ? ('requested' as const) : ('not_supported' as const),
      };
    }),
    reports: router({
      summary: query.input(DestinationReportSummary).query(({ input }): DestinationReportSummaryV1 => {
        const d = destinationOf(input.brandId, input.destinationId);
        const specs = REPORTS[d.kind] ?? [];
        const dataType = specs[0] ? reportDataType(specs[0].key) : `${d.kind}.reports`;
        const decision = readDecision(d.kind, dataType);
        const start = input.windowStart.slice(0, 10);
        const end = input.windowEnd.slice(0, 10);
        const length =
          Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
        const reports: DestinationReportSummaryEntryV1[] = decision.allowed
          ? specs.map((spec) => {
              const current = windowOf(d.id, spec, start, end);
              const previous = windowOf(d.id, spec, addDays(start, -length), addDays(start, -1));
              const sufficient =
                current.days >= COMPARISON_MINIMUM_SAMPLE && previous.days >= COMPARISON_MINIMUM_SAMPLE;
              const latest =
                rowsOf(d.id, spec.key)
                  .map((r) => r.date)
                  .sort()
                  .at(-1) ?? null;
              const ageHours = latest
                ? Math.max(0, (Date.now() - Date.parse(`${latest}T23:59:59.999Z`)) / 3_600_000)
                : null;
              return {
                reportKey: spec.key,
                label: spec.label,
                dimensions: spec.dimensions.map((name) => ({
                  name,
                  label: spec.dimensionLabels[name] ?? name,
                })),
                metrics: spec.metrics,
                derived: spec.derived,
                freshness: {
                  latestDate: latest,
                  fetchedAt: latest ? now() : null,
                  ageHours,
                  latencyHours: spec.latencyHours,
                  stale: ageHours === null || ageHours > spec.latencyHours * 2,
                },
                // RA-10: the days are keyed in the destination's reporting zone once learnt (the GA4 property's);
                // the latest day is provisional while it is inside the report's latency.
                quality: {
                  timeZone: d.reportingTimeZone,
                  asOfLocalDate: latest,
                  provisional: ageHours !== null && ageHours < spec.latencyHours,
                  flags: [],
                },
                current,
                previous,
                comparison: [...spec.metrics, ...spec.derived].flatMap((m) => {
                  if (m.kind === 'gauge') return [];
                  const a = current.metrics[m.name] ?? null;
                  const b = previous.metrics[m.name] ?? null;
                  return [
                    {
                      metric: m.name,
                      kind: m.kind,
                      current: a,
                      previous: b,
                      change: sufficient && a !== null && b !== null && b > 0 ? (a - b) / b : null,
                    },
                  ];
                }),
                sample: {
                  current: current.days,
                  previous: previous.days,
                  minimum: COMPARISON_MINIMUM_SAMPLE,
                  sufficient,
                },
              };
            })
          : [];
        return {
          brandId: d.brandId,
          destinationId: d.id,
          kind: d.kind,
          presentation: PRESENTATION[d.kind] ?? null,
          policy: { allowed: decision.allowed, reason: decision.reason, dataType },
          windowStart: start,
          windowEnd: end,
          reports,
          computedAt: now(),
        };
      }),
      rows: query.input(DestinationReportRows).query(({ input }) => {
        const d = destinationOf(input.brandId, input.destinationId);
        const specs = REPORTS[d.kind] ?? [];
        const decision = readDecision(d.kind, specs[0] ? reportDataType(specs[0].key) : `${d.kind}.reports`);
        if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
        const spec = specs.find((r) => r.key === input.reportKey);
        if (!spec) return { items: [] as DestinationReportRowV1[], nextCursor: null };
        const items = byDimension(d.id, spec, input.windowStart.slice(0, 10), input.windowEnd.slice(0, 10));
        return { items: items.slice(0, input.limit), nextCursor: null };
      }),
      opportunities: query.input(DestinationReportOpportunities).query(({ input }) => {
        const d = destinationOf(input.brandId, input.destinationId);
        const specs = REPORTS[d.kind] ?? [];
        const decision = readDecision(d.kind, specs[0] ? reportDataType(specs[0].key) : `${d.kind}.reports`);
        if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
        const end = addDays(dayKey(new Date()), -1);
        const start = addDays(end, -(OPPORTUNITY_WINDOW_DAYS - 1));
        const items: DestinationReportOpportunityV1[] = [];
        for (const spec of specs) {
          const rule = spec.opportunity;
          const dimension = spec.dimensions[0];
          if (!rule || !dimension) continue;
          const benchmark =
            webMetricValues(
              spec.metrics,
              spec.derived,
              webMetricSums(
                spec.metrics,
                rowsOf(d.id, spec.key, start, end).map((r) => r.metrics),
              ),
            )[rule.rateMetric] ?? null;
          if (benchmark === null) continue;
          for (const r of byDimension(d.id, spec, start, end)) {
            const volume = r.metrics[rule.volumeMetric] ?? null;
            const rate = r.metrics[rule.rateMetric] ?? null;
            if (volume === null || rate === null || volume < rule.minVolume) continue;
            if (rate >= benchmark * OPPORTUNITY_RATE_FRACTION) continue;
            const subject = r.dimensions[dimension] ?? '';
            items.push({
              kind: rule.kind,
              reportKey: spec.key,
              subject,
              metrics: r.metrics,
              benchmark: { metric: rule.rateMetric, value: benchmark },
              suggestedTask: rule.task({ subject, volume, rate, benchmark }),
            });
          }
        }
        return { items, windowStart: start, windowEnd: end };
      }),
    }),
    // R2-4: the website's audit, a restricted view under the brand's `cms.audit` policy; `run` opens a run.
    audit: router({
      summary: query.input(SeoAuditSummary).query(({ input }): SeoAuditSummaryV1 => {
        const d = destinationOf(input.brandId, input.destinationId);
        const decision = readDecision(d.kind, 'cms.audit');
        const runs = b.auditRuns.filter((r) => r.destinationId === d.id);
        const last = [...runs].reverse().find((r) => r.outcome !== 'running') ?? null;
        return {
          brandId: d.brandId,
          destinationId: d.id,
          origin: d.externalId,
          policy: { allowed: decision.allowed, reason: decision.reason, dataType: 'cms.audit' },
          canRun: d.kind === 'cms_site' && d.status === 'active' && CONNECTORS.has(b.role()),
          canCreateWork: WORK_CREATORS.has(b.role()),
          running: runs.some((r) => r.outcome === 'running'),
          lastRun: decision.allowed ? last : null,
          data: { kind: 'lab', note: SEO_AUDIT_DATA_NOTE },
          fieldData: null,
          computedAt: now(),
        };
      }),
      runs: router({
        list: query.input(SeoAuditRunsList).query(({ input }) => {
          const d = destinationOf(input.brandId, input.destinationId);
          const decision = readDecision(d.kind, 'cms.audit');
          if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
          return { items: [...b.auditRuns.filter((r) => r.destinationId === d.id)].reverse() };
        }),
      }),
      pages: router({
        list: query.input(SeoAuditPagesList).query(({ input }) => {
          const d = destinationOf(input.brandId, input.destinationId);
          const decision = readDecision(d.kind, 'cms.audit');
          if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
          const runId = input.runId ?? PD.auditRun;
          const items = b.auditPages.filter(
            (p) => p.runId === runId && (!input.severity || p.severity === input.severity),
          );
          return { items: items.slice(0, input.limit), nextCursor: null };
        }),
      }),
      findings: query.input(SeoAuditFindings).query(({ input }) => {
        const d = destinationOf(input.brandId, input.destinationId);
        const decision = readDecision(d.kind, 'cms.audit');
        if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
        const items = d.id === PD.destinations.cms ? seededFindings() : [];
        return {
          runId: PD.auditRun,
          items: items.map((f) => {
            const work = b.findingWork.find((w) => w.destinationId === d.id && w.check === f.check) ?? null;
            return { ...f, status: work ? ('tracked' as const) : ('open' as const), work };
          }),
        };
      }),
      // RA-11: findings become recommendations (one per finding; a second call returns the existing one).
      createWork: mutation.input(SeoAuditCreateWork).mutation(({ input }) => {
        const d = destinationOf(input.brandId, input.destinationId);
        if (!WORK_CREATORS.has(b.role())) throw new PolicyDeniedError('role_missing');
        const decision = readDecision(d.kind, 'cms.audit');
        if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
        const reported = d.id === PD.destinations.cms ? seededFindings() : [];
        const missing = input.checks.filter((c) => !reported.some((f) => f.check === c));
        if (missing.length > 0)
          throw new ValidationFailedError(
            missing.map((c) => ({ path: 'checks', issue: `not_reported:${c}` })),
            'the run does not report every check asked for',
          );
        const items = reported.flatMap((finding) => {
          const check = finding.check;
          if (!input.checks.includes(check)) return [];
          const existing = b.findingWork.find((w) => w.destinationId === d.id && w.check === check);
          if (existing) return [existing];
          const row: SeoFindingWorkV1 = {
            id: `sfw_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            findingId: finding.findingId,
            brandId: d.brandId,
            destinationId: d.id,
            runId: PD.auditRun,
            check,
            severity: finding.severity,
            pageCount: finding.count,
            examples: finding.examples,
            workType: 'recommendation',
            workId: `rec_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            title: `${finding.label} on ${d.externalId}`,
            state: 'proposed',
            createdById: 'usr_e2e',
            createdAt: now(),
            resolvedAt: null,
            resolvedRunId: null,
          };
          b.findingWork.push(row);
          return [row];
        });
        return { runId: PD.auditRun, items };
      }),
      run: mutation.input(SeoAuditRun).mutation(({ input }): SeoAuditRunV1 => {
        const d = destinationOf(input.brandId, input.destinationId);
        if (!CONNECTORS.has(b.role())) throw new PolicyDeniedError('role_missing');
        if (d.kind !== 'cms_site' || d.status !== 'active')
          throw new ValidationFailedError([{ path: 'destinationId', issue: 'not_an_active_site' }]);
        const decision = readDecision(d.kind, 'cms.audit');
        if (!decision.allowed) throw new PolicyDeniedError(`source_use_${decision.reason}`);
        const running = b.auditRuns.find((r) => r.destinationId === d.id && r.outcome === 'running');
        if (running) throw new ConflictError('SeoAuditRun', running.id, 0);
        const row: SeoAuditRunV1 = {
          id: `sar_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          brandId: d.brandId,
          destinationId: d.id,
          origin: d.externalId,
          trigger: 'on_demand',
          startedAt: now(),
          finishedAt: null,
          outcome: 'running',
          reason: null,
          pagesCrawled: 0,
          limitsHit: [],
          summary: { critical: 0, major: 0, minor: 0, byCheck: {} },
        };
        b.auditRuns.push(row); // the mock worker never finishes it: the screen shows a run in progress
        return row;
      }),
    }),
    sourceUse: router({
      list: query.input(SourceUsePolicyList).query(({ input }) => {
        brandOf(input.brandId);
        const items = b.policies
          .filter(
            (p) =>
              p.brandId === input.brandId &&
              (!input.destinationKind || p.destinationKind === input.destinationKind),
          )
          .sort(
            (x, y) =>
              x.destinationKind.localeCompare(y.destinationKind) || x.dataType.localeCompare(y.dataType),
          );
        return { items };
      }),
      set: mutation.input(SourceUsePolicySet).mutation(({ input }) => {
        brandOf(input.brandId);
        if (!POLICY_MANAGERS.has(b.role())) throw new PolicyDeniedError('role_missing');
        const allowedUses = [...new Set(input.allowedUses)];
        const issues = sourceUseIssues(input.destinationKind, allowedUses, input.retentionDays);
        if (issues.length) throw new ValidationFailedError(issues);
        const retains = allowedUses.includes('retain');
        if (new Date(input.reviewDueAt).getTime() <= Date.now())
          throw new ValidationFailedError([{ path: 'reviewDueAt', issue: 'not_in_future' }]);
        const values = {
          allowedUses,
          retentionDays: retains ? (input.retentionDays ?? null) : null,
          reviewedAt: now(),
          reviewDueAt: input.reviewDueAt,
          reviewedById: 'usr_e2e',
          updatedAt: now(),
        };
        const existing = policyOf(input.brandId, input.destinationKind, input.dataType);
        if (existing) {
          if (input.expectedVersion !== existing.version)
            throw new ConflictError(
              'SourceUsePolicy',
              existing.id,
              input.expectedVersion ?? existing.version,
            );
          Object.assign(existing, values, { version: existing.version + 1 });
          return existing;
        }
        const row: SourceUsePolicyV1 = {
          id: `sup_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          brandId: input.brandId,
          destinationKind: input.destinationKind,
          dataType: input.dataType,
          version: 1,
          createdAt: now(),
          ...values,
        };
        b.policies.push(row);
        return row;
      }),
      check: query.input(SourceUseCheck).query(({ input }): SourceUseCheckResult => {
        brandOf(input.brandId);
        const p = policyOf(input.brandId, input.destinationKind, input.dataType);
        if (!p) return { allowed: false, reason: 'no_policy', policy: null };
        if (new Date(p.reviewDueAt).getTime() < Date.now())
          return { allowed: false, reason: 'review_overdue', policy: p };
        if (!p.allowedUses.includes(input.use)) return { allowed: false, reason: 'not_allowed', policy: p };
        return { allowed: true, reason: 'allowed', policy: p };
      }),
    }),
  });
}
