import type { FactState } from '@oremedia/contracts/brand';
import { defineMachine } from './machine';

export type ApprovedFactEvent = 'approve' | 'revoke' | 'supersede';

/**
 * Spec 8.2: proposed → approved → revoked. A proposal can also be withdrawn (revoked) before approval. BSC-3: a fact
 * is superseded when its correction is approved or it is merged into another fact (proposed or approved); revoked
 * and superseded are terminal.
 */
export const approvedFactMachine = defineMachine<FactState, ApprovedFactEvent>({
  name: 'approved_fact',
  states: ['proposed', 'approved', 'revoked', 'superseded'],
  events: ['approve', 'revoke', 'supersede'],
  table: {
    proposed: { approve: 'approved', revoke: 'revoked', supersede: 'superseded' },
    approved: { revoke: 'revoked', supersede: 'superseded' },
    revoked: {},
    superseded: {},
  },
  terminal: ['revoked', 'superseded'],
});
