import { describe, expect, it } from 'vitest';
import type { WaveformV1 } from '@oremedia/contracts/media';
import { VideoProjectV1, type VideoProjectV1 as Project } from '@oremedia/contracts/video';
import type { RecutAction } from '@oremedia/contracts/video-ai';
import { VIDEO_FIXTURE_MEDIA, fixtureVideoProject } from './fixtures';
import { videoScopeOf } from './guard';
import { applyVideoBatch } from './reduce';
import {
  compileRecut,
  mergeCuts,
  planDurationFit,
  planSilenceTrim,
  reframeProject,
  timeMapper,
  type RecutContext,
} from './recut';
import { contentEndMs, lengthOf } from './time';

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
    expect(out.tracks[0]?.items[0]?.assetVersionId).toBe('av_still');
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
      {
        kind: 'add_captions',
        lines: [{ sceneId: 'scene_2', text: 'It folds flat. It fits any bag you carry.' }],
      },
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
    expect(result.groups[0]?.changes.some((c) => c.target === 'format')).toBe(true);
  });

  it('reframes titles into the new safe width', () => {
    const wide = fixtureVideoProject();
    wide.format = { key: 'video_16x9', width: 1920, height: 1080, fps: 30 };
    const out = reframeProject(wide, 'video_9x16');
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
