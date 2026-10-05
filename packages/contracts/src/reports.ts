import { z } from 'zod';
import type { MetricKind } from './measurement';
import { PageRequest } from './pagination';

/**
 * D-29 monthly client reports: a brand's month of channel numbers composed from the measurement module under the
 * dictionary's rules (D-14, D-15: flows summed, rates pooled, unique counts never summed across posts, days or
 * platforms; a comparison below the minimum sample reads "insufficient sample"), an executive summary drafted
 * through the model gateway and always editable, the intelligence module's recommendations read beside an
 * editable text, and the record of what was saved and sent. Nothing here is a new number: every figure is the one
 * the measurement module already reports.
 */
export const ReportPeriodMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a calendar month as YYYY-MM');
export type ReportPeriodMonth = z.infer<typeof ReportPeriodMonth>;
export const ReportCompareMode = z.enum(['previous_month', 'last_year']);
export type ReportCompareMode = z.infer<typeof ReportCompareMode>;
export const ReportSection = z.enum(['cover', 'overview', 'channels', 'posts', 'recommendations']);
export type ReportSection = z.infer<typeof ReportSection>;
/** The sections in page order; a report keeps the order and drops the ones switched off. */
export const REPORT_SECTIONS: readonly ReportSection[] = ReportSection.options;
export const REPORT_SECTION_LABEL: Readonly<Record<ReportSection, string>> = {
  cover: 'Cover',
  overview: 'Overall performance',
  channels: 'Channel performance',
  posts: 'Post performance',
  recommendations: 'Recommendations',
};
export const ReportTheme = z.enum(['dark', 'light']);
export type ReportTheme = z.infer<typeof ReportTheme>;
export const ReportState = z.enum(['draft', 'sent']);
export type ReportState = z.infer<typeof ReportState>;

export const ReportList = z.object({ brandId: z.string(), page: PageRequest });
export const ReportGet = z.object({ brandId: z.string(), periodMonth: ReportPeriodMonth });
/** What a person edits on the builder; the whole form is saved at once. */
export const ReportFields = z.object({
  compareMode: ReportCompareMode,
  sections: z.array(ReportSection).min(1).max(REPORT_SECTIONS.length),
  executiveSummary: z.string().max(4000),
  recommendations: z.string().max(6000),
  preparedFor: z.string().max(200),
  preparedBy: z.string().max(200),
  theme: ReportTheme,
});
export type ReportFields = z.infer<typeof ReportFields>;
/** `expectedVersion` null creates the month's draft; a number updates the month's report at that version. */
export const ReportSave = z.object({
  brandId: z.string(),
  periodMonth: ReportPeriodMonth,
  expectedVersion: z.number().int().min(0).nullable(),
  fields: ReportFields,
});
/** "Send to client" on a deployment without email delivery: the send is recorded, never claimed (D-29). */
export const ReportMarkSent = z.object({
  brandId: z.string(),
  reportId: z.string(),
  expectedVersion: z.number().int().min(0),
  sentTo: z.string().min(1).max(320),
});
export const ReportFigures = z.object({
  brandId: z.string(),
  periodMonth: ReportPeriodMonth,
  compareMode: ReportCompareMode.default('previous_month'),
});
export const ReportDraftSummary = z.object({
  brandId: z.string(),
  periodMonth: ReportPeriodMonth,
  compareMode: ReportCompareMode.default('previous_month'),
  /** What the person wants changed about the draft (the "Re-draft" with a note); omitted, a first draft. */
  instruction: z.string().max(500).optional(),
});
export const ReportAsk = z.object({
  brandId: z.string(),
  periodMonth: ReportPeriodMonth,
  compareMode: ReportCompareMode.default('previous_month'),
  question: z.string().min(1).max(500),
});
export const ReportDelivery = z.object({ brandId: z.string() });
export const ReportPreferencesGet = z.object({ brandId: z.string() });
export const ReportPreferencesSet = z.object({ brandId: z.string(), autoDraft: z.boolean() });

