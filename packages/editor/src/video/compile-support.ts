import type { TextElement } from '@oremedia/contracts/creative';
import {
  VIDEO_MIN_ITEM_MS,
  type CaptionItem,
  type CaptionTrack,
  type OverlayItem,
  type Track,
  type VideoMediaInfo,
  type VideoOperation,
  type VideoProjectV1,
} from '@oremedia/contracts/video';
import type { VideoConflict } from '@oremedia/contracts/video-ai';
import { videoFormatOf } from './overlays';
import { VideoOperationError, reduceVideo, type VideoReduceContext } from './reduce';
import type { VideoBrandBindings } from './templates';
import { allItemIds } from './time';

/**
 * Shared pieces of the STU-3 compilers (storyboard assembly and recut planning): deterministic item ids, captions
 * timed from script text, brand-bound text overlays, and a working project that applies each operation through the
 * pure reducer as it is planned, so a plan never contains an operation the reducer would refuse (a refusal becomes a
 * reported conflict instead).
 */

/** What the compilers know about sources and the brand. */
export interface VideoCompileContext {
  media: Readonly<Record<string, VideoMediaInfo | undefined>>;
  bindings: Pick<VideoBrandBindings, 'fonts' | 'colours' | 'logoAssetVersionId' | 'newElementId'>;
  /** Item ids are minted from this prefix (deterministic per job, so a recompile yields the same ids). */
  idPrefix: string;
}

/** Mints item ids `<prefix><n>` that the project does not use yet (ids match VideoId). */
export function idMinter(project: VideoProjectV1, prefix: string): () => string {
  const used = new Set(allItemIds(project));
  const safe = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30) || 'ai';
  let n = 0;
  return () => {
    let id: string;
    do id = `${safe}${++n}`;
    while (used.has(id));
    used.add(id);
    return id;
  };
}

/**
 * The project as operations are planned: each is reduced at once; a refused one is not kept and is returned as a
 * conflict with the reducer's own sentence.
 */
export class WorkingProject {
  project: VideoProjectV1;
  readonly operations: VideoOperation[] = [];
  readonly conflicts: VideoConflict[] = [];
  /** Operation counts after which the plan may be committed in parts (whole groups, or whole scenes of one). */
  readonly cutPoints: number[] = [];
  constructor(
    project: VideoProjectV1,
    private readonly ctx: VideoReduceContext,
    private readonly check?: (before: VideoProjectV1, op: VideoOperation, after: VideoProjectV1) => void,
  ) {
    this.project = project;
  }
  /** Applies `op`; false (and a conflict) when the reducer or the check refuses it. */
  apply(op: VideoOperation, groupId?: string): boolean {
    try {
      const next = reduceVideo(this.project, op, this.ctx);
      this.check?.(this.project, op, next);
      this.project = next;
      this.operations.push(op);
      return true;
    } catch (err) {
      const code =
        err instanceof VideoOperationError
          ? err.code
          : ((err as { reason?: string }).reason ?? 'not_possible');
      this.conflicts.push({
        code,
        message: err instanceof Error ? err.message : String(err),
        ...(groupId ? { groupId } : {}),
        itemIds: 'itemId' in op ? [op.itemId] : [],
      });
      return false;
    }
  }
  conflict(c: VideoConflict): void {
    this.conflicts.push(c);
  }
  /** Marks the plan so far as a state a part may end on. */
  mark(): void {
    const n = this.operations.length;
    if (n && this.cutPoints[this.cutPoints.length - 1] !== n) this.cutPoints.push(n);
  }
}

/** Longest caption (two lines of about 42 characters, broadcast practice). */
export const CAPTION_CHUNK_CHARS = 84;

/** Splits script text into caption-sized chunks at sentence and word boundaries. */
export function captionChunks(text: string, maxChars = CAPTION_CHUNK_CHARS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) ?? [clean];
  const out: string[] = [];
  for (const raw of sentences) {
    let current = '';
    for (const word of raw.trim().split(' ')) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxChars && current) {
        out.push(current);
        current = word.slice(0, maxChars);
      } else current = next.slice(0, Math.max(maxChars, word.length)).slice(0, 300);
    }
    if (current) out.push(current);
  }
  return out;
}

/**
 * Captions for script text across [startMs, endMs): one per chunk, back to back, each lasting in proportion to its
 * length (at least VIDEO_MIN_ITEM_MS). Chunks that do not fit are merged into the last caption.
 */
