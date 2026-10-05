import type { Tone } from '@oremedia/ui';
import type {
  ApprovalInvalidatedReason,
  FrozenManifestV1,
  InboxAttention,
  ManifestChange,
  ReviewDecisionKind,
  ReviewRequestState,
  StaleReason,
} from '@oremedia/contracts/review';

export interface AttentionChip {
  tone: Tone;
  label: string;
  detail: string;
}

/** Spec 21.2 review inbox flags as text + glyph chips (the Badge adds the glyph); never colour alone. */
export const ATTENTION_CHIP: Record<InboxAttention, AttentionChip> = {
  awaiting_decision: {
    tone: 'info',
    label: 'Awaiting decision',
    detail: 'Open: nobody has decided yet.',
  },
  stale: {
    tone: 'warning',
    label: 'Stale',
    detail: 'The package changed after the manifest was frozen; a new request is needed.',
  },
  changes_requested: {
    tone: 'warning',
    label: 'Changes requested',
    detail: 'A reviewer asked for changes; the revision is back with its author.',
  },
  approved: { tone: 'good', label: 'Approved', detail: 'A valid approval binds this exact package.' },
  approval_invalidated: {
    tone: 'critical',
    label: 'Approval invalidated',
    detail: 'Something the approval was bound to changed; it no longer releases anything.',
  },
  external_access_revoked: {
    tone: 'neutral',
    label: 'External link revoked',
    detail: 'At least one external reviewer link was revoked.',
  },
};

export const STALE_REASON_TEXT: Record<StaleReason, string> = {
  package_revised: 'the package was revised',
  variant_changed: 'a channel variant changed',
  creative_changed: 'a creative document changed',
  brand_changed: 'the brand system changed',
};

export const INVALIDATED_REASON_TEXT: Record<ApprovalInvalidatedReason, string> = {
  content_revision_changed: 'the content revision changed',
  creative_revision_changed: 'a creative revision changed',
  brand_changed: 'the brand system changed',
  request_cancelled: 'the review request was cancelled',
};

export const staleReasonText = (reason: string | null | undefined): string =>
  (reason && STALE_REASON_TEXT[reason as StaleReason]) || 'the reason was not recorded';

export const invalidatedReasonText = (reason: string | null | undefined): string =>
  (reason && INVALIDATED_REASON_TEXT[reason as ApprovalInvalidatedReason]) || 'the reason was not recorded';

export const REQUEST_STATE_CHIP: Record<ReviewRequestState, AttentionChip> = {
  open: { tone: 'info', label: 'Open', detail: 'Reviewers can decide.' },
  stale: { tone: 'warning', label: 'Stale', detail: 'The package changed after freezing.' },
  decided: { tone: 'good', label: 'Decided', detail: 'A decision was recorded.' },
  cancelled: { tone: 'neutral', label: 'Cancelled', detail: 'Withdrawn before a decision.' },
};

/** Orders chips so the one needing action comes first; used by the inbox list and the detail header. */
const ORDER: InboxAttention[] = [
  'approval_invalidated',
  'stale',
  'changes_requested',
  'awaiting_decision',
  'external_access_revoked',
  'approved',
];
export function orderAttention(flags: readonly InboxAttention[]): InboxAttention[] {
  return ORDER.filter((f) => flags.includes(f));
}

export interface ManifestChannelSummary {
  /** The target's id: the channel connection, or (R2-3) the brand destination the caption is for. */
  channelConnectionId: string;
  kind: 'channel' | 'destination';
  text: string;
  altTexts: string[];
  settingsHash: string;
  exportCount: number;
  exportHashes: string[];
}

/** A frozen target's id: a manifest written before destinations existed names a channel. */
const targetOf = (t: { channelConnectionId?: string; destinationId?: string }) =>
  t.destinationId
    ? { id: t.destinationId, kind: 'destination' as const }
    : { id: t.channelConnectionId ?? '', kind: 'channel' as const };

/** Spec 13.3: the frozen manifest, grouped per target for display (captions with their exports). */
export function manifestChannels(manifest: FrozenManifestV1): ManifestChannelSummary[] {
  return manifest.captions.map((c) => {
    const target = targetOf(c);
    const exports = manifest.exports.filter((e) => targetOf(e).id === target.id);
    return {
      channelConnectionId: target.id,
      kind: target.kind,
      text: c.text,
      altTexts: c.altTexts,
      settingsHash: c.settingsHash,
      exportCount: exports.length,
      exportHashes: exports.map((e) => e.contentHash),
    };
  });
}

