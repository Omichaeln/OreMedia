import type { AssetKind } from '@oremedia/contracts/assets';
import type { Element } from '@oremedia/contracts/creative';
import {
  VIDEO_PROJECT_MAX_DURATION_MS,
  type AudioItem,
  type OverlayItem,
  type TrackItem,
  type VideoClipItem,
  type VideoOperation,
  type VideoProjectV1,
} from '@oremedia/contracts/video';
import {
  Storyboard as StoryboardSchema,
  type GapAlternative,
  type GapKind,
  type ModelStoryboardOutput,
  type RefusedItem,
  type Storyboard,
  type StoryboardGap,
  type StoryboardScene,
  type VideoBrief,
  type VideoConflict,
  type VideoPacing,
  type VideoProposalGroup,
} from '@oremedia/contracts/video-ai';
import {
  WorkingProject,
  brandCaptionTrack,
  idMinter,
  textOverlay,
  timedCaptions,
  trackOfKind,
  type VideoCompileContext,
} from './compile-support';
import { videoTimelineDiff } from './diff';
import { videoFormatOf } from './overlays';
import { contentEndMs, lengthOf, sortByStart } from './time';

/**
 * STU-3 storyboards: the server's check of the model's storyboard (asset versions from the eligible set only, claims
 * only with effective facts, gaps made explicit with the alternatives this brand has), the same check of a person's
 * edited storyboard before assembly, and the assembly itself: a deterministic compile of the storyboard into
 * timeline operations (clips back to back per scene with pacing transitions, scenes, titles and the logo per the
 * brand's rules, captions timed from the script, the music bed), grouped so a proposal can be accepted in part.
 */

/** An asset the storyboard may use: eligible for creative use now, with what is known about it. */
export interface StoryboardAsset {
  assetVersionId: string;
  kind: AssetKind;
  name: string | null;
  altText: string | null;
  semanticRole: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  /** Derivatives available (poster, strip, waveform...). */
  derivatives: readonly string[];
}

/** Kinds a shot may show: footage or a still (logos go in the logo overlay, never as a shot). */
export const SHOT_KINDS: readonly AssetKind[] = ['video', 'photo', 'illustration', 'icon'];

export interface StoryboardCheckContext {
  brief: VideoBrief;
  eligible: ReadonlyMap<string, StoryboardAsset>;
  effectiveFactIds: ReadonlySet<string>;
  /** The supported ways to close a gap of this kind, with availability (feature, provider, budget). */
  alternatives: (kind: GapKind) => GapAlternative[];
  /** Mints scene, shot and gap ids. */
  mint: () => string;
}

export const storyboardDurationMs = (s: Pick<Storyboard, 'scenes'>): number =>
  s.scenes.reduce((sum, sc) => sum + sc.shots.reduce((t, sh) => t + sh.durationMs, 0), 0);

const shotProblem = (
  assetVersionId: string,
  ctx: Pick<StoryboardCheckContext, 'eligible' | 'brief'>,
): string | null => {
  const a = ctx.eligible.get(assetVersionId);
  if (!a || ctx.brief.assets.exclude.includes(assetVersionId)) return 'asset_not_eligible';
  if (!SHOT_KINDS.includes(a.kind)) return 'asset_kind_not_a_shot';
  return null;
};

/**
 * The model's storyboard as the server accepts it. Asset versions outside the eligible set (or excluded, or of a
 * kind a shot cannot show) are refused and the shot becomes a listed gap; claims citing no effective fact are
 * refused and their text removed from the scene; source ranges are fitted to the source. Every refusal is listed.
 */
