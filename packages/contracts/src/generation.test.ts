import { describe, expect, it } from 'vitest';
import { GenerationInputs, graphicGenerationInputs } from './generation';

/** A graphic revision's inputs as STU-1b wrote them before `documentKind` existed. */
const legacyRow = () => ({
  jobId: 'sgj_01LEGACYJOB0000000000000',
  kind: 'refine',
  request: {
    kind: 'refine',
    refine: {
      instruction: 'Make the headline shorter',
      scope: { pageId: 'page_1', elementIds: ['el_headline'] },
      action: { kind: 'edit' },
      factIds: [],
      assetVersionIds: [],
    },
  },
  inputsHash: 'a'.repeat(64),
  templateVersionId: null,
  brandVersionId: 'bver_01BRANDVERSION000000000',
  scope: { pageId: 'page_1', elementIds: ['el_headline'] },
  assetVersionIds: [],
  factIds: [],
  modelCallRefs: ['call_1'],
  costMicros: 1200,
  variation: 0,
  acceptedGroupIds: ['g1'],
});

/** A video revision's inputs as STU-3 writes them (VideoGenerationInputs) into the same column. */
const videoRow = () => ({
  documentKind: 'video',
  jobId: 'vaj_01VIDEOJOB00000000000000',
  kind: 'assembly',
  request: {
    kind: 'storyboard',
    brief: { objective: 'Launch the spring range', durationMs: 15000 },
  },
  inputsHash: 'b'.repeat(64),
  templateVersionId: null,
  brandVersionId: 'bver_01BRANDVERSION000000000',
  scope: null,
  assetVersionIds: ['av_1'],
  factIds: [],
  modelCallRefs: ['call_2'],
  costMicros: 3400,
  variation: 0,
  templateKey: 'promo_vertical',
  storyboardHash: 'c'.repeat(64),
});

describe('GenerationInputs (creative_revisions.generation_inputs)', () => {
  it('reads a legacy row without documentKind as graphic', () => {
    const parsed = graphicGenerationInputs(legacyRow());
    expect(parsed).not.toBeNull();
    expect(parsed!.documentKind).toBe('graphic');
    expect(parsed!.jobId).toBe('sgj_01LEGACYJOB0000000000000');
    expect(GenerationInputs.parse(legacyRow()).documentKind).toBe('graphic');
  });

  it('reads a graphic row', () => {
    const row = { ...legacyRow(), documentKind: 'graphic' };
    expect(graphicGenerationInputs(row)).toEqual(GenerationInputs.parse(row));
    expect(graphicGenerationInputs(row)!.documentKind).toBe('graphic');
  });

  it('neither throws on nor reads as graphic a video row', () => {
    expect(() => graphicGenerationInputs(videoRow())).not.toThrow();
    expect(graphicGenerationInputs(videoRow())).toBeNull();
    expect(GenerationInputs.safeParse(videoRow()).success).toBe(false);
    // Even a graphic-looking request does not make a video row graphic: the document kind decides.
    const { request: _request, kind: _kind, ...rest } = videoRow();
    expect(graphicGenerationInputs({ ...rest, kind: 'refine', request: legacyRow().request })).toBeNull();
  });

  it('reads an empty column or an unknown shape as no inputs', () => {
    expect(graphicGenerationInputs(null)).toBeNull();
    expect(graphicGenerationInputs(undefined)).toBeNull();
    expect(graphicGenerationInputs({ documentKind: 'graphic' })).toBeNull();
    expect(graphicGenerationInputs('not json')).toBeNull();
  });
});