/** RA-09: what differs between the frozen manifest and the package now, in words. */
export const MANIFEST_CHANGE_TEXT: Record<ManifestChange, string> = {
  article: 'the article document',
  rendering: 'how the article renders',
  captions: 'a caption or alt text',
  settings: 'a target’s settings (a website’s publish mode)',
  exports: 'the rendered files',
  targets: 'the targets',
  websites: 'a website target or its publish mode',
  brand: 'the brand system or policy',
};
export const manifestChangeText = (changes: readonly ManifestChange[]): string =>
  changes.map((c) => MANIFEST_CHANGE_TEXT[c] ?? c).join(', ');

export type ManifestWebsite = NonNullable<FrozenManifestV1['websites']>[number];

/**
 * RA-09: what approving means for a website target, in one sentence: a draft saved on the site, or a live page
 * at the frozen time (the window's start when the timing is a window).
 */
export function websiteStatement(site: ManifestWebsite, timing: FrozenManifestV1['timing']): string {
  const fmt = (iso: string) => new Date(iso).toLocaleString();
  const page = site.path ? ` (${site.path})` : '';
  if (site.publishMode === 'publish')
    return timing.kind === 'exact'
      ? `Approving this will publish live at ${fmt(timing.at)} on ${site.displayName}${page}.`
      : `Approving this will publish live between ${fmt(timing.from)} and ${fmt(timing.to)} on ${site.displayName}${page}.`;
  return `Approving this will save a draft on ${site.displayName}${page}; nothing goes live until a live publish is chosen and reviewed.`;
}

export function timingText(timing: FrozenManifestV1['timing']): string {
  const fmt = (iso: string) => new Date(iso).toLocaleString();
  return timing.kind === 'exact'
    ? `Exactly at ${fmt(timing.at)}`
    : `Between ${fmt(timing.from)} and ${fmt(timing.to)}`;
}

export const shortHash = (hash: string, length = 12): string =>
  hash.length > length ? `${hash.slice(0, length)}…` : hash;

/** The link a reviewer opens: the token travels in the fragment (never sent to a server or logged), with its expiry. */
export function reviewLinkUrl(
  portalBase: string,
  reviewRequestId: string,
  token: string,
  expiresAt: string,
): string {
  const base = portalBase.endsWith('/') ? portalBase.slice(0, -1) : portalBase;
  const params = new URLSearchParams({ request: reviewRequestId, token, exp: expiresAt });
  return `${base}/#${params.toString()}`;
}

export interface PortalLink {
  reviewRequestId: string;
  token: string;
  expiresAt: string | null;
}

/** Reads the fragment a review link carries: `#request=rr_…&token=rl_…&exp=…`; anything else is incomplete. */
export function parsePortalFragment(hash: string): PortalLink | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const token = params.get('token');
  const reviewRequestId = params.get('request');
  if (!token || !token.startsWith('rl_') || !reviewRequestId) return null;
  const exp = params.get('exp');
  return { reviewRequestId, token, expiresAt: exp && !Number.isNaN(new Date(exp).getTime()) ? exp : null };
}