export function checkModelStoryboard(
  output: ModelStoryboardOutput,
  ctx: StoryboardCheckContext,
): { storyboard: Storyboard; refused: RefusedItem[] } {
  const refused: RefusedItem[] = [];
  const gaps: StoryboardGap[] = [];
  const gap = (kind: GapKind, sceneId: string | null, description: string) =>
    gaps.push({
      id: ctx.mint(),
      kind,
      sceneId,
      description: description.slice(0, 300),
      alternatives: ctx.alternatives(kind),
    });
  const scenes: StoryboardScene[] = output.scenes.map((ms, si) => {
    const sceneId = ctx.mint();
    let narration = (ms.narration ?? '').trim();
    let onScreenText = (ms.onScreenText ?? '').trim();
    const claims: StoryboardScene['claims'] = [];
    for (const [ci, c] of (ms.claims ?? []).entries()) {
      const effective = c.factIds.filter((id) => ctx.effectiveFactIds.has(id));
      if (!c.factIds.length || effective.length !== c.factIds.length) {
        refused.push({
          path: `scenes.${si}.claims.${ci}`,
          reason: 'claim_without_effective_fact',
          detail: c.text.slice(0, 200),
        });
        const strip = (t: string) =>
          t
            .split(c.text)
            .join('')
            .replace(/\s{2,}/g, ' ')
            .trim();
        narration = strip(narration);
        onScreenText = strip(onScreenText);
        continue;
      }
      claims.push({ text: c.text.trim(), factIds: effective });
    }
    let missing = false;
    const shots = ms.shots.map((sh, k) => {
      let assetVersionId = sh.assetVersionId;
      if (assetVersionId) {
        const problem = shotProblem(assetVersionId, ctx);
        if (problem) {
          refused.push({
            path: `scenes.${si}.shots.${k}.assetVersionId`,
            reason: problem,
            detail: assetVersionId,
          });
          assetVersionId = null;
        }
      }
      let sourceInMs = sh.sourceInMs ?? 0;
      let durationMs = sh.durationMs;
      const a = assetVersionId ? ctx.eligible.get(assetVersionId) : undefined;
      if (a?.kind === 'video' && a.durationMs !== null) {
        if (durationMs > a.durationMs) {
          refused.push({
            path: `scenes.${si}.shots.${k}.durationMs`,
            reason: 'shot_longer_than_source',
            detail: `${durationMs} ms of a ${a.durationMs} ms source`,
          });
          durationMs = Math.max(500, a.durationMs);
        }
        if (sourceInMs + durationMs > a.durationMs) sourceInMs = Math.max(0, a.durationMs - durationMs);
      } else sourceInMs = 0;
      if (!assetVersionId) missing = true;
      return {
        id: ctx.mint(),
        description: sh.description.trim().slice(0, 300) || 'Shot',
        assetVersionId,
        sourceInMs,
        durationMs,
        framing: 'fill' as const,
      };
    });
    if (missing)
      gap(
        'footage',
        sceneId,
        `Footage for “${ms.title}”: ${shots
          .filter((s) => !s.assetVersionId)
          .map((s) => s.description)
          .join('; ')}`,
      );
    return {
      id: sceneId,
      title: ms.title.trim().slice(0, 80) || `Scene ${si + 1}`,
      purpose: (ms.purpose ?? '').trim().slice(0, 200),
      narration: narration.slice(0, 600),
      onScreenText: onScreenText.slice(0, 120),
      claims,
      shots,
      ...(ms.templateSceneId ? { templateSceneId: ms.templateSceneId } : {}),
    };
  });
  for (const g of output.gaps) {
    const sceneId = g.sceneIndex === undefined ? null : (scenes[g.sceneIndex]?.id ?? null);
    if (g.kind === 'footage' && sceneId && gaps.some((x) => x.sceneId === sceneId)) continue;
    gap(g.kind, sceneId, g.description);
  }
  let music = output.musicAssetVersionId;
  if (music) {
    const a = ctx.eligible.get(music);
    if (!a || a.kind !== 'audio' || ctx.brief.assets.exclude.includes(music)) {
      refused.push({ path: 'musicAssetVersionId', reason: 'asset_not_eligible', detail: music });
      music = null;
    }
  }
  if (ctx.brief.audio !== 'music') music = null;
  if (ctx.brief.audio === 'music' && !music && !gaps.some((g) => g.kind === 'music'))
    gap('music', null, 'No eligible music in the library for the soundtrack');
  if (ctx.brief.audio === 'voiceover' && !gaps.some((g) => g.kind === 'voiceover'))
    gap('voiceover', null, 'A recorded voice-over of the script');
  const storyboard = StoryboardSchema.parse({
    title: output.title.trim().slice(0, 120) || 'Storyboard',
    scenes,
    gaps,
    musicAssetVersionId: music,
    pacing: ctx.brief.pacing,
    captions: ctx.brief.captions,
    audio: ctx.brief.audio,
    logo: ctx.brief.logo,
  });
  return { storyboard, refused };
}

