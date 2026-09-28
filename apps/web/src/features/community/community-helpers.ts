import type { Tone } from '@oremedia/ui';
import type { ResponseDraftState } from '@oremedia/contracts/community';

interface Chip {
  tone: Tone;
  label: string;
}

/** A reply's state as the conversation shows it; the glyph and the text carry it, never colour alone. */
export const REPLY_STATE_CHIP: Record<ResponseDraftState, Chip> = {
  draft: { tone: 'neutral', label: 'Draft' },
  queued: { tone: 'info', label: 'Sending' },
  sending: { tone: 'info', label: 'Sending' },
  sent: { tone: 'good', label: 'Sent' },
  failed: { tone: 'critical', label: 'Not posted' },
  outcome_unknown: { tone: 'warning', label: 'May have posted' },
  discarded: { tone: 'neutral', label: 'Discarded' },
};

/** Replies still on their way: the conversation refreshes until none is left. */
export const IN_FLIGHT: ReadonlySet<ResponseDraftState> = new Set(['queued', 'sending']);

export const shortTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Characters the channel counts for a reply: code points (a weighted channel's server check is authoritative). */
export const replyLength = (text: string): number => [...text.trim()].length;
