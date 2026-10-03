import { describe, expect, it } from 'vitest';
import { VideoProjectV1, type VideoMediaInfo } from '@oremedia/contracts/video';
import { VideoBrief, type GapAlternative, type ModelStoryboardOutput } from '@oremedia/contracts/video-ai';
import { VIDEO_FIXTURE_MEDIA, fixtureVideoProject } from './fixtures';
import { applyVideoBatch } from './reduce';
import {
  checkModelStoryboard,
  compileAssembly,
  isEmptyProject,
  storyboardDurationMs,
  storyboardProblems,
  type StoryboardAsset,
} from './storyboard';
import { blankVideoProject, instantiateVideoTemplate } from './templates';
import { lengthOf } from './time';

const asset = (
  over: Partial<StoryboardAsset> & Pick<StoryboardAsset, 'assetVersionId' | 'kind'>,
): StoryboardAsset => ({
  name: over.assetVersionId,
  altText: null,
  semanticRole: null,
  durationMs: null,
  width: 1920,
  height: 1080,
  hasAudio: false,
  derivatives: [],
  ...over,
});
const ELIGIBLE = new Map(
  [
    asset({
      assetVersionId: 'av_clip_a',
      kind: 'video',
      durationMs: 6_000,
      hasAudio: true,
      derivatives: ['poster', 'strip'],
    }),
    asset({ assetVersionId: 'av_clip_b', kind: 'video', durationMs: 5_000 }),
    asset({ assetVersionId: 'av_still', kind: 'photo' }),
    asset({ assetVersionId: 'av_music', kind: 'audio', durationMs: 20_000, width: null, height: null }),
    asset({ assetVersionId: 'av_logo', kind: 'logo' }),
  ].map((a) => [a.assetVersionId, a]),
);
const ALT: GapAlternative[] = [{ kind: 'ask_for_footage', label: 'Ask for footage', available: true }];
let n = 0;
const checkCtx = (brief = VideoBrief.parse({})) => ({
  brief,
  eligible: ELIGIBLE,
  effectiveFactIds: new Set(['fct_ok']),
  alternatives: () => ALT,
  mint: () => `sb${++n}`,
});

const output = (over: Partial<ModelStoryboardOutput> = {}): ModelStoryboardOutput => ({
  title: 'Launch',
  scenes: [
    {
      title: 'Hook',
      narration: 'Meet the new bottle. It keeps drinks cold for 24 hours.',
      onScreenText: 'Meet the bottle',
      claims: [{ text: 'It keeps drinks cold for 24 hours.', factIds: ['fct_ok'] }],
      shots: [
        {
          description: 'Bottle on a desk',
          assetVersionId: 'av_clip_a',
          sourceInMs: 1_000,
          durationMs: 3_000,
        },
      ],
    },
    {
      title: 'Proof',
      narration: 'Made from recycled steel. Twice as light as glass.',
      claims: [{ text: 'Twice as light as glass.', factIds: ['fct_made_up'] }],
      shots: [
        { description: 'Close up', assetVersionId: 'av_invented', durationMs: 2_000 },
        { description: 'Still of the range', assetVersionId: 'av_still', durationMs: 2_000 },
      ],
    },
  ],
  gaps: [],
  musicAssetVersionId: 'av_music',
  ...over,
});

const MEDIA: Record<string, VideoMediaInfo> = {
  ...VIDEO_FIXTURE_MEDIA,
};
const bindings = {
  fonts: { heading: 'av_font', caption: 'av_font', body: 'av_font' },
  colours: { text: 'paper', box: 'ink' },
  logoAssetVersionId: 'av_logo',
  newElementId: (() => {
    let k = 0;
    return () => `el_01ARZ3NDEKTSV4RRFFQ69G5G${String(++k).padStart(2, '0')}`;
  })(),
};

