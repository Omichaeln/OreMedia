import type { Tone } from '@oremedia/ui';
import type {
  ApprovalInvalidatedReason,
  FrozenManifestV1,
  InboxAttention,
  ManifestChange,
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
    label: 'External access revoked',
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
