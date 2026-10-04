import type { RenderJobState } from '@oremedia/contracts/creative';
import { defineMachine } from './machine';

/** `cancel` (STU-2a): a person stops a pending or rendering (video) job; cancelled is terminal. */
export type RenderJobEvent = 'start' | 'succeed' | 'fail' | 'retry' | 'cancel';

export const renderJobMachine = defineMachine<RenderJobState, RenderJobEvent>({
  name: 'render_job',
  states: ['pending', 'rendering', 'ready', 'failed', 'cancelled'],
  events: ['start', 'succeed', 'fail', 'retry', 'cancel'],
  table: {
    pending: { start: 'rendering', cancel: 'cancelled' },
    rendering: { succeed: 'ready', fail: 'failed', cancel: 'cancelled' },
    failed: { retry: 'pending' },
    ready: {},
    cancelled: {},
  },
  terminal: ['ready', 'cancelled'],
});