describe('storyboard check', () => {
  it('keeps eligible assets, refuses invented ones and claims without effective facts, and lists the gaps', () => {
    const { storyboard, refused } = checkModelStoryboard(output(), checkCtx());
    expect(refused.map((r) => r.reason).sort()).toEqual([
      'asset_not_eligible',
      'claim_without_effective_fact',
    ]);
    const proof = storyboard.scenes[1];
    expect(proof?.shots[0]?.assetVersionId).toBeNull();
    expect(proof?.claims).toEqual([]);
    expect(proof?.narration).toBe('Made from recycled steel.');
    expect(storyboard.scenes[0]?.claims).toEqual([
      { text: 'It keeps drinks cold for 24 hours.', factIds: ['fct_ok'] },
    ]);
    expect(storyboard.gaps).toHaveLength(1);
    expect(storyboard.gaps[0]).toMatchObject({ kind: 'footage', sceneId: proof?.id, alternatives: ALT });
    expect(storyboard.musicAssetVersionId).toBe('av_music');
    expect(storyboardDurationMs(storyboard)).toBe(7_000);
  });

  it('never lets a logo or an excluded asset be a shot, and fits shots to their source', () => {
    const brief = VideoBrief.parse({ assets: { exclude: ['av_clip_b'] }, audio: 'voiceover' });
    const { storyboard, refused } = checkModelStoryboard(
      output({
        scenes: [
          {
            title: 'One',
            shots: [
              { description: 'Logo', assetVersionId: 'av_logo', durationMs: 1_000 },
              { description: 'B roll', assetVersionId: 'av_clip_b', durationMs: 1_000 },
              { description: 'Long', assetVersionId: 'av_clip_a', sourceInMs: 5_000, durationMs: 9_000 },
            ],
          },
        ],
      }),
      checkCtx(brief),
    );
    expect(refused.map((r) => r.reason)).toEqual([
      'asset_kind_not_a_shot',
      'asset_not_eligible',
      'shot_longer_than_source',
    ]);
    const long = storyboard.scenes[0]?.shots[2];
    expect(long).toMatchObject({ assetVersionId: 'av_clip_a', sourceInMs: 0, durationMs: 6_000 });
    // Voice-over is asked for: the gap is listed (and no music is used).
    expect(storyboard.gaps.map((g) => g.kind).sort()).toEqual(['footage', 'voiceover']);
    expect(storyboard.musicAssetVersionId).toBeNull();
  });

  it('checks a person’s edited storyboard with the same rules', () => {
    const { storyboard } = checkModelStoryboard(output(), checkCtx());
    const edited = structuredClone(storyboard);
    const first = edited.scenes[0];
    if (!first?.shots[0]) throw new Error('fixture');
    first.shots[0].assetVersionId = 'av_invented';
    first.claims.push({ text: 'Unsupported', factIds: ['fct_made_up'] });
    expect(
      storyboardProblems(edited, checkCtx())
        .map((p) => p.reason)
        .sort(),
    ).toEqual(['asset_not_eligible', 'claim_without_effective_fact']);
    expect(storyboardProblems(storyboard, checkCtx())).toEqual([]);
  });
});