/**
 * A person's edited storyboard checked before assembly: the same eligibility and fact rules as the model's (nobody
 * assembles an ineligible asset or an unsupported claim) and the project's length limit.
 */
export function storyboardProblems(
  storyboard: Storyboard,
  ctx: Pick<StoryboardCheckContext, 'eligible' | 'effectiveFactIds' | 'brief'>,
): RefusedItem[] {
  const out: RefusedItem[] = [];
  storyboard.scenes.forEach((scene, si) => {
    scene.claims.forEach((c, ci) => {
      const bad = c.factIds.filter((id) => !ctx.effectiveFactIds.has(id));
      if (bad.length)
        out.push({
          path: `scenes.${si}.claims.${ci}`,
          reason: 'claim_without_effective_fact',
          detail: bad.join(', '),
        });
    });
    scene.shots.forEach((sh, k) => {
      if (!sh.assetVersionId) return;
      const problem = shotProblem(sh.assetVersionId, ctx);
      if (problem)
        out.push({
          path: `scenes.${si}.shots.${k}.assetVersionId`,
          reason: problem,
          detail: sh.assetVersionId,
        });
      const a = ctx.eligible.get(sh.assetVersionId);
      if (a?.kind === 'video' && a.durationMs !== null && sh.sourceInMs + sh.durationMs > a.durationMs)
        out.push({
          path: `scenes.${si}.shots.${k}.durationMs`,
          reason: 'shot_longer_than_source',
          detail: `${sh.sourceInMs + sh.durationMs} ms of a ${a.durationMs} ms source`,
        });
    });
  });
  if (storyboard.musicAssetVersionId) {
    const a = ctx.eligible.get(storyboard.musicAssetVersionId);
    if (!a || a.kind !== 'audio')
      out.push({
        path: 'musicAssetVersionId',
        reason: 'asset_not_eligible',
        detail: storyboard.musicAssetVersionId,
      });
  }
  const total = storyboardDurationMs(storyboard);
  if (total > VIDEO_PROJECT_MAX_DURATION_MS)
    out.push({
      path: 'scenes',
      reason: 'too_long',
      detail: `${total} ms; a video lasts at most ${VIDEO_PROJECT_MAX_DURATION_MS} ms`,
    });
  return out;
}

// ---- assembly ---------------------------------------------------------------------------------------------------

/** Proposal groups of an assembly (a partial accept recompiles the chosen ones). */
export const ASSEMBLY_GROUPS = ['titles', 'captions', 'music', 'clips'] as const;
export type AssemblyGroupId = (typeof ASSEMBLY_GROUPS)[number];
const GROUP_LABELS: Record<AssemblyGroupId, string> = {
  clips: 'Scenes, clips and transitions',
  titles: 'Titles and logo',
  captions: 'Captions from the script',
  music: 'Soundtrack',
};

/** The transition between scenes per pacing (within a scene, shots cut). */
export const PACING_TRANSITIONS: Record<VideoPacing, { kind: 'crossfade' | 'cut'; durationMs: number }> = {
  calm: { kind: 'crossfade', durationMs: 600 },
  balanced: { kind: 'crossfade', durationMs: 300 },
  fast: { kind: 'cut', durationMs: 0 },
};

export interface AssemblyCompile {
  groups: Array<VideoProposalGroup & { operations: VideoOperation[] }>;
  operations: VideoOperation[];
  project: VideoProjectV1;
  conflicts: VideoConflict[];
  assetVersionIds: string[];
  factIds: string[];
}

/** A project with nothing on its picture and sound tracks: the first assembly applies directly. */
export const isEmptyProject = (p: VideoProjectV1): boolean =>
  p.tracks.every((t) => (t.kind !== 'video' && t.kind !== 'audio') || t.items.length === 0);

