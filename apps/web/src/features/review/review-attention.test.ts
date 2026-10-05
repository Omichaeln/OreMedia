import { describe, expect, it } from 'vitest';
import {
  ApprovalInvalidatedReason,
  InboxAttention,
  ReviewRequestState,
  StaleReason,
  type FrozenManifestV1,
} from '@oremedia/contracts/review';
import {
  ATTENTION_CHIP,
  INVALIDATED_REASON_TEXT,
  REQUEST_STATE_CHIP,
  STALE_REASON_TEXT,
  commentOutdated,
  dueText,
  inboxRowState,
  invalidatedReasonText,
  manifestChannels,
  orderAttention,
  parsePortalFragment,
  requestHeadline,
  reviewLinkUrl,
  reviewerRows,
  staleReasonText,
  timingText,
} from './review-attention';

describe('attention chips', () => {
  it('covers every inbox attention flag with text', () => {
    for (const flag of InboxAttention.options) {
      expect(ATTENTION_CHIP[flag].label.length).toBeGreaterThan(0);
      expect(ATTENTION_CHIP[flag].detail.length).toBeGreaterThan(0);
    }
    for (const state of ReviewRequestState.options) expect(REQUEST_STATE_CHIP[state].label).toBeTruthy();
  });
  it('orders the flag needing action first and drops unknown ones', () => {
    expect(orderAttention(['approved', 'awaiting_decision', 'stale'])).toEqual([
      'stale',
      'awaiting_decision',
      'approved',
    ]);
  });
});

describe('reason texts', () => {
  it('explains every stale and invalidation reason, and never invents one', () => {
    for (const r of StaleReason.options) expect(STALE_REASON_TEXT[r]).toBeTruthy();
    for (const r of ApprovalInvalidatedReason.options) expect(INVALIDATED_REASON_TEXT[r]).toBeTruthy();
    expect(staleReasonText(null)).toBe('the reason was not recorded');
    expect(invalidatedReasonText('weird')).toBe('the reason was not recorded');
    expect(staleReasonText('variant_changed')).toBe('a channel variant changed');
  });
});

describe('manifest summary', () => {
  const manifest: FrozenManifestV1 = {
    v: 1,
    contentRevisionId: 'cr_1',
    contentHash: 'a'.repeat(64),
    creativeRevisionIds: ['rev_1'],
    exports: [
      { exportId: 'exp_1', contentHash: 'b'.repeat(64), channelConnectionId: 'cc_1' },
      { exportId: 'exp_2', contentHash: 'c'.repeat(64), channelConnectionId: 'cc_1' },
      { exportId: 'exp_3', contentHash: 'd'.repeat(64), channelConnectionId: 'cc_2' },
    ],
    captions: [
      { channelConnectionId: 'cc_1', text: 'Hello', altTexts: ['alt'], settingsHash: 'e'.repeat(64) },
      { channelConnectionId: 'cc_2', text: 'Hi', altTexts: [], settingsHash: 'f'.repeat(64) },
    ],
    timing: { kind: 'exact', at: '2026-09-24T10:00:00.000Z' },
    brandVersionId: 'bv_1',
    policyVersionId: 'pv_1',
  };
  it('groups exports under their caption channel', () => {
    const channels = manifestChannels(manifest);
    expect(channels.map((c) => c.exportCount)).toEqual([2, 1]);
    expect(channels[0]?.text).toBe('Hello');
    expect(channels.every((c) => c.kind === 'channel')).toBe(true);
  });
  it('names a destination target (R2-3) beside the channels, with its own exports', () => {
    const channels = manifestChannels({
      ...manifest,
      exports: [{ exportId: 'exp_9', contentHash: 'a'.repeat(64), destinationId: 'dst_1' }],
      captions: [
        { channelConnectionId: 'cc_1', text: 'Hello', altTexts: [], settingsHash: 'e'.repeat(64) },
        { destinationId: 'dst_1', text: 'Why ore', altTexts: [], settingsHash: 'f'.repeat(64) },
      ],
    });
    expect(channels.map((c) => [c.channelConnectionId, c.kind, c.exportCount])).toEqual([
      ['cc_1', 'channel', 0],
      ['dst_1', 'destination', 1],
    ]);
  });
  it('describes timing kinds', () => {
    expect(timingText(manifest.timing)).toMatch(/^Exactly at /);
    expect(
      timingText({ kind: 'window', from: '2026-09-24T10:00:00.000Z', to: '2026-09-25T10:00:00.000Z' }),
    ).toMatch(/^Between .* and /);
  });
});