/** The comparable groups a report reads, in reading order (the Performance screen's set, spec 15.1). */
export const REPORT_GROUPS: ReadonlyArray<[group: string, label: string]> = [
  ['impressions', 'Impressions'],
  ['reach', 'Reach'],
  ['engagement', 'Engagements'],
  ['rate:engagement/impressions', 'Engagement rate'],
  ['clicks', 'Link clicks'],
  ['likes', 'Likes and reactions'],
  ['comments', 'Comments'],
  ['shares', 'Shares'],
  ['saves', 'Saves'],
];
/** D-14: a comparison with fewer publications than this on either side reads "insufficient sample". */
export const REPORT_MINIMUM_SAMPLE = 5;
/** The months of the trend on the overview page, the report's month included. */
export const REPORT_TREND_MONTHS = 6;
/** How many posts the post page ranks at the top and at the bottom. */
export const REPORT_TOP_POSTS = 5;
export const REPORT_BOTTOM_POSTS = 3;
/** How many recommendations the recommendations page reads from the intelligence module. */
export const REPORT_RECOMMENDATIONS = 3;

export interface ReportV1 {
  id: string;
  brandId: string;
  periodMonth: string;
  compareMode: ReportCompareMode;
  sections: ReportSection[];
  executiveSummary: string;
  recommendations: string;
  preparedFor: string;
  preparedBy: string;
  theme: ReportTheme;
  state: ReportState;
  sentAt: string | null;
  sentTo: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** One figure of the overview page: a flow's total, a pooled rate, or a listed (never summed) group. */
export interface ReportFigureV1 {
  key: string;
  label: string;
  kind: MetricKind;
  value: number | null;
  previous: number | null;
  /** Relative change against the comparison month; null below the sample or without both sides. */
  change: number | null;
  /** D-15: why the group has no total, in the dictionary's words; null for an additive group. */
  notSummed: string | null;
  /** Posts with a number for the group, of the month's posts. */
  coverage: { withData: number; requested: number };
}
export interface ReportSampleV1 {
  current: number;
  previous: number;
  minimum: number;
  sufficient: boolean;
}
export interface ReportChannelV1 {
  channelConnectionId: string;
  providerKey: string;
  displayName: string;
  publications: number;
  previousPublications: number;
  impressions: number | null;
  engagement: number | null;
  clicks: number | null;
  /** Σ engagement ÷ Σ impressions of the channel's posts (spec 15.2); null without both operands. */
  engagementRate: number | null;
  impressionsChange: number | null;
  sufficient: boolean;
  /** The channel's impressions over every channel's (a flow: additive); null when the month has none. */
  shareOfImpressions: number | null;
  /** The channel's post with the most engagements, when any post carries a number. */
  bestPublicationId: string | null;
}
export interface ReportPostV1 {
  publicationId: string;
  channelConnectionId: string;
  contentRevisionId: string;
  scheduledFor: string;
  impressions: number | null;
  engagement: number | null;
  /** The post's own reach (a unique count stands per post, never summed). */
  reach: number | null;
  clicks: number | null;
  engagementRate: number | null;
  stale: boolean;
}
export interface ReportFormatV1 {
  feature: string;
  value: string;
  publications: number;
  rate: number | null;
  sufficient: boolean;
}
export interface ReportTrendPointV1 {
  month: string;
  publications: number;
  /** The month's impressions (a flow, so a total exists); null when no post carries one. */
  impressions: number | null;
}
export interface ReportRecommendationV1 {
  id: string;
  title: string;
  rationale: string;
  state: string;
  expectedBenefit: { metricKey: string; direction: 'up' | 'down'; magnitude?: string };
  rank: number;
}
export interface ReportFreshnessV1 {
  latestFetchedAt: string | null;
  staleValues: number;
  valuesWithData: number;
}
export interface ReportFiguresV1 {
  brandId: string;
  brandName: string;
  timeZone: string;
  periodMonth: string;
  compareMonth: string;
  compareMode: ReportCompareMode;
  window: { start: string; end: string };
  compareWindow: { start: string; end: string };
  sample: ReportSampleV1;
  figures: ReportFigureV1[];
  channels: ReportChannelV1[];
  posts: {
    /** The top posts by engagements. */
    ranked: ReportPostV1[];
    /** Below the line: the lowest engagement rates among the rest. */
    lowest: ReportPostV1[];
    total: number;
    withNumbers: number;
    /** The top posts' share of the month's engagements; null without engagements. */
    topShare: number | null;
  };
  formats: ReportFormatV1[];
  trend: ReportTrendPointV1[];
  recommendations: ReportRecommendationV1[];
  freshness: ReportFreshnessV1;
  computedAt: string;
}

/** Why the model gateway could not draft (the summary stays editable and the assistant says so). */
export const ReportDraftBlocker = z.enum([
  'model_unavailable',
  'kill_switch_engaged',
  'model_routing_denied',
  'entitlement_exhausted',
  'budget_exhausted',
  'model_failed',
]);
export type ReportDraftBlocker = z.infer<typeof ReportDraftBlocker>;
export interface ReportDraftUnavailableV1 {
  available: false;
  reason: ReportDraftBlocker;
  message: string;
}
/** A model-drafted executive summary: labelled a draft, written over the computed figures only, editable. */
export interface ReportSummaryDraftV1 {
  available: true;
  draft: true;
  text: string;
  model: string;
  costMicros: number;
}
/** The assistant's answer: text for one section, placed by the model, never added to the report by itself. */
export interface ReportAdditionV1 {
  available: true;
  draft: true;
  section: ReportSection;
  text: string;
  reply: string;
  model: string;
  costMicros: number;
}
/** The strict shape the assistant answers in (structured output where the gateway supports it). */
export const ReportAdditionOutput = z.object({
  section: ReportSection,
  text: z.string().min(1).max(600),
  reply: z.string().min(1).max(300),
});
export type ReportAdditionOutput = z.infer<typeof ReportAdditionOutput>;

/** What this deployment can do with a finished report (D-29: a send only through a delivery that exists). */
export interface ReportDeliveryV1 {
  email: { configured: boolean; reason: string };
  link: { available: boolean; reason: string };
  pdf: { method: 'print'; note: string };
}
export interface ReportPreferencesV1 {
  brandId: string;
  autoDraft: boolean;
  /** Whether a job acts on the preference on this deployment (none does yet); the switch's label says so. */
  scheduleActive: boolean;
  version: number;
}

/** The model gateway's description a report drafting read estimates with (the configured model and its prices). */
export interface ReportDrafterDescriptionV1 {
  provider: string;
  model: string;
  maxOutputTokens: number;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
}
/** One bounded drafting call: the brand's voice, the computed facts (the only numbers allowed) and the ask. */
export interface ReportDraftRequestV1 {
  tenantId: string;
  requestId: string;
  kind: 'summary' | 'addition';
  brandName: string;
  periodLabel: string;
  compareLabel: string;
  voice: { summary: string; tone: string[]; prohibitedPhrases: string[] };
  /** The computed figures, one statement each; the prompt forbids any number not in them. */
  facts: string[];
  /** The person's note (a re-draft instruction, or the assistant's question). */
  instruction: string | null;
  maxOutputTokens: number;
}
export interface ReportDraftResultV1 {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  costMicros: number;
}
/** The gateway as @oremedia/ai provides it (composition registers it); until registered, drafting is unavailable. */
export interface ReportDrafterV1 {
  describe(): ReportDrafterDescriptionV1;
  assertRouting(tenantId: string): Promise<void>;
  draft(req: ReportDraftRequestV1): Promise<ReportDraftResultV1>;
}