describe('assembly compile', () => {
  const empty = () =>
    blankVideoProject(
      {
        brandVersionId: 'bv_1',
        fonts: bindings.fonts,
        colours: bindings.colours,
        newElementId: bindings.newElementId,
      },
      { formatKey: 'video_9x16', fps: 30 },
    );

  it('compiles the storyboard into clips, scenes, pacing transitions, titles, the logo, captions and music', () => {
    const project = empty();
    expect(isEmptyProject(project)).toBe(true);
    const { storyboard } = checkModelStoryboard(output(), checkCtx());
    const result = compileAssembly(project, storyboard, {
      media: MEDIA,
      bindings,
      idPrefix: 'as',
      logoMinWidthPx: 200,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.groups.map((g) => g.id)).toEqual(['titles', 'captions', 'music', 'clips']);
    const out = VideoProjectV1.parse(
      applyVideoBatch(project, { operations: result.operations }, { media: MEDIA }),
    );
    expect(out).toEqual(result.project);
    expect(out.durationMs).toBe(7_000);
    const v = out.tracks.find((t) => t.kind === 'video');
    expect(v?.items.map((c) => [c.assetVersionId, c.startMs, lengthOf(c)])).toEqual([
      ['av_clip_a', 0, 3_000],
      ['av_still', 5_000, 2_000],
    ]);
    expect(out.scenes.map((s) => [s.title, s.startMs, s.endMs])).toEqual([
      ['Hook', 0, 3_000],
      ['Proof', 3_000, 7_000],
    ]);
    const overlays = out.tracks.find((t) => t.kind === 'overlay')?.items ?? [];
    expect(overlays.map((o) => o.element.type).sort()).toEqual(['logo', 'text']);
    const logo = overlays.find((o) => o.element.type === 'logo');
    expect(logo?.element.transform.width).toBeGreaterThanOrEqual(200);
    expect(logo?.endMs).toBe(7_000);
    const captions = out.tracks.find((t) => t.kind === 'caption')?.items ?? [];
    expect(captions.map((c) => ('text' in c ? c.text : ''))).toEqual([
      'Meet the new bottle.',
      'It keeps drinks cold for 24 hours.',
      'Made from recycled steel.',
    ]);
    const music = out.tracks.find((t) => t.kind === 'audio')?.items[0];
    expect(music).toMatchObject({ assetVersionId: 'av_music', startMs: 0, sourceOutMs: 7_000 });
    expect(result.assetVersionIds.sort()).toEqual(['av_clip_a', 'av_music', 'av_still']);
    expect(result.factIds).toEqual(['fct_ok']);
  });

  it('crossfades between scenes when the pacing is calm and both sides are clips', () => {
    const { storyboard } = checkModelStoryboard(
      output({
        scenes: [
          { title: 'A', shots: [{ description: 'a', assetVersionId: 'av_clip_a', durationMs: 2_000 }] },
          { title: 'B', shots: [{ description: 'b', assetVersionId: 'av_still', durationMs: 2_000 }] },
        ],
      }),
      checkCtx(VideoBrief.parse({ pacing: 'calm' })),
    );
    const result = compileAssembly(empty(), storyboard, { media: MEDIA, bindings, idPrefix: 'as' });
    const second = result.project.tracks.find((t) => t.kind === 'video')?.items[1];
    expect(second && 'transitionIn' in second ? second.transitionIn : null).toEqual({
      kind: 'crossfade',
      durationMs: 600,
    });
  });

  it('fills the template’s title overlays for the scenes they belong to and removes unfilled placeholders', () => {
    const project = instantiateVideoTemplate('promo_vertical_15s', { brandVersionId: 'bv_1', ...bindings });
    if (!project) throw new Error('template');
    const { storyboard } = checkModelStoryboard(
      output({
        scenes: [
          {
            title: 'Hook',
            onScreenText: 'Cold for a day',
            templateSceneId: 'scene_hook',
            shots: [{ description: 'a', assetVersionId: 'av_clip_a', durationMs: 3_000 }],
          },
        ],
      }),
      checkCtx(),
    );
    const result = compileAssembly(project, storyboard, { media: MEDIA, bindings, idPrefix: 'as' });
    const overlays = result.project.tracks.find((t) => t.kind === 'overlay')?.items ?? [];
    const hook = overlays.find((o) => o.id === 'ov_hook_title');
    expect(hook?.element.type === 'text' ? hook.element.text : null).toBe('Cold for a day');
    expect(overlays.some((o) => o.id === 'ov_offer_title')).toBe(false);
    expect(overlays.find((o) => o.id === 'ov_logo')).toMatchObject({ startMs: 500, endMs: 3_000 });
  });

  it('keeps locked clips and reports that the picture could not be assembled over them', () => {
    const project = fixtureVideoProject();
    const v = project.tracks[0];
    if (v?.kind !== 'video') throw new Error('fixture');
    v.items[0] = { ...v.items[0], locked: true } as (typeof v.items)[number];
    const { storyboard } = checkModelStoryboard(output(), checkCtx());
    const result = compileAssembly(
      project,
      storyboard,
      { media: MEDIA, bindings, idPrefix: 'as' },
      new Set(['clips']),
    );
    expect(result.operations).toEqual([]);
    expect(result.conflicts[0]?.code).toBe('locked_item_kept');
  });
});