/**
 * Compiles a storyboard into the project. Unlocked clips, sound, captions, scenes and titles the storyboard replaces
 * are removed first (locked ones stay, and a locked clip on the picture track stops the clips group with a conflict);
 * titles reuse the template's title overlay of the scene they fill; the logo is the brand's primary logo, at least
 * its minimum width, over the last scene; captions are timed from each scene's narration.
 */
export function compileAssembly(
  project: VideoProjectV1,
  storyboard: Storyboard,
  ctx: VideoCompileContext & { logoMinWidthPx?: number },
  only?: ReadonlySet<string>,
): AssemblyCompile {
  const work = new WorkingProject(project, { media: ctx.media as never, strictMedia: false });
  const mint = idMinter(project, ctx.idPrefix);
  const groups: AssemblyCompile['groups'] = [];
  const assetVersionIds = new Set<string>();
  const factIds = new Set(storyboard.scenes.flatMap((s) => s.claims.flatMap((c) => c.factIds)));
  // Scene times as assembled (whether or not the clips group is kept, titles and captions follow the storyboard).
  let at = 0;
  const sceneSpans = storyboard.scenes.map((s) => {
    const startMs = at;
    at += s.shots.reduce((t, sh) => t + sh.durationMs, 0);
    return { scene: s, startMs, endMs: at };
  });
  const total = at;
  const run = (id: AssemblyGroupId, fn: (groupId: string) => void) => {
    if (only && !only.has(id)) return;
    const before = work.project;
    const count = work.operations.length;
    fn(id);
    const operations = work.operations.slice(count);
    if (operations.length)
      groups.push({
        id,
        label: GROUP_LABELS[id],
        operationCount: operations.length,
        operations,
        changes: videoTimelineDiff(before, work.project),
      });
  };

  /** The project is made long enough for the storyboard before anything is placed in it. */
  const grow = (groupId: string) => {
    if (total > work.project.durationMs) work.apply({ op: 'setDuration', durationMs: total }, groupId);
  };

  // Titles, captions and sound first: the clips group (scenes, clips, length) runs last and shortens the project.
  run('titles', (groupId) => {
    grow(groupId);
    let track = trackOfKind(work.project, 'overlay');
    if (!track) {
      if (
        !work.apply(
          {
            op: 'addTrack',
            track: { id: mint(), kind: 'overlay', name: 'Titles', locked: false, items: [] },
          },
          groupId,
        )
      )
        return;
      track = trackOfKind(work.project, 'overlay');
    }
    if (!track) return;
    if (track.locked) {
      work.conflict({
        code: 'track_locked',
        message: `${track.name} is locked; titles were not added`,
        groupId,
        itemIds: [],
      });
      return;
    }
    const templateTitles = new Map<string, OverlayItem>();
    const original = trackOfKind(project, 'overlay');
    for (const o of original?.items ?? []) {
      if (o.element.type !== 'text' || o.locked) continue;
      const scene = project.scenes.find((s) => o.startMs >= s.startMs && o.endMs <= s.endMs);
      if (scene && !templateTitles.has(scene.id)) templateTitles.set(scene.id, o);
    }
    const reused = new Set<string>();
    for (const { scene, startMs, endMs } of sceneSpans) {
      if (!scene.onScreenText) continue;
      const reuse = scene.templateSceneId ? templateTitles.get(scene.templateSceneId) : undefined;
      const overlay = textOverlay(work.project, ctx, {
        id: reuse?.id ?? mint(),
        text: scene.onScreenText,
        startMs,
        endMs,
        band: 'upper',
        role: 'headline',
        factRefs: scene.claims.filter((c) => scene.onScreenText.includes(c.text)).flatMap((c) => c.factIds),
        ...(reuse ? { reuse } : {}),
      });
      if (!overlay) {
        work.conflict({
          code: 'no_title_font',
          message: 'The brand system has no heading font for titles',
          groupId,
          itemIds: [],
        });
        break;
      }
      if (reuse) reused.add(reuse.id);
      work.apply({ op: 'setOverlay', trackId: track.id, overlay }, groupId);
    }
    // Template titles the storyboard did not fill would show placeholder text: they go.
    for (const o of original?.items ?? [])
      if (o.element.type === 'text' && !o.locked && !reused.has(o.id))
        work.apply({ op: 'removeOverlay', trackId: track.id, itemId: o.id }, groupId);
    if (!storyboard.logo) return;
    const last = sceneSpans[sceneSpans.length - 1];
    if (!last) return;
    const existing = (trackOfKind(work.project, 'overlay')?.items ?? []).find(
      (o) => o.element.type === 'logo',
    );
    const logoStart = Math.max(last.startMs, total - 2_500);
    if (existing) {
      if (!existing.locked)
        work.apply(
          { op: 'setOverlay', trackId: track.id, overlay: { ...existing, startMs: logoStart, endMs: total } },
          groupId,
        );
      return;
    }
    if (!ctx.bindings.logoAssetVersionId) {
      work.conflict({
        code: 'no_logo',
        message: 'The brand system names no primary logo, so no logo was placed',
        groupId,
        itemIds: [],
      });
      return;
    }
    const f = videoFormatOf(work.project);
    const width = Math.max(ctx.logoMinWidthPx ?? 0, Math.round(Math.min(f.width, f.height) * 0.3));
    const height = Math.round(width / 2);
    const element: Element = {
      id: ctx.bindings.newElementId(),
      name: 'Logo',
      type: 'logo',
      locked: false,
      visible: true,
      opacity: 1,
      protected: true,
      semanticRole: 'logo',
      transform: {
        x: Math.round((f.width - width) / 2),
        y: Math.round(f.height - f.safeArea.bottom - height - Math.round(f.height * 0.05)),
        width,
        height,
        rotation: 0,
      },
      assetVersionId: ctx.bindings.logoAssetVersionId,
      variant: 'primary',
    };
    const length = total - logoStart;
    work.apply(
      {
        op: 'setOverlay',
        trackId: track.id,
        overlay: {
          id: mint(),
          startMs: logoStart,
          endMs: total,
          element,
          ...(length >= 600 ? { enter: { kind: 'fade' as const, durationMs: 300 } } : {}),
          locked: false,
        },
      },
      groupId,
    );
  });

  run('captions', (groupId) => {
    if (!storyboard.captions) return;
    grow(groupId);
    let track = trackOfKind(work.project, 'caption');
    if (!track) {
      const made = brandCaptionTrack(mint(), ctx.bindings);
      if (!made) {
        work.conflict({
          code: 'no_caption_font',
          message: 'The brand system has no caption or body font',
          groupId,
          itemIds: [],
        });
        return;
      }
      if (!work.apply({ op: 'addTrack', track: made }, groupId)) return;
      track = trackOfKind(work.project, 'caption');
    }
    if (!track) return;
    if (track.locked || track.items.some((c) => c.locked)) {
      work.conflict({
        code: 'locked_item_kept',
        message: 'Locked captions are on the timeline; unlock them to replace the captions with the script',
        groupId,
        itemIds: track.items.filter((c) => c.locked).map((c) => c.id),
      });
      return;
    }
    for (const c of track.items)
      work.apply({ op: 'removeCaption', trackId: track.id, itemId: c.id }, groupId);
    for (const { scene, startMs, endMs } of sceneSpans)
      for (const caption of timedCaptions(scene.narration, startMs, endMs, mint))
        work.apply({ op: 'upsertCaption', trackId: track.id, caption }, groupId);
  });

  run('music', (groupId) => {
    grow(groupId);
    let track = trackOfKind(work.project, 'audio');
    const old = (track?.items ?? []) as TrackItem[];
    if (track && (track.locked || old.some((a) => a.locked))) {
      work.conflict({
        code: 'locked_item_kept',
        message: 'The soundtrack is locked; it was kept as it is',
        groupId,
        itemIds: [],
      });
      return;
    }
    if (track)
      for (const a of old) work.apply({ op: 'removeClip', trackId: track.id, itemId: a.id }, groupId);
    const musicId = storyboard.audio === 'music' ? storyboard.musicAssetVersionId : null;
    if (!musicId) return;
    const m = ctx.media[musicId];
    if (!m) {
      work.conflict({
        code: 'media_unknown',
        message: `The music ${musicId} is not described`,
        groupId,
        itemIds: [],
      });
      return;
    }
    if (!track) {
      if (
        !work.apply(
          {
            op: 'addTrack',
            track: { id: mint(), kind: 'audio', name: 'Music', locked: false, muted: false, items: [] },
          },
          groupId,
        )
      )
        return;
      track = trackOfKind(work.project, 'audio');
    }
    if (!track) return;
    const length = Math.min(total, m.durationMs ?? total);
    const item: AudioItem = {
      id: mint(),
      name: 'Music',
      assetVersionId: musicId,
      sourceInMs: 0,
      sourceOutMs: length,
      startMs: 0,
      gainDb: 0,
      fadeInMs: Math.min(500, Math.floor(length / 4)),
      fadeOutMs: Math.min(1_000, Math.floor(length / 4)),
      muted: false,
      locked: false,
    };
    if (work.apply({ op: 'insertClip', trackId: track.id, item }, groupId)) assetVersionIds.add(musicId);
  });

  run('clips', (groupId) => {
    const v = trackOfKind(work.project, 'video');
    if (!v) return;
    if (v.locked || v.items.some((c) => c.locked)) {
      work.conflict({
        code: 'locked_item_kept',
        message: 'The picture track holds locked clips; unlock them to assemble the storyboard over them',
        groupId,
        itemIds: v.items.filter((c) => c.locked).map((c) => c.id),
      });
      return;
    }
    grow(groupId);
    for (const c of sortByStart(v.items).reverse())
      work.apply({ op: 'removeClip', trackId: v.id, itemId: c.id }, groupId);
    for (const s of work.project.scenes) work.apply({ op: 'removeScene', sceneId: s.id }, groupId);
    const muted = storyboard.audio !== 'clip_sound';
    const transition = PACING_TRANSITIONS[storyboard.pacing];
    for (const { scene, startMs, endMs } of sceneSpans) {
      let t = startMs;
      scene.shots.forEach((shot, k) => {
        const start = t;
        t += shot.durationMs;
        if (!shot.assetVersionId) return;
        const item: VideoClipItem = {
          id: mint(),
          name: shot.description.slice(0, 80),
          assetVersionId: shot.assetVersionId,
          sourceInMs: shot.sourceInMs,
          sourceOutMs: shot.sourceInMs + shot.durationMs,
          startMs: start,
          frame: { fit: shot.framing, focalX: 0.5, focalY: 0.5, zoom: 1 },
          gainDb: 0,
          muted,
          locked: false,
        };
        if (work.apply({ op: 'insertClip', trackId: v.id, item }, groupId))
          assetVersionIds.add(shot.assetVersionId);
        if (k === 0 && start > 0 && transition.kind !== 'cut') {
          const track = trackOfKind(work.project, 'video');
          const prev = track?.items.find((o) => o.startMs + lengthOf(o) === start);
          if (prev) {
            const durationMs = Math.min(
              transition.durationMs,
              Math.floor(Math.min(lengthOf(prev), shot.durationMs) / 2),
            );
            if (durationMs >= 50)
              work.apply(
                {
                  op: 'setTransition',
                  trackId: v.id,
                  itemId: item.id,
                  transition: { kind: transition.kind, durationMs },
                },
                groupId,
              );
          }
        }
      });
      work.apply({ op: 'setScene', scene: { id: mint(), title: scene.title, startMs, endMs } }, groupId);
    }
    const floor = Math.max(1_000, total, contentEndMs(work.project));
    if (floor < work.project.durationMs) work.apply({ op: 'setDuration', durationMs: floor }, groupId);
  });

  return {
    groups,
    operations: [...work.operations],
    project: work.project,
    conflicts: work.conflicts,
    assetVersionIds: [...assetVersionIds],
    factIds: [...factIds],
  };
}
