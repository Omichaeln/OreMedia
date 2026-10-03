import type { GenerationJobState } from '@oremedia/contracts/generation';
import { defineMachine } from './machine';

export type GenerationJobEvent = 'start' | 'validate' | 'save' | 'complete' | 'fail' | 'cancel' | 'retry';

/**
 * STU-1b studio generation job: queued → generating (model call) → validating (compile, guards, brand validation) →
 * saving (revisions or proposal written) → completed, only after the save committed. Any live state can fail or be
 * cancelled; a failed or cancelled job is retried as a new attempt (back to queued).
 */
export const generationJobMachine = defineMachine<GenerationJobState, GenerationJobEvent>({
  name: 'studio_generation_job',
  states: ['queued', 'generating', 'validating', 'saving', 'completed', 'failed', 'cancelled'],
  events: ['start', 'validate', 'save', 'complete', 'fail', 'cancel', 'retry'],
  table: {
    queued: { start: 'generating', fail: 'failed', cancel: 'cancelled' },
    generating: { validate: 'validating', fail: 'failed', cancel: 'cancelled' },
    validating: { save: 'saving', fail: 'failed', cancel: 'cancelled' },
    saving: { complete: 'completed', fail: 'failed' },
    completed: {},
    failed: { retry: 'queued' },
    cancelled: { retry: 'queued' },
  },
  terminal: ['completed'],
});
