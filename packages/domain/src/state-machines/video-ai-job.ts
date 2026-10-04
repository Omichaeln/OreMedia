import type { VideoAiJobState } from '@oremedia/contracts/video-ai';
import { defineMachine } from './machine';

export type VideoAiJobEvent = 'start' | 'validate' | 'save' | 'complete' | 'fail' | 'cancel' | 'retry';

/**
 * STU-3 studio video AI job (storyboard or recut): queued → generating (the model call) → validating (checks and
 * compile) → saving (storyboard, proposal or new-format document written) → completed, only after the save
 * committed. Any live state before saving can fail or be cancelled; a failed or cancelled job is retried as a new
 * attempt (back to queued).
 */
export const videoAiJobMachine = defineMachine<VideoAiJobState, VideoAiJobEvent>({
  name: 'studio_video_job',
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
