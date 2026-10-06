import type { Tone } from '@oremedia/ui';

export interface Chip {
  tone: Tone;
  label: string;
  detail?: string;
}

const chipOr = (map: Record<string, Chip>, state: string): Chip =>
  map[state] ?? { tone: 'neutral', label: `Unknown state (${state})` };

/** Spec 6.3 campaign states; every chip is text plus a glyph (spec 21.3). */
export const CAMPAIGN_STATE_CHIP: Record<string, Chip> = {
  draft: { tone: 'neutral', label: 'Draft' },
  active: { tone: 'info', label: 'Active' },
  completed: { tone: 'good', label: 'Completed' },
  archived: { tone: 'neutral', label: 'Archived' },
};
export const campaignChip = (state: string): Chip => chipOr(CAMPAIGN_STATE_CHIP, state);
/** G12: a completed or archived campaign takes no new briefs or content. */
export const campaignIsClosed = (state: string): boolean => state === 'completed' || state === 'archived';
/** G12: the API refused because the campaign (or the campaign of the brief) is closed. */
export const isClosedCampaignRefusal = (details: ReadonlyArray<{ issue: string }>): boolean =>
  details.some((d) => d.issue.startsWith('campaign_is_'));

export const BRIEF_STATE_CHIP: Record<string, Chip> = {
  draft: {
    tone: 'warning',
    label: 'Awaiting acceptance',
    detail: 'Work starts once a person with content.plan accepts the brief.',
  },
  accepted: { tone: 'info', label: 'Accepted', detail: 'The plan is accepted; create a content package.' },
  in_progress: { tone: 'info', label: 'In progress', detail: 'A content package is being produced.' },
  delivered: { tone: 'good', label: 'Delivered' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};
export const briefChip = (state: string): Chip => chipOr(BRIEF_STATE_CHIP, state);

/** UX-09 plan items: proposed until the brief is accepted, dropped by a person, or materialised as a package. */
export const PLAN_ITEM_STATE_CHIP: Record<string, Chip> = {
  proposed: { tone: 'warning', label: 'Proposed' },
  dropped: { tone: 'neutral', label: 'Dropped' },
  materialised: { tone: 'good', label: 'Package created' },
};
export const planItemChip = (state: string): Chip => chipOr(PLAN_ITEM_STATE_CHIP, state);

export const PACKAGE_STATE_CHIP: Record<string, Chip> = {
  draft: { tone: 'neutral', label: 'Draft' },
  in_review: { tone: 'info', label: 'In review' },
  approved: { tone: 'good', label: 'Approved' },
  scheduled: { tone: 'info', label: 'Scheduled' },
  published: { tone: 'good', label: 'Published' },
  archived: { tone: 'neutral', label: 'Archived' },
};
export const packageChip = (state: string): Chip => chipOr(PACKAGE_STATE_CHIP, state);

/** Spec 13.1 content revision machine: draft → in_review → changes_requested | approved → superseded. */
export const REVISION_STATE_CHIP: Record<string, Chip> = {
  draft: { tone: 'neutral', label: 'Draft', detail: 'Not sent for review yet.' },
  in_review: {
    tone: 'info',
    label: 'In review',
    detail: 'Reviewers see the frozen manifest of this revision.',
  },
  changes_requested: {
    tone: 'warning',
    label: 'Changes requested',
    detail: 'A reviewer asked for changes; revise the package to create the next revision.',
  },
  approved: {
    tone: 'good',
    label: 'Approved',
    detail: 'The approval binds exactly this revision; any edit creates a new revision.',
  },
  superseded: {
    tone: 'neutral',
    label: 'Superseded',
    detail: 'A newer revision replaced this one; it is kept as history and never edited.',
  },
};
export const revisionChip = (state: string): Chip => chipOr(REVISION_STATE_CHIP, state);

/** Spec 21.2 "incomplete brief": the fields a brief needs before a plan can be produced from it. */
export function briefGaps(b: {
  audience: string;
  message: string;
  channelConnectionIds: readonly string[];
}): string[] {
  const gaps: string[] = [];
  if (!b.audience.trim()) gaps.push('audience');
  if (!b.message.trim()) gaps.push('message');
  if (b.channelConnectionIds.length === 0) gaps.push('channels');
  return gaps;
}

/** Spec 21.2 "suggested plan": a brief proposed by an agent or a recommendation, not yet accepted by a person. */
export const isSuggested = (b: { createdByKind: string; recommendationId: string | null; state: string }) =>
  b.state === 'draft' && (b.createdByKind !== 'user' || b.recommendationId !== null);

/**
 * The one state line a brief row shows (the interface's dot and text): the brief's state, then what else the
 * planner needs to know ("Suggested plan", "Incomplete"); the dot takes the warning tone while the brief has gaps.
 */
export function briefRowState(b: {
  state: string;
  createdByKind: string;
  recommendationId: string | null;
  audience: string;
  message: string;
  channelConnectionIds: readonly string[];
}): Chip {
  const chip = briefChip(b.state);
  const gaps = briefGaps(b);
  const parts = [
    chip.label,
    ...(isSuggested(b) ? ['Suggested plan'] : []),
    ...(gaps.length ? ['Incomplete'] : []),
  ];
  return { tone: gaps.length ? 'warning' : chip.tone, label: parts.join(' · ') };
}

/** Spec 21.2 "missed date": a campaign still open (draft or active) after its end date. */
export const missedDate = (c: { endsAt: string; state: string }, now = new Date()): boolean =>
  (c.state === 'draft' || c.state === 'active') && new Date(c.endsAt).getTime() < now.getTime();

export interface ValidationFindings {
  ok: boolean;
  issues: Array<{ path?: string; issue: string }>;
}

/** A variant's stored capability check, as data (the server stores `{ ok, issues }`). */
export function variantFindings(validation: unknown): ValidationFindings {
  if (typeof validation !== 'object' || validation === null) return { ok: false, issues: [] };
  const v = validation as { ok?: unknown; issues?: unknown };
  const issues = Array.isArray(v.issues)
    ? v.issues
        .filter((i): i is { path?: unknown; issue: unknown } => typeof i === 'object' && i !== null)
        .map((i) => ({
          ...(typeof i.path === 'string' ? { path: i.path } : {}),
          issue: String(i.issue),
        }))
    : [];
  return { ok: v.ok === true, issues };
}

/** What a variant row says beside its channel: "Valid", or the first finding the capability check recorded. */
export const variantStatusText = (findings: ValidationFindings): string =>
  findings.ok ? 'Valid' : (findings.issues[0]?.issue ?? 'Invalid');

/** Whether two id selections are the same set (order and repeats aside): an unchanged selection is not sent. */
export const sameIdSet = (a: readonly string[], b: readonly string[]): boolean => {
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === setB.size && [...setA].every((id) => setB.has(id));
};