export function timedCaptions(
  text: string,
  startMs: number,
  endMs: number,
  mint: () => string,
): CaptionItem[] {
  let chunks = captionChunks(text);
  const span = endMs - startMs;
  if (!chunks.length || span < VIDEO_MIN_ITEM_MS) return [];
  const maxCount = Math.max(1, Math.floor(span / 700));
  if (chunks.length > maxCount) {
    const head = chunks.slice(0, maxCount - 1);
    const tail = chunks.slice(maxCount - 1).join(' ');
    chunks = [...head, tail.slice(0, 300)];
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out: CaptionItem[] = [];
  let at = startMs;
  chunks.forEach((c, k) => {
    const end =
      k === chunks.length - 1
        ? endMs
        : at + Math.max(VIDEO_MIN_ITEM_MS, Math.round((span * c.length) / total));
    const capped = Math.min(endMs, end);
    if (capped - at >= VIDEO_MIN_ITEM_MS)
      out.push({ id: mint(), startMs: at, endMs: capped, text: c, locked: false });
    at = capped;
  });
  return out;
}

/** A caption track bound to the brand's caption font, or null when the brand has no font for captions. */
export function brandCaptionTrack(
  id: string,
  bindings: VideoCompileContext['bindings'],
): CaptionTrack | null {
  const font = bindings.fonts.caption ?? bindings.fonts.body ?? bindings.fonts.heading;
  if (!font) return null;
  return {
    id,
    kind: 'caption',
    name: 'Captions',
    locked: false,
    style: {
      fontAssetVersionId: font,
      sizePx: 48,
      weight: 600,
      ...(bindings.colours.text ? { colourToken: bindings.colours.text } : { colourValue: '#ffffff' }),
      ...(bindings.colours.box ? { boxToken: bindings.colours.box } : {}),
      boxOpacity: 0.6,
      position: 'bottom',
    },
    items: [],
  };
}

/** Where a title sits: the upper or lower band of the safe area, full safe width (scaled to the frame). */
export function titleBox(
  project: VideoProjectV1,
  band: 'upper' | 'lower',
): { x: number; y: number; width: number; height: number } {
  const f = videoFormatOf(project);
  const scale = Math.min(f.width, f.height) / 1080;
  const height = Math.round(220 * scale);
  const width = f.width - f.safeArea.left - f.safeArea.right;
  const y =
    band === 'upper' ? f.safeArea.top + Math.round(40 * scale) : f.height - f.safeArea.bottom - height;
  return { x: f.safeArea.left, y, width, height };
}

/** A brand-bound text overlay (heading font and the text colour token); null without a brand font. */
export function textOverlay(
  project: VideoProjectV1,
  ctx: Pick<VideoCompileContext, 'bindings'>,
  spec: {
    id: string;
    text: string;
    startMs: number;
    endMs: number;
    band: 'upper' | 'lower';
    role: 'headline' | 'cta';
    factRefs?: string[];
    reuse?: OverlayItem;
  },
): OverlayItem | null {
  const reused = spec.reuse?.element.type === 'text' ? spec.reuse.element : null;
  const font = reused?.style.fontAssetVersionId ?? ctx.bindings.fonts.heading ?? ctx.bindings.fonts.display;
  if (!font) return null;
  const scale = Math.min(project.format.width, project.format.height) / 1080;
  const element: TextElement = reused
    ? { ...reused, text: spec.text, factRefs: spec.factRefs ?? [] }
    : {
        id: ctx.bindings.newElementId(),
        name: spec.role === 'cta' ? 'Call to action' : 'Title',
        type: 'text',
        locked: false,
        visible: true,
        opacity: 1,
        protected: false,
        semanticRole: spec.role,
        transform: { ...titleBox(project, spec.band), rotation: 0 },
        text: spec.text,
        factRefs: spec.factRefs ?? [],
        style: {
          typeRole: 'heading',
          fontAssetVersionId: font,
          weight: 700,
          sizePx: Math.round(72 * scale),
          lineHeight: 1.1,
          tracking: 0,
          ...(ctx.bindings.colours.text
            ? { colourToken: ctx.bindings.colours.text }
            : { colourValue: '#ffffff' }),
          align: 'center',
          overflow: 'shrink_to_fit',
        },
      };
  const length = spec.endMs - spec.startMs;
  const anim = Math.min(300, Math.floor(length / 4));
  return {
    id: spec.id,
    startMs: spec.startMs,
    endMs: spec.endMs,
    element,
    ...(anim >= 50 ? { enter: { kind: 'fade' as const, durationMs: anim } } : {}),
    ...(anim >= 50 ? { exit: { kind: 'fade' as const, durationMs: anim } } : {}),
    locked: false,
  };
}

/** The first track of a kind, if any. */
export function trackOfKind<K extends Track['kind']>(
  project: VideoProjectV1,
  kind: K,
): Extract<Track, { kind: K }> | undefined {
  return project.tracks.find((t): t is Extract<Track, { kind: K }> => t.kind === kind);
}
