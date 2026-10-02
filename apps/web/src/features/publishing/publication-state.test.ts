import { describe, expect, it } from 'vitest';
import { PublicationState } from '@oremedia/contracts/publishing';
import { RELEASE_CHECK_KEYS } from '@oremedia/contracts/review';
import {
  HOLD_REASON_TEXT,
  PUBLICATION_CHIP,
  actionsFor,
  channelOutcomeSummary,
  dayKey,
  groupByDay,
  holdReasonText,
  isoToZonedInput,
  localMidnight,
  monthGrid,
  outcomeUnknownReasonText,
  plainLength,
  publicationChip,
  rangeFor,
  remoteChangeStatus,
  remoteStatusChip,
  remoteVerificationChip,
  shiftAnchor,
  trailingRange,
  type RemoteChangeLike,
  wasReleased,
  weekDays,
  zonedInputToIso,
} from './publication-state';

describe('publicationChip', () => {
  it('maps every publication state to a chip with text and a tone', () => {
    for (const state of PublicationState.options) {
      const chip = publicationChip(state);
      expect(chip.label.length).toBeGreaterThan(0);
      expect(chip.detail.length).toBeGreaterThan(0);
      expect(chip).toBe(PUBLICATION_CHIP[state]);
    }
  });
  it('names an unknown state instead of guessing', () => {
    expect(publicationChip('exploded').label).toBe('Unknown state (exploded)');
    expect(publicationChip('exploded').tone).toBe('neutral');
  });
  it('a published article shows what the website holds (RA-02): a draft, live or reverted, never a bare Published', () => {
    expect(publicationChip('published', 'draft').label).toBe('Draft saved');
    expect(publicationChip('published', 'live').label).toBe('Live');
    expect(publicationChip('published', 'reverted')).toMatchObject({ label: 'Reverted', tone: 'warning' });
    expect(publicationChip('published', null).label).toBe('Published'); // a channel post
    expect(publicationChip('scheduled', 'live').label).toBe('Scheduled'); // only once published
    expect(publicationChip('published', 'odd').label).toBe('Published'); // unknown remote status: not guessed
    expect(remoteStatusChip('live')?.tone).toBe('good');
    expect(remoteVerificationChip('failed')).toMatchObject({
      label: 'Verification failed',
      tone: 'critical',
    });
    expect(remoteVerificationChip('unverified')?.tone).toBe('neutral');
    expect(remoteVerificationChip(null)).toBeNull();
  });
  it('explains outcome_unknown and marks it as needing attention', () => {
    expect(PUBLICATION_CHIP.outcome_unknown.tone).toBe('warning');
    expect(PUBLICATION_CHIP.outcome_unknown.detail).toContain('reconciled');
  });
});

describe('holdReasonText', () => {
  it('has text for every release check key of spec 13.4', () => {
    for (const key of RELEASE_CHECK_KEYS) expect(HOLD_REASON_TEXT[key]).toBeTruthy();
  });
  it('explains the restore hold (spec 17.6): only a never-sent publication is held by a restore', () => {
    expect(holdReasonText('restored_from_backup')).toContain('restored from a backup');
    expect(holdReasonText('restored_from_backup')).toContain('never sent');
  });
  it('never invents an explanation for an unknown key', () => {
    expect(holdReasonText('something_new')).toBe('No explanation is recorded for this reason.');
  });
});

describe('outcomeUnknownReasonText', () => {
  it('explains a restored row that may already be live (spec 17.6) and offers reconciliation', () => {
    expect(outcomeUnknownReasonText('restored_from_backup')).toContain('restored from a backup');
    expect(outcomeUnknownReasonText('restored_from_backup')).toContain('may already be live');
    expect(actionsFor('outcome_unknown')).toMatchObject({ reconcile: true, release: false });
  });
  it('has no text for a missing or unknown reason (the key is still shown)', () => {
    expect(outcomeUnknownReasonText(null)).toBeNull();
    expect(outcomeUnknownReasonText('something_new')).toBeNull();
  });
});

