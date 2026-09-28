import type { ResponseDraftState } from '@oremedia/contracts/community';
import { defineMachine } from './machine';

export type ResponseDraftEvent =
  | 'send' // a person sends it (inbox.respond): the reply workflow is requested
  | 'begin_send' // committed immediately before the platform call
  | 'accept' // the platform created the reply
  | 'fail' // definitively not posted (rejected, or proven never sent)
  | 'lose' // the call may have reached the platform but its outcome is unknown: never re-sent
  | 'confirm' // a reply whose outcome was unknown (or still sending) was found on the platform by comment ingestion
  | 'discard';

/**
 * Comment inbox replies. A proposal (`draft`) is sent by a person or discarded. A sent reply is queued, then
 * `sending` is committed before the one platform call; from there it is sent, failed, or unknown. Nothing leaves
 * `sending` back to `queued`: a reply that may have been posted is never posted again. The one way out of
 * `outcome_unknown` is `confirm`: ingestion found the brand's own reply on the platform.
 */
export const responseDraftMachine = defineMachine<ResponseDraftState, ResponseDraftEvent>({
  name: 'response_draft',
  states: ['draft', 'queued', 'sending', 'sent', 'failed', 'outcome_unknown', 'discarded'],
  events: ['send', 'begin_send', 'accept', 'fail', 'lose', 'confirm', 'discard'],
  table: {
    draft: { send: 'queued', discard: 'discarded' },
    queued: { begin_send: 'sending', fail: 'failed' },
    sending: { accept: 'sent', fail: 'failed', lose: 'outcome_unknown', confirm: 'sent' },
    sent: {},
    failed: {},
    outcome_unknown: { confirm: 'sent' },
    discarded: {},
  },
  terminal: ['sent', 'failed', 'outcome_unknown', 'discarded'],
});
