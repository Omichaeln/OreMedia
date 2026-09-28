import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from './machine';
import { responseDraftMachine as m } from './response-draft';

describe('response draft machine (comment inbox replies)', () => {
  it('a human send: draft → queued → sending → sent | failed | outcome_unknown', () => {
    expect(m.transition('draft', 'send')).toBe('queued');
    expect(m.transition('queued', 'begin_send')).toBe('sending');
    expect(m.transition('sending', 'accept')).toBe('sent');
    expect(m.transition('sending', 'fail')).toBe('failed');
    expect(m.transition('sending', 'lose')).toBe('outcome_unknown');
    expect(m.transition('queued', 'fail')).toBe('failed');
    expect(m.transition('draft', 'discard')).toBe('discarded');
  });
  it('a reply that may have been posted never goes back to queued; only sending can be accepted', () => {
    for (const s of m.states) expect(m.next(s, 'begin_send') === null || s === 'queued').toBe(true);
    expect(() => m.transition('queued', 'accept')).toThrow(IllegalTransitionError);
    expect(() => m.transition('queued', 'lose')).toThrow(IllegalTransitionError);
    expect(() => m.transition('draft', 'accept')).toThrow(IllegalTransitionError);
  });
  it('terminal states have no way out, except an unknown outcome the platform later shows was posted', () => {
    for (const s of m.terminal)
      expect(m.events.filter((e) => m.can(s, e))).toEqual(s === 'outcome_unknown' ? ['confirm'] : []);
    expect(m.transition('outcome_unknown', 'confirm')).toBe('sent');
    expect(m.transition('sending', 'confirm')).toBe('sent');
    expect(() => m.transition('failed', 'confirm')).toThrow(IllegalTransitionError);
  });
});
