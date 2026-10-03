import { describe, expect, it } from 'vitest';
import { StoredGenerationInputs, videoGenerationInputsOf, type VideoGenerationInputs } from './video-ai';

const video: VideoGenerationInputs = {
  documentKind: 'video',
  jobId: 'svj_1',
  kind: 'recut',
  request: {
    kind: 'recut',
    recut: { instruction: 'Shorter', scope: { kind: 'timeline' }, factIds: [], assetVersionIds: [] },
  },
  inputsHash: 'h',
  templateVersionId: null,
  brandVersionId: 'bv_1',
  scope: { kind: 'timeline' },
  assetVersionIds: [],
  factIds: [],
  modelCallRefs: ['svj:svj_1:1:model:x'],
  costMicros: 10,
  variation: 0,
  templateKey: null,
};
/** STU-1b's (#59) graphic GenerationInputs as it is stored today: no documentKind. */
const graphic = {
  jobId: 'sgj_1',
  kind: 'generate',
  request: { kind: 'brief', brief: { objective: 'Launch' } },
  inputsHash: 'h',
  templateVersionId: 'tv_1',
  brandVersionId: 'bv_1',
  scope: null,
  assetVersionIds: ['av_1'],
  factIds: [],
  modelCallRefs: ['sgj:sgj_1:1:model'],
  costMicros: 10,
  variation: 1,
};

describe('stored generation inputs', () => {
  it('reads the video variant and tolerates graphic rows (with or without a discriminator)', () => {
    expect(StoredGenerationInputs.parse(video)).toEqual(video);
    expect(StoredGenerationInputs.safeParse(graphic).success).toBe(true);
    expect(StoredGenerationInputs.safeParse({ ...graphic, documentKind: 'graphic' }).success).toBe(true);
    expect(videoGenerationInputsOf(video)).toEqual(video);
    expect(videoGenerationInputsOf(graphic)).toBeNull();
    expect(videoGenerationInputsOf({ ...graphic, documentKind: 'graphic' })).toBeNull();
    expect(videoGenerationInputsOf(null)).toBeNull();
  });

  it('never passes a malformed video row off as a graphic one', () => {
    expect(StoredGenerationInputs.safeParse({ ...video, kind: 'nope' }).success).toBe(false);
    expect(videoGenerationInputsOf({ ...video, kind: 'nope' })).toBeNull();
  });
});
