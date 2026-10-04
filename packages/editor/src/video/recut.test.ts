import { describe, expect, it } from 'vitest';
import type { WaveformV1 } from '@oremedia/contracts/media';
import { VideoProjectV1, type VideoProjectV1 as Project } from '@oremedia/contracts/video';
import type { RecutAction } from '@oremedia/contracts/video-ai';
import { VIDEO_FIXTURE_MEDIA, fixtureVideoProject } from './fixtures';
import { videoScopeOf } from './guard';
import { applyVideoBatch } from './reduce';
import {
  brandCtaCopy,
  compileRecut,
  mergeCuts,
  planDurationFit,
  planSilenceTrim,
  reframeProject,
  timeMapper,
  type RecutContext,
} from './recut';
import { contentEndMs, lengthOf } from './time';
import { looksLikeClaim } from '../validate';

const bindings = {
  fonts: { heading: 'av_font', caption: 'av_font' },
  colours: { text: 'paper', box: 'ink' },
  newElementId: (() => {
    let n = 0;
    return () => `el_01ARZ3NDEKTSV4RRFFQ69G5F${String(++n).padStart(2, '0')}`;
  })(),
};

const ctx = (over: Partial<RecutContext> = {}): RecutContext => ({
  media: VIDEO_FIXTURE_MEDIA,
  bindings,
  idPrefix: 'rc',
  waveforms: {},
  eligibleAssetIds: new Set(['av_clip_a', 'av_clip_b', 'av_still']),
  effectiveFactIds: new Set(['fct_1']),
  scope: null,
  script: [{ sceneId: 'scene_2', narration: 'It folds flat. It fits any bag you carry.' }],
  approvedCtas: ['Order today', 'Twice as fast'],
  ...over,
});

/** The compile's operations, replayed through the reducer from the original project, give the compile's project. */
function replay(project: Project, result: ReturnType<typeof compileRecut>): Project {
  if (!result.operations.length) return project;
  const out = applyVideoBatch(project, { operations: result.operations }, { media: VIDEO_FIXTURE_MEDIA });
  expect(out).toEqual(result.project);
  return VideoProjectV1.parse(out);
}

/** A waveform for av_clip_a (6 s, 20 peaks/s): loud except quiet from 2.0 s to 3.2 s of the source. */
const waveform = (): WaveformV1 => ({
  schemaVersion: 1,
  peaksPerSecond: 20,
  durationMs: 6_000,
  peaks: Array.from({ length: 120 }, (_, i) => (i >= 40 && i < 64 ? 5 : 600)),
});

/** The fixture without its music bed (it spans both scenes, so scenes could not be reordered). */
const withoutMusic = (): Project => {
  const p = fixtureVideoProject();
  p.tracks = p.tracks.filter((t) => t.kind !== 'audio');
  return p;
};

/** The fixture with a narration track (a voice over the whole 10 s), locked when asked. */
const withNarration = (locked = false): Project => {
  const p = fixtureVideoProject();
  p.tracks.push({
    id: 'trk_voice',
    kind: 'audio',
    name: 'Narration',
    locked: false,
    muted: false,
    items: [
      {
        id: 'aud_voice',
        assetVersionId: 'av_music',
        sourceInMs: 0,
        sourceOutMs: 10_000,
        startMs: 0,
        gainDb: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        muted: false,
        locked,
      },
    ],
  });
  return p;
};

const lockClip = (p: Project, id: string): Project => {
  const v = p.tracks[0];
  if (v?.kind !== 'video') throw new Error('fixture');
  v.items = v.items.map((c) => (c.id === id ? { ...c, locked: true } : c));
  return p;
};

describe('cut arithmetic', () => {
  it('merges overlapping cuts and maps times past them', () => {
    expect(
      mergeCuts([
        { startMs: 5, endMs: 9 },
        { startMs: 1, endMs: 3 },
        { startMs: 2, endMs: 4 },
      ]),
    ).toEqual([
      { startMs: 1, endMs: 4 },
      { startMs: 5, endMs: 9 },
    ]);
    const map = timeMapper([{ startMs: 1_000, endMs: 2_000 }]);
    expect(map(500)).toBe(500);
    expect(map(1_500)).toBe(1_000);
    expect(map(3_000)).toBe(2_000);
  });
});

