import { describe, expect, it } from 'vitest';
import { graphicGenerationInputs } from './generation';
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
/** STU-1b's graphic GenerationInputs as rows written before `documentKind` existed hold it. */
const graphic = {
  jobId: 'sgj_1',
  kind: 'generate',
  request: { kind: 'generate', brief: { objective: 'Launch' } },
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
    // Video first: a video row stays video; a graphic row (with or without the discriminator) reads as STU-1b's shape.
    expect(StoredGenerationInputs.parse(graphic)).toMatchObject({ documentKind: 'graphic', jobId: 'sgj_1' });
    expect(StoredGenerationInputs.parse({ ...graphic, documentKind: 'graphic' })).toMatchObject({
      documentKind: 'graphic',
    });
    expect(videoGenerationInputsOf(video)).toEqual(video);
    expect(videoGenerationInputsOf(graphic)).toBeNull();
    expect(videoGenerationInputsOf({ ...graphic, documentKind: 'graphic' })).toBeNull();
    expect(videoGenerationInputsOf(null)).toBeNull();
  });

  it('never passes a malformed video row off as a graphic one', () => {
    expect(StoredGenerationInputs.safeParse({ ...video, kind: 'nope' }).success).toBe(false);
    expect(videoGenerationInputsOf({ ...video, kind: 'nope' })).toBeNull();
    expect(graphicGenerationInputs({ ...video, kind: 'nope' })).toBeNull();
  });

  it('neither reader throws on the other kind, an empty column or an unknown shape', () => {
    for (const raw of [
      video,
      graphic,
      { ...graphic, documentKind: 'graphic' },
      null,
      undefined,
      'x',
      { jobId: 1 },
    ]) {
      expect(() => videoGenerationInputsOf(raw)).not.toThrow();
      expect(() => graphicGenerationInputs(raw)).not.toThrow();
    }
    expect(graphicGenerationInputs(video)).toBeNull();
    expect(graphicGenerationInputs(graphic)).toMatchObject({ documentKind: 'graphic', jobId: 'sgj_1' });
  });
});