// ---- The interface's forms (interface-integration programme): what a row, a header and a reviewer list say ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "23 Sep" as the interface writes dates (the locale's own short month varies: "Sept"), the year only when it is not this year. */
export const shortDate = (iso: string, now = new Date()): string => {
  const d = new Date(iso);
  const dayMonth = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth} ${d.getFullYear()}`;
};

/** The inbox row's due text as the interface sets it: "due today", otherwise "due 28 Sep". */
export const dueText = (iso: string, now = new Date()): string =>
  new Date(iso).toDateString() === now.toDateString() ? 'due today' : `due ${shortDate(iso, now)}`;

/** Flags that say what the request is (the dot and the label); the rest are secondary flags after a separator. */
const STATE_FLAGS: ReadonlySet<InboxAttention> = new Set([
  'approval_invalidated',
  'stale',
  'changes_requested',
  'awaiting_decision',
  'approved',
]);

export interface InboxRowState {
  tone: Tone;
  label: string;
  detail: string;
  /** Secondary flags ("External link revoked"), shown after the state in the accent colour. */
  flags: AttentionChip[];
}

/**
 * One state per row, the way the interface lists requests: the dot and the state label first (the most urgent
 * attention flag, or the request's own state when nothing needs attention), then any further flag after a dot.
 */
export function inboxRowState(item: { state: ReviewRequestState; attention: readonly InboxAttention[] }): InboxRowState {
  const ordered = orderAttention(item.attention);
  const primary = ordered.find((f) => STATE_FLAGS.has(f));
  const head = primary ? ATTENTION_CHIP[primary] : REQUEST_STATE_CHIP[item.state];
  return { ...head, flags: ordered.filter((f) => f !== primary).map((f) => ATTENTION_CHIP[f]) };
}

/** The request header's state pill: what the request is now, in the interface's words. */
export function requestHeadline(r: {
  state: ReviewRequestState;
  revisionState: string;
  approvals: ReadonlyArray<{ state: string }>;
}): AttentionChip {
  if (r.state === 'open') return ATTENTION_CHIP.awaiting_decision;
  if (r.state !== 'decided') return REQUEST_STATE_CHIP[r.state];
  if (r.approvals.some((a) => a.state === 'valid')) return ATTENTION_CHIP.approved;
  if (r.approvals.some((a) => a.state === 'invalidated')) return ATTENTION_CHIP.approval_invalidated;
  if (r.revisionState === 'changes_requested') return ATTENTION_CHIP.changes_requested;
  return REQUEST_STATE_CHIP.decided;
}

export const DECISION_LABEL: Record<ReviewDecisionKind, string> = {
  approve: 'Approved',
  request_changes: 'Changes requested',
  reject: 'Rejected',
};

export interface ReviewerRow {
  key: string;
  /** The person: a member's name (their id until the members list names them) or an external reviewer's email. */
  who: string;
  kind: 'Team' | 'External';
  /** What they decided, "Pending" while the request waits on them, or why they no longer can. */
  decision: string;
}

interface ReviewerSource {
  state: ReviewRequestState;
  assignees: readonly string[];
  decisions: ReadonlyArray<{
    deciderKind: string;
    deciderId: string;
    decision: ReviewDecisionKind;
    verifiedEmail: string | null;
  }>;
  externalLinks: ReadonlyArray<{ id: string; email: string; revokedAt: string | null; expiresAt: string }>;
}

/**
 * The interface's REVIEWERS list from the request's assignees, deciders and external links: every person once,
 * members before external reviewers, each with the decision they recorded or "Pending".
 */
export function reviewerRows(r: ReviewerSource, memberName: (userId: string) => string, now = new Date()): ReviewerRow[] {
  const pending = r.state === 'open' ? 'Pending' : '—';
  const members = new Map<string, string>();
  for (const id of r.assignees) members.set(id, pending);
  for (const d of r.decisions)
    if (d.deciderKind !== 'external_reviewer') members.set(d.deciderId, DECISION_LABEL[d.decision]);
  const external = new Map<string, string>();
  for (const l of r.externalLinks) {
    if (external.has(l.email)) continue;
    const decided = r.decisions.find((d) => d.deciderKind === 'external_reviewer' && d.verifiedEmail === l.email);
    external.set(
      l.email,
      decided
        ? DECISION_LABEL[decided.decision]
        : l.revokedAt
          ? 'Link revoked'
          : new Date(l.expiresAt).getTime() < now.getTime()
            ? 'Link expired'
            : pending,
    );
  }
  return [
    ...[...members].map(([id, decision]) => ({ key: `member:${id}`, who: memberName(id), kind: 'Team' as const, decision })),
    ...[...external].map(([email, decision]) => ({ key: `external:${email}`, who: email, kind: 'External' as const, decision })),
  ];
}

/**
 * A comment is outdated when the manifest it was made on is not the one that would publish now: the request went
 * stale, the package changed since the freeze, or the comment names another manifest hash.
 */
export const commentOutdated = (
  comment: { manifestHash: string },
  r: { manifestHash: string; state: ReviewRequestState; changedSinceFreeze: readonly unknown[] },
): boolean =>
  comment.manifestHash !== r.manifestHash || r.state === 'stale' || r.changedSinceFreeze.length > 0;
