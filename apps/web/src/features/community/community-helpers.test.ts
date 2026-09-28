import { describe, expect, it } from 'vitest';
import { ResponseDraftState } from '@oremedia/contracts/community';
import { IN_FLIGHT, REPLY_STATE_CHIP, replyLength } from './community-helpers';

describe('comment inbox helpers', () => {
  it('every reply state has a label and a tone; only queued and sending are in flight', () => {
    for (const s of ResponseDraftState.options) expect(REPLY_STATE_CHIP[s].label).not.toBe('');
    expect([...IN_FLIGHT]).toEqual(['queued', 'sending']);
    expect(REPLY_STATE_CHIP.failed.tone).toBe('critical');
  });
  it('counts code points of the trimmed text', () => {
    expect(replyLength('  héllo 👋 ')).toBe(7);
  });
});