describe('duration-fit planner', () => {
  it('trims clip tails in proportion to what each can give, and the compile retimes the rest', () => {
    const project = fixtureVideoProject();
    const plan = planDurationFit(project, 7_000, null);
    expect(plan.conflict).toBeNull();
    const removed = plan.cuts.reduce((s, c) => s + c.endMs - c.startMs, 0);
    expect(removed).toBe(3_000);
    const result = compileRecut(project, [{ kind: 'fit_duration', targetMs: 7_000 }], ctx());
    expect(result.conflicts).toEqual([]);
    const out = replay(project, result);
    expect(out.durationMs).toBe(7_000);
    expect(contentEndMs(out)).toBeLessThanOrEqual(7_000);
    const v = out.tracks[0];
    if (v?.kind !== 'video') throw new Error('fixture');
    for (const c of v.items) expect(lengthOf(c)).toBeGreaterThanOrEqual(1_000);
    // Scenes follow the picture and stay contiguous.
    expect(out.scenes.at(-1)?.endMs).toBeLessThanOrEqual(7_000);
    expect(result.groups[0]?.changes.some((c) => c.kind === 'trimmed')).toBe(true);
  });

  it('reports a conflict when locked material is longer than the target, and cuts nothing', () => {
    const project = lockClip(lockClip(fixtureVideoProject(), 'clip_b'), 'clip_c');
    const plan = planDurationFit(project, 5_000, null);
    expect(plan.cuts).toEqual([]);
    expect(plan.conflict?.code).toBe('locked_exceeds_target');
    expect(plan.conflict?.message).toMatch(/at least/);
    const result = compileRecut(project, [{ kind: 'fit_duration', targetMs: 5_000 }], ctx());
    expect(result.operations).toEqual([]);
    expect(result.conflicts.map((c) => c.code)).toContain('locked_exceeds_target');
  });

  it('never cuts before a locked clip (it would move); only what follows the last locked clip may change', () => {
    const project = lockClip(fixtureVideoProject(), 'clip_b');
    const plan = planDurationFit(project, 9_000, null);
    expect(plan.conflict).toBeNull();
    for (const cut of plan.cuts) expect(cut.startMs).toBeGreaterThanOrEqual(7_000);
    const result = compileRecut(project, [{ kind: 'fit_duration', targetMs: 9_000 }], ctx());
    const out = replay(project, result);
    const b = out.tracks[0]?.items.find((i) => i.id === 'clip_b');
    expect(b).toEqual(project.tracks[0]?.items.find((i) => i.id === 'clip_b'));
    expect(out.durationMs).toBe(9_000);
  });

  it('keeps clips outside the scope and says the target was not reached', () => {
    const project = fixtureVideoProject();
    const result = compileRecut(
      project,
      [{ kind: 'fit_duration', targetMs: 4_000 }],
      ctx({ scope: { kind: 'items', itemIds: ['clip_c'] } }),
    );
    expect(result.conflicts.map((c) => c.code)).toContain('target_too_short');
  });
});