describe('actionsFor', () => {
  it('follows the spec 13.1 transition table', () => {
    expect(actionsFor('scheduled')).toMatchObject({ cancel: true, reschedule: true, cancelInFlight: false });
    expect(actionsFor('dispatching')).toMatchObject({
      cancel: true,
      cancelInFlight: true,
      reschedule: false,
    });
    expect(actionsFor('outcome_unknown')).toMatchObject({ reconcile: true, cancelInFlight: true });
    expect(actionsFor('held')).toMatchObject({ cancel: true, release: true, reconcile: true });
    expect(actionsFor('retry_eligible')).toMatchObject({ release: true, cancel: false });
    expect(actionsFor('published')).toMatchObject({ cancel: false, deleteRemote: true, editRemote: true });
    expect(actionsFor('removed')).toMatchObject({ cancel: false, deleteRemote: false, editRemote: false });
    expect(actionsFor('failed')).toMatchObject({ cancel: false, reschedule: false, release: false });
    expect(actionsFor('cancelled')).toMatchObject({ cancel: false, reschedule: false });
  });
});

describe('brand-zone form values (UX-06)', () => {
  it('reads a datetime-local value as the brand zone, not the viewer zone', () => {
    expect(zonedInputToIso('2026-07-01T09:00', 'Europe/London')).toBe('2026-07-01T08:00:00.000Z'); // BST
    expect(zonedInputToIso('2026-01-15T09:00', 'Europe/London')).toBe('2026-01-15T09:00:00.000Z'); // GMT
    expect(zonedInputToIso('2026-07-01T09:00', 'Asia/Kolkata')).toBe('2026-07-01T03:30:00.000Z');
    expect(zonedInputToIso('2026-07-01T09:00', 'UTC')).toBe('2026-07-01T09:00:00.000Z');
  });
  it('settles across a DST change and round-trips with the formatter', () => {
    // 29 March 2026 01:30 Europe/London does not exist (clocks go forward at 01:00); the instant lands after it.
    expect(zonedInputToIso('2026-03-29T01:30', 'Europe/London')).toBe('2026-03-29T01:30:00.000Z');
    for (const [iso, zone] of [
      ['2026-07-01T08:00:00.000Z', 'Europe/London'],
      ['2026-11-05T23:30:00.000Z', 'America/Los_Angeles'],
      ['2026-02-01T12:00:00.000Z', 'Australia/Sydney'],
    ] as const) {
      expect(zonedInputToIso(isoToZonedInput(iso, zone), zone)).toBe(iso);
    }
    expect(isoToZonedInput('2026-07-01T08:00:00.000Z', 'Europe/London')).toBe('2026-07-01T09:00');
    expect(zonedInputToIso('', 'UTC')).toBeNull();
    expect(zonedInputToIso('not a date', 'UTC')).toBeNull();
  });
});

