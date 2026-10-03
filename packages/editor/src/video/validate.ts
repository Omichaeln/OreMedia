import type { BrandSnapshot } from '@oremedia/contracts/brand';
import type { Finding } from '@oremedia/contracts/creative';
import type { VideoMediaInfo, VideoProjectV1 } from '@oremedia/contracts/video';
import { prohibitedPhrasesIn, validateAgainstBrand } from '../validate';
import { overlayPage } from './overlays';
import { lengthOf, previousAdjacent, sortByStart } from './time';

/** Reading speed above which a caption is flagged (characters per second; subtitle guidance is 15-20). */
export const CAPTION_MAX_CHARS_PER_SECOND = 20;
/** A run of black between clips at least this long is reported. */
const GAP_REPORT_MS = 100;

export interface VideoValidationContext {
  /** What is known about each referenced source; a missing entry is a missing asset. */
  media: Readonly<Record<string, VideoMediaInfo | undefined>>;
  /** Brand checks for overlays and captions (tokens, logo rules, contrast, facts, prohibited phrases). */
  snapshot?: BrandSnapshot;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/**
 * Deterministic findings for a video project (spec 11.4 applied to timelines): missing or unusable sources, clips
 * beyond their source, transitions with nothing to join, overlapping or too-fast captions, black gaps, and every
 * overlay checked by the graphic brand validation (text overflow, tokens, logo rules, safe area of the output
 * preset). `elementId` names the timeline item a finding is about.
 */
export function validateVideoProject(project: VideoProjectV1, ctx: VideoValidationContext): Finding[] {
  const findings: Finding[] = [];
  const at = (itemId: string) => ({ pageId: 'timeline', elementId: itemId });
  const prohibited = ctx.snapshot?.document.voice.prohibitedPhrases ?? [];

  for (const track of project.tracks) {
    if (track.kind === 'video' || track.kind === 'audio') {
      for (const item of track.items) {
        const media = ctx.media[item.assetVersionId];
        const label = item.name ?? (track.kind === 'video' ? 'A clip' : 'An audio item');
        if (!media) {
          findings.push({
            code: 'missing_asset',
            severity: 'blocking',
            message: `${label} uses a source that is missing or no longer usable; replace it`,
            ...at(item.id),
          });
          continue;
        }
        if (media.kind !== 'image' && media.durationMs !== null && item.sourceOutMs > media.durationMs)
          findings.push({
            code: 'clip_beyond_source',
            severity: 'blocking',
            message: `${label} ends at ${seconds(item.sourceOutMs)} of a ${seconds(media.durationMs)} source; trim it`,
            ...at(item.id),
          });
      }
    }
    if (track.kind === 'video') {
      if (!track.items.length)
        findings.push({
          code: 'no_clips',
          severity: 'blocking',
          message: 'Add at least one clip or image to the video track before rendering',
          pageId: 'timeline',
        });
      let cursor = 0;
      for (const clip of sortByStart(track.items)) {
        if (clip.startMs - cursor >= GAP_REPORT_MS)
          findings.push({
            code: 'black_gap',
            severity: 'warning',
            message: `${seconds(clip.startMs - cursor)} of black before ${clip.name ?? 'a clip'} at ${seconds(cursor)}`,
            ...at(clip.id),
          });
        cursor = clip.startMs + lengthOf(clip);
        const t = clip.transitionIn;
        if (t && t.kind !== 'cut' && t.durationMs > 0 && !previousAdjacent(track.items, clip))
          findings.push({
            code: 'unsupported_transition',
            severity: 'warning',
            message: `The ${t.kind.replace('_', ' ')} into ${clip.name ?? 'this clip'} has no clip right before it and renders as a cut`,
            ...at(clip.id),
          });
      }
      if (track.items.length && project.durationMs - cursor >= GAP_REPORT_MS)
        findings.push({
          code: 'black_gap',
          severity: 'warning',
          message: `The last ${seconds(project.durationMs - cursor)} are black; add a clip or shorten the video`,
          pageId: 'timeline',
        });
    }
    if (track.kind === 'caption') {
      const sorted = sortByStart(track.items);
      sorted.forEach((c, k) => {
        const prev = sorted[k - 1];
        if (prev && prev.endMs > c.startMs)
          findings.push({
            code: 'caption_overlap',
            severity: 'warning',
            message: `Caption "${c.text.slice(0, 40)}" starts before the previous one ends`,
            ...at(c.id),
          });
        const cps = [...c.text].length / Math.max(0.1, (c.endMs - c.startMs) / 1000);
        if (cps > CAPTION_MAX_CHARS_PER_SECOND)
          findings.push({
            code: 'caption_too_fast',
            severity: 'warning',
            message: `Caption "${c.text.slice(0, 40)}" needs ${Math.round(cps)} characters per second; give it more time`,
            ...at(c.id),
          });
        for (const p of prohibitedPhrasesIn(c.text, prohibited))
          findings.push({
            code: 'prohibited_phrase',
            severity: 'blocking',
            message: `Prohibited phrase "${p}"`,
            ...at(c.id),
          });
      });
    }
    if (track.kind === 'overlay' && ctx.snapshot)
      for (const overlay of track.items) {
        const page = overlayPage(project, overlay);
        const doc = {
          schemaVersion: 1 as const,
          brandVersionId: project.brandVersionId,
          pages: [page],
          variants: [],
        };
        for (const f of validateAgainstBrand(doc, ctx.snapshot))
          findings.push({ ...f, pageId: 'timeline', elementId: overlay.id });
      }
  }
  return findings;
}