describe('silence-trim planner', () => {
  it('finds the quiet run in the waveform and removes it, keeping a little quiet each side', () => {
    const project = fixtureVideoProject();
    const plan = planSilenceTrim(
      project,
      { media: VIDEO_FIXTURE_MEDIA, waveforms: { av_clip_a: waveform() } },
      null,
    );
    // clip_a plays source 1-5 s from 0 s: the pause at source 2.0-3.2 s is timeline 1.0-2.2 s, minus 150 ms each side.
    expect(plan.cuts).toEqual([{ startMs: 1_150, endMs: 2_050 }]);
    // clip_b has no sound and clip_c is a still: B is named, the still ignored.
    expect(plan.skipped).toEqual(['B']);
  });

  it('compiles a tighten action into a split and a ripple trim, and the later items close up', () => {
    const project = fixtureVideoProject();
    const result = compileRecut(
      project,
      [{ kind: 'tighten' }],
      ctx({ waveforms: { av_clip_a: waveform() } }),
    );
    const ops = result.operations.map((o) => o.op);
    // clip_b's 1 s crossfade no longer fits the 1.95 s left of A after the pause, so it is shortened first.
    expect(ops.slice(0, 3)).toEqual(['setTransition', 'splitClip', 'trimClip']);
    const out = replay(project, result);
    expect(out.durationMs).toBe(10_000 - 900);
    const b = out.tracks[0]?.items.find((i) => i.id === 'clip_b');
    expect(b?.startMs).toBe(4_000 - 900);
    expect(result.conflicts.map((c) => c.code)).toContain('no_waveform');
  });

  it('cuts narration at the same spans as the picture (in sync); the music bed only ends earlier', () => {
    const project = withNarration();
    const result = compileRecut(
      project,
      [{ kind: 'tighten' }],
      ctx({ waveforms: { av_clip_a: waveform() } }),
    );
    const out = replay(project, result);
    const voice = out.tracks.find((t) => t.id === 'trk_voice')?.items ?? [];
    // The pause at 1.15-2.05 s is gone from the voice too: what played at 2.05 s now plays at 1.15 s.
    expect(voice.map((a) => ('sourceInMs' in a ? [a.startMs, a.sourceInMs, a.sourceOutMs] : null))).toEqual([
      [0, 0, 1_150],
      [1_150, 2_050, 10_000],
    ]);
    const music = out.tracks.find((t) => t.id === 'trk_music')?.items[0];
    expect(music).toMatchObject({ startMs: 0, sourceInMs: 0, sourceOutMs: 10_000 - 900 });
    expect(result.conflicts.map((c) => c.code)).not.toContain('sound_out_of_sync');
  });

  it('reads the music bed from the track’s role, not its name', () => {
    const project = withNarration();
    const voice = project.tracks.find((t) => t.id === 'trk_voice');
    if (voice?.kind !== 'audio') throw new Error('fixture');
    voice.name = 'Music for the voice'; // a name says nothing
    const asSound = compileRecut(
      project,
      [{ kind: 'tighten' }],
      ctx({ waveforms: { av_clip_a: waveform() } }),
    );
    expect(replay(project, asSound).tracks.find((t) => t.id === 'trk_voice')?.items).toHaveLength(2);
    voice.role = 'music'; // the role does
    const asMusic = compileRecut(
      project,
      [{ kind: 'tighten' }],
      ctx({ waveforms: { av_clip_a: waveform() } }),
    );
    const bed = replay(project, asMusic).tracks.find((t) => t.id === 'trk_voice')?.items ?? [];
    expect(bed).toHaveLength(1);
    expect(bed[0]).toMatchObject({ startMs: 0, sourceOutMs: 10_000 - 900 });
  });

  it('reports narration it may not cut (locked) as out of sync instead of trimming its tail', () => {
    const project = withNarration(true);
    const result = compileRecut(
      project,
      [{ kind: 'tighten' }],
      ctx({ waveforms: { av_clip_a: waveform() } }),
    );
    const out = replay(project, result);
    expect(out.tracks.find((t) => t.id === 'trk_voice')?.items).toEqual(
      project.tracks.find((t) => t.id === 'trk_voice')?.items,
    );
    expect(result.conflicts.map((c) => c.code)).toContain('sound_out_of_sync');
  });

  it('leaves a scope that holds no sound alone and says so', () => {
    const project = fixtureVideoProject();
    const result = compileRecut(
      project,
      [{ kind: 'tighten' }],
      ctx({ waveforms: { av_clip_a: waveform() }, scope: { kind: 'items', itemIds: ['clip_c'] } }),
    );
    expect(result.operations).toEqual([]);
    expect(result.conflicts.map((c) => c.code)).toContain('no_pauses');
  });
});