describe('calendar grouping', () => {
  it('keys days in the brand time zone', () => {
    expect(dayKey('2026-09-24T23:30:00.000Z', 'UTC')).toBe('2026-09-24');
    expect(dayKey('2026-09-24T23:30:00.000Z', 'Europe/Berlin')).toBe('2026-09-25');
    expect(dayKey('2026-09-24T02:30:00.000Z', 'America/Los_Angeles')).toBe('2026-09-23');
  });
  it('groups by day and orders each day by time', () => {
    const grouped = groupByDay(
      [
        { id: 'b', scheduledFor: '2026-09-24T10:00:00.000Z' },
        { id: 'a', scheduledFor: '2026-09-24T08:00:00.000Z' },
        { id: 'c', scheduledFor: '2026-09-25T08:00:00.000Z' },
      ],
      'UTC',
    );
    expect([...grouped.keys()]).toEqual(['2026-09-24', '2026-09-25']);
    expect(grouped.get('2026-09-24')?.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('calendar grids', () => {
  it('draws six Monday-first weeks around the month', () => {
    const grid = monthGrid('2026-09-15');
    expect(grid).toHaveLength(42);
    expect(grid[0]?.key).toBe('2026-08-31'); // Monday before 1 September 2026 (a Tuesday)
    expect(grid[0]?.inMonth).toBe(false);
    expect(grid[1]?.key).toBe('2026-09-01');
    expect(grid[1]?.inMonth).toBe(true);
    expect(grid.filter((d) => d.inMonth)).toHaveLength(30);
  });
  it('draws the week containing the anchor', () => {
    const week = weekDays('2026-09-24'); // Thursday
    expect(week.map((d) => d.key)).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ]);
  });
  it('shifts by a month or a week', () => {
    expect(shiftAnchor('2026-01-31', 'month', 1)).toBe('2026-02-01');
    expect(shiftAnchor('2026-03-01', 'month', -1)).toBe('2026-02-01');
    expect(shiftAnchor('2026-09-24', 'week', 1)).toBe('2026-10-01');
  });
  it('computes local midnight in a zone', () => {
    expect(localMidnight('2026-09-24', 'UTC').toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(localMidnight('2026-09-24', 'Europe/Berlin').toISOString()).toBe('2026-09-23T22:00:00.000Z');
    expect(localMidnight('2026-09-24', 'America/Los_Angeles').toISOString()).toBe('2026-09-24T07:00:00.000Z');
  });
  it('covers the whole grid in the range request', () => {
    const r = rangeFor('week', '2026-09-24', 'UTC');
    expect(r.from).toBe('2026-09-21T00:00:00.000Z');
    expect(r.to).toBe('2026-09-27T23:59:59.999Z');
  });
  it('a trailing period ends with today and starts days - 1 local midnights back', () => {
    expect(trailingRange(7, '2026-09-25', 'UTC')).toEqual({
      from: '2026-09-19T00:00:00.000Z',
      to: '2026-09-25T23:59:59.999Z',
    });
    expect(trailingRange(1, '2026-09-25', 'Europe/Berlin').from).toBe('2026-09-24T22:00:00.000Z');
  });
});

describe('channelOutcomeSummary', () => {
  it('names every non-success and flags partial success (spec 14.4)', () => {
    const s = channelOutcomeSummary([{ state: 'published' }, { state: 'failed' }, { state: 'held' }]);
    expect(s.partial).toBe(true);
    expect(s.text).toBe('1 published, 1 failed, 1 held of 3 channels.');
  });
  it('is not partial when everything published or nothing did', () => {
    expect(channelOutcomeSummary([{ state: 'published' }, { state: 'published' }]).partial).toBe(false);
    expect(channelOutcomeSummary([{ state: 'failed' }]).partial).toBe(false);
    expect(channelOutcomeSummary([]).text).toBe('No channels.');
  });
  it('does not count a cancelled channel against success', () => {
    expect(channelOutcomeSummary([{ state: 'published' }, { state: 'cancelled' }]).partial).toBe(false);
  });
  it('a post deleted from its channel was still released (its metrics stay on Performance)', () => {
    expect(['published', 'removed', 'failed', 'cancelled'].map(wasReleased)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
  it('never counts an article the website holds as a draft, or reverted, as published (RA-02)', () => {
    const s = channelOutcomeSummary([
      { state: 'published', remoteStatus: 'live' },
      { state: 'published', remoteStatus: 'draft' },
      { state: 'published', remoteStatus: 'reverted' },
      { state: 'published', remoteStatus: null },
    ]);
    expect(s).toMatchObject({ published: 2, drafts: 1, reverted: 1, partial: false });
    expect(s.text).toBe(
      '2 published, 1 saved as a draft on the website, 1 reverted to a draft of 4 channels.',
    );
    expect(channelOutcomeSummary([{ state: 'published', remoteStatus: 'draft' }]).published).toBe(0);
  });
  it('names a post deleted from its channel and does not count it as a failure', () => {
    const s = channelOutcomeSummary([{ state: 'published' }, { state: 'removed' }]);
    expect(s.partial).toBe(false);
    expect(s.text).toBe('1 published, 1 deleted from the channel of 2 channels.');
  });
});

describe('remote changes of a published post', () => {
  const change = (over: Partial<RemoteChangeLike>): RemoteChangeLike => ({
    kind: 'edit',
    state: 'succeeded',
    errorCode: null,
    errorDetail: null,
    requestedAt: '2026-09-24T10:00:00.000Z',
    finishedAt: '2026-09-24T10:00:05.000Z',
    ...over,
  });
  it('an open change blocks the actions; a failure shows only while it is the latest', () => {
    expect(remoteChangeStatus([])).toEqual({ open: null, stale: null, failed: null });
    const open = change({ kind: 'delete', state: 'requested', finishedAt: null });
    expect(remoteChangeStatus([open, change({ state: 'failed' })])).toEqual({
      open,
      stale: null,
      failed: null,
    });
    const failed = change({ state: 'failed', errorCode: 'content_policy' });
    expect(remoteChangeStatus([failed, change({})]).failed).toBe(failed);
    expect(remoteChangeStatus([change({}), failed]).failed).toBeNull();
  });
  it('a stale request (no outcome in time) no longer blocks: it is reported as stale, not open', () => {
    const stale = change({ kind: 'edit', state: 'requested', finishedAt: null, stale: true });
    expect(remoteChangeStatus([stale])).toEqual({ open: null, stale, failed: null });
  });
  it('counts characters the way the capability check does (NFC code points)', () => {
    expect(plainLength('e\u0301')).toBe(1);
    expect(plainLength('👍 ok')).toBe(4);
  });
});