describe('portal links', () => {
  it('puts the token in the fragment and reads it back', () => {
    const url = reviewLinkUrl('https://review.example/', 'rr_1', 'rl_abc', '2026-10-01T00:00:00.000Z');
    expect(url).toBe('https://review.example/#request=rr_1&token=rl_abc&exp=2026-10-01T00%3A00%3A00.000Z');
    expect(parsePortalFragment(new URL(url).hash)).toEqual({
      reviewRequestId: 'rr_1',
      token: 'rl_abc',
      expiresAt: '2026-10-01T00:00:00.000Z',
    });
  });
  it('rejects an incomplete link and ignores a bad expiry', () => {
    expect(parsePortalFragment('#rl_only')).toBeNull();
    expect(parsePortalFragment('#request=rr_1&token=ses_notalink')).toBeNull();
    expect(parsePortalFragment('#token=rl_x')).toBeNull();
    expect(parsePortalFragment('')).toBeNull();
    expect(parsePortalFragment('#request=rr_1&token=rl_x&exp=garbage')).toEqual({
      reviewRequestId: 'rr_1',
      token: 'rl_x',
      expiresAt: null,
    });
  });
});

describe('the interface forms', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  it('says "due today" for today and "due 28 Sep" otherwise', () => {
    expect(dueText('2026-09-25T18:00:00Z', now)).toBe('due today');
    expect(dueText('2026-09-28T09:00:00Z', now)).toBe('due 28 Sep');
    expect(dueText('2027-01-02T09:00:00Z', now)).toBe('due 2 Jan 2027');
  });
  it('puts the state first in a row and the other flags after it', () => {
    const row = inboxRowState({ state: 'open', attention: ['external_access_revoked', 'awaiting_decision'] });
    expect(row.label).toBe('Awaiting decision');
    expect(row.flags.map((f) => f.label)).toEqual(['External link revoked']);
    expect(inboxRowState({ state: 'decided', attention: [] }).label).toBe('Decided');
    expect(inboxRowState({ state: 'decided', attention: ['approval_invalidated'] }).tone).toBe('critical');
  });
  it('names the request header state from the decision and approvals', () => {
    expect(requestHeadline({ state: 'open', revisionState: 'in_review', approvals: [] }).label).toBe(
      'Awaiting decision',
    );
    expect(
      requestHeadline({ state: 'decided', revisionState: 'approved', approvals: [{ state: 'valid' }] }).label,
    ).toBe('Approved');
    expect(
      requestHeadline({ state: 'decided', revisionState: 'draft', approvals: [{ state: 'invalidated' }] })
        .label,
    ).toBe('Approval invalidated');
    expect(
      requestHeadline({ state: 'decided', revisionState: 'changes_requested', approvals: [] }).label,
    ).toBe('Changes requested');
    expect(requestHeadline({ state: 'stale', revisionState: 'in_review', approvals: [] }).label).toBe(
      'Stale',
    );
  });
  it('lists every reviewer once with their decision, members first', () => {
    const rows = reviewerRows(
      {
        state: 'open',
        assignees: ['usr_a', 'usr_b'],
        decisions: [
          { deciderKind: 'user', deciderId: 'usr_a', decision: 'request_changes', verifiedEmail: null },
          {
            deciderKind: 'external_reviewer',
            deciderId: 'rl_1',
            decision: 'approve',
            verifiedEmail: 'x@c.example',
          },
        ],
        externalLinks: [
          { id: 'rl_1', email: 'x@c.example', revokedAt: null, expiresAt: '2026-10-01T00:00:00Z' },
          {
            id: 'rl_2',
            email: 'y@c.example',
            revokedAt: '2026-09-20T00:00:00Z',
            expiresAt: '2026-10-01T00:00:00Z',
          },
          { id: 'rl_3', email: 'z@c.example', revokedAt: null, expiresAt: '2026-09-01T00:00:00Z' },
        ],
      },
      (id) => (id === 'usr_a' ? 'Kofi Asare' : id),
      now,
    );
    expect(rows.map((r) => [r.who, r.kind, r.decision])).toEqual([
      ['Kofi Asare', 'Team', 'Changes requested'],
      ['usr_b', 'Team', 'Pending'],
      ['x@c.example', 'External', 'Approved'],
      ['y@c.example', 'External', 'Link revoked'],
      ['z@c.example', 'External', 'Link expired'],
    ]);
  });
  it('marks a comment outdated when its manifest is no longer the one that would publish', () => {
    const r = { manifestHash: 'h1', state: 'open' as const, changedSinceFreeze: [] };
    expect(commentOutdated({ manifestHash: 'h1' }, r)).toBe(false);
    expect(commentOutdated({ manifestHash: 'h0' }, r)).toBe(true);
    expect(commentOutdated({ manifestHash: 'h1' }, { ...r, state: 'stale' })).toBe(true);
    expect(commentOutdated({ manifestHash: 'h1' }, { ...r, changedSinceFreeze: ['captions'] })).toBe(true);
  });
});