describe('recut compile', () => {
  it('moves the second scene before the first (scene reorder), titles and captions travel with it', () => {
    const project = withoutMusic();
    const result = compileRecut(project, [{ kind: 'reorder_scenes', order: ['scene_2', 'scene_1'] }], ctx());
    const out = replay(project, result);
    expect(out.scenes.map((s) => s.id)).toEqual(['scene_2', 'scene_1']);
    expect(out.tracks[0]?.items.find((i) => i.id === 'clip_a')?.startMs).toBe(6_000);
    expect(out.tracks[1]?.items[0]).toMatchObject({ id: 'ov_title', startMs: 6_500 });
  });

  it('reports the reducer’s reason when scenes cannot be reordered (music spans both)', () => {
    const result = compileRecut(
      fixtureVideoProject(),
      [{ kind: 'reorder_scenes', order: ['scene_2', 'scene_1'] }],
      ctx(),
    );
    expect(result.operations).toEqual([]);
    expect(result.conflicts[0]?.code).toBe('item_crosses_scene');
  });

  it('keeps only the named clips and closes the gaps', () => {
    const project = fixtureVideoProject();
    const result = compileRecut(project, [{ kind: 'keep_only', itemIds: ['clip_a', 'clip_c'] }], ctx());
    const out = replay(project, result);
    const v = out.tracks[0];
    expect(v?.items.map((i) => i.id)).toEqual(['clip_a', 'clip_c']);
    expect(v?.items[1]?.startMs).toBe(4_000);
    expect(out.durationMs).toBe(7_000);
  });

  it('replaces the opening shot with an eligible asset and leaves the rest as it was', () => {
    const project = fixtureVideoProject();
    const result = compileRecut(
      project,
      [{ kind: 'replace_source', itemId: 'clip_a', assetVersionId: 'av_still' }],
      ctx({ scope: { kind: 'items', itemIds: ['clip_a'] } }),
    );
    const out = replay(project, result);
    expect(out.tracks[0]?.items[0]).toMatchObject({ assetVersionId: 'av_still' });
    expect(out.tracks[0]?.items.slice(1)).toEqual(project.tracks[0]?.items.slice(1));
    expect(result.assetVersionIds).toEqual(['av_still']);
  });

  it('refuses an asset outside the eligible set as a conflict', () => {
    const result = compileRecut(
      fixtureVideoProject(),
      [{ kind: 'replace_source', itemId: 'clip_a', assetVersionId: 'av_made_up' }],
      ctx(),
    );
    expect(result.operations).toEqual([]);
    expect(result.conflicts[0]?.code).toBe('asset_not_eligible');
  });

  it('adds captions from the script and a call to action citing an effective fact', () => {
    const project = fixtureVideoProject();
    const actions: RecutAction[] = [
      { kind: 'add_captions', sceneIds: ['scene_2'] },
      { kind: 'add_cta', text: 'Order today', factIds: ['fct_1'] },
    ];
    const result = compileRecut(project, actions, ctx());
    expect(result.conflicts).toEqual([]);
    const out = replay(project, result);
    const captions = out.tracks.find((t) => t.kind === 'caption');
    const added = captions?.items.filter((c) => c.startMs >= 4_000) ?? [];
    expect(added.map((c) => ('text' in c ? c.text : ''))).toEqual([
      'It folds flat.',
      'It fits any bag you carry.',
    ]);
    const cta = out.tracks.find((t) => t.kind === 'overlay')?.items.find((o) => o.startMs === 7_000);
    expect(cta && 'element' in cta && cta.element.type === 'text' ? cta.element.factRefs : null).toEqual([
      'fct_1',
    ]);
    expect(result.groups.map((g) => g.id)).toEqual(['a1', 'a2']);
    expect(result.factIds).toEqual(['fct_1']);
  });

  it('reports missing messaging and claims without effective facts instead of inventing them', () => {
    const result = compileRecut(
      fixtureVideoProject(),
      [
        { kind: 'add_cta', text: '', factIds: [] },
        { kind: 'add_cta', text: 'Twice as fast', factIds: ['fct_unknown'] },
      ],
      ctx(),
    );
    expect(result.operations).toEqual([]);
    expect(result.conflicts.map((c) => c.code)).toEqual(['required_messaging_missing', 'claim_without_fact']);
  });

  it('places the approved wording (not the model’s casing) and asks a claim-like call to action for a fact', () => {
    const result = compileRecut(
      fixtureVideoProject(),
      [{ kind: 'add_cta', text: 'order TODAY', factIds: [] }],
      ctx(),
    );
    const cta = replay(fixtureVideoProject(), result)
      .tracks.find((t) => t.kind === 'overlay')
      ?.items.find((o) => o.startMs === 7_000);
    expect(cta && 'element' in cta && cta.element.type === 'text' ? cta.element.text : null).toBe(
      'Order today',
    );
    const claim = compileRecut(
      fixtureVideoProject(),
      [{ kind: 'add_cta', text: 'Twice as fast', factIds: [] }],
      ctx(),
    );
    expect(claim.operations).toEqual([]);
    expect(claim.conflicts.map((c) => c.code)).toEqual(['claim_without_fact']);
  });

  it('takes only short CTA copy from the brand’s channel guidance, never prose about CTAs', () => {
    expect(brandCtaCopy('Learn more')).toBe('Learn more');
    expect(brandCtaCopy(' Shop the range. ')).toBe('Shop the range');
    expect(brandCtaCopy('Use a soft CTA, e.g. learn more')).toBeNull();
    expect(brandCtaCopy('Always end with a question that invites the reader to reply')).toBeNull();
    expect(brandCtaCopy('')).toBeNull();
    // Plain CTA copy (free, first, a phone number) is not a claim; measures, comparisons and rankings are.
    const plain = [
      'Learn more',
      'Shop the range',
      'Book a demo',
      'Try it free',
      'Book your first lesson',
      'Call 0800 123 4567',
      'Open from 9 to 5',
    ];
    expect(plain.filter(looksLikeClaim)).toEqual([]);
    const claims = ['Save 20%', 'Twice as fast', 'The best bottle', '2x colder', 'From £9', 'The #1 bottle'];
    expect(claims.filter((c) => !looksLikeClaim(c))).toEqual([]);
  });

  it('takes caption text from the storyboard script only, and places only an approved call to action', () => {
    const result = compileRecut(
      fixtureVideoProject(),
      [
        { kind: 'add_captions', sceneIds: ['scene_1'] },
        { kind: 'add_cta', text: 'Buy now, the best deal in the world', factIds: [] },
      ],
      ctx(),
    );
    expect(result.operations).toEqual([]);
    expect(result.conflicts.map((c) => c.code)).toEqual(['required_messaging_missing', 'cta_not_approved']);
    const none = compileRecut(
      fixtureVideoProject(),
      [{ kind: 'add_cta', text: 'Order today', factIds: [] }],
      ctx({ approvedCtas: [] }),
    );
    expect(none.conflicts.map((c) => c.code)).toEqual(['required_messaging_missing']);
  });

  it('recompiles only the groups a person kept', () => {
    const project = fixtureVideoProject();
    const actions: RecutAction[] = [
      { kind: 'keep_only', itemIds: ['clip_a', 'clip_c'] },
      { kind: 'add_cta', text: 'Order today', factIds: [] },
    ];
    const partial = compileRecut(project, actions, ctx(), new Set(['a2']));
    expect(partial.groups.map((g) => g.id)).toEqual(['a2']);
    const out = replay(project, partial);
    expect(out.tracks[0]?.items).toHaveLength(3);
  });

  it('makes a vertical version as a new project and never touches the original', () => {
    const wide = fixtureVideoProject();
    wide.format = { key: 'video_16x9', width: 1920, height: 1080, fps: 30 };
    const before = structuredClone(wide);
    const result = compileRecut(
      wide,
      [
        {
          kind: 'vertical_version',
          formatKey: 'video_9x16',
          focus: [{ itemId: 'clip_a', focalX: 0.7, focalY: 0.4 }],
        },
      ],
      ctx(),
    );
    expect(wide).toEqual(before);
    expect(result.operations).toEqual([]);
    const v = result.version;
    expect(v?.project.format).toMatchObject({ key: 'video_9x16', width: 1080, height: 1920 });
    expect(v?.project.tracks[0]?.items[0]).toMatchObject({
      frame: { fit: 'fill', focalX: 0.7, focalY: 0.4 },
    });
    expect(() => VideoProjectV1.parse(v?.project)).not.toThrow();
    expect(result.groups).toEqual([]);
    expect(v?.changes.some((c) => c.target === 'format')).toBe(true);
  });

  it('reframes the original for a new version even after other actions, which stay a proposal', () => {
    const wide = fixtureVideoProject();
    wide.format = { key: 'video_16x9', width: 1920, height: 1080, fps: 30 };
    const result = compileRecut(
      wide,
      [
        { kind: 'keep_only', itemIds: ['clip_a'] },
        { kind: 'vertical_version', formatKey: 'video_9x16', focus: [] },
      ],
      ctx(),
    );
    expect(result.groups.map((g) => g.id)).toEqual(['a1']);
    expect(result.version?.project.tracks[0]?.items).toHaveLength(3);
  });

  it('keeps locked items and the logo’s size in a new version', () => {
    const wide = fixtureVideoProject();
    wide.format = { key: 'video_16x9', width: 1920, height: 1080, fps: 30 };
    const v = wide.tracks[0];
    const o = wide.tracks[1];
    if (v?.kind !== 'video' || o?.kind !== 'overlay') throw new Error('fixture');
    v.items[1] = { ...v.items[1], locked: true } as (typeof v.items)[number];
    o.items.push({
      id: 'ov_logo',
      startMs: 8_000,
      endMs: 10_000,
      locked: false,
      element: {
        id: 'el_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        name: 'Logo',
        type: 'logo',
        locked: false,
        visible: true,
        opacity: 1,
        protected: true,
        transform: { x: 1500, y: 900, width: 300, height: 150, rotation: 0 },
        assetVersionId: 'av_logo',
        variant: 'primary',
      },
    });
    const framed = reframeProject(wide, 'video_9x16');
    expect(framed.project.tracks[0]?.items[1]).toEqual(v.items[1]);
    expect(framed.conflicts.map((c) => c.code)).toEqual(['locked_item_kept']);
    const logo = framed.project.tracks[1]?.items.find((i) => i.id === 'ov_logo');
    if (!logo || !('element' in logo)) throw new Error('logo');
    expect(logo.element.transform).toMatchObject({ width: 300, height: 150 });
    expect(logo.element.transform.y + 150).toBeLessThanOrEqual(1920 - 320);
  });

  it('reframes titles into the new safe width', () => {
    const wide = fixtureVideoProject();
    wide.format = { key: 'video_16x9', width: 1920, height: 1080, fps: 30 };
    const out = reframeProject(wide, 'video_9x16').project;
    const title = out.tracks[1]?.items[0];
    if (!title || !('element' in title)) throw new Error('fixture');
    const t = title.element.transform;
    expect(t.x).toBeGreaterThanOrEqual(64);
    expect(t.x + t.width).toBeLessThanOrEqual(1080 - 64);
  });

  it('holds scene scope: items outside the scene only move', () => {
    const project = fixtureVideoProject();
    const scope = videoScopeOf(project, { kind: 'scene', sceneId: 'scene_1' });
    expect([...(scope?.ids ?? [])].sort()).toEqual(['cap_1', 'cap_2', 'clip_a', 'ov_title']);
    const result = compileRecut(
      project,
      [{ kind: 'trim_clip', itemId: 'clip_a', durationMs: 3_000 }],
      ctx({ scope: { kind: 'scene', sceneId: 'scene_1' } }),
    );
    const out = replay(project, result);
    const b = out.tracks[0]?.items.find((i) => i.id === 'clip_b');
    expect(b?.startMs).toBe(3_000);
    // The music bed spans both scenes: it is outside the scope, so it keeps its length.
    expect(out.tracks[3]?.items[0]).toEqual(project.tracks[3]?.items[0]);
    expect(result.conflicts.map((c) => c.code)).toContain('out_of_scope_kept');
  });

  it('refuses a scope-wide change from a scene-scoped request as a conflict', () => {
    const result = compileRecut(
      withoutMusic(),
      [{ kind: 'reorder_scenes', order: ['scene_2', 'scene_1'] }],
      ctx({ scope: { kind: 'scene', sceneId: 'scene_1' } }),
    );
    expect(result.operations).toEqual([]);
    expect(result.conflicts[0]?.code).toBe('out_of_scope');
  });
});
