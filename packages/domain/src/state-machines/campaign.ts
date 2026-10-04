import type { z } from 'zod';
import type { CampaignState } from '@oremedia/contracts/content';
import { defineMachine } from './machine';

export type CampaignStateValue = z.infer<typeof CampaignState>;
export type CampaignEvent = 'close';

/** Spec 6.3 campaigns (G12): a draft or active campaign is closed as completed; completed and archived are final. */
export const campaignMachine = defineMachine<CampaignStateValue, CampaignEvent>({
  name: 'campaign',
  states: ['draft', 'active', 'completed', 'archived'],
  events: ['close'],
  table: {
    draft: { close: 'completed' },
    active: { close: 'completed' },
    completed: {},
    archived: {},
  },
  terminal: ['completed', 'archived'],
});
