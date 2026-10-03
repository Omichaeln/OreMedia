import { z } from 'zod';
import { ElementSchema, VIDEO_EXPORT_MAX_DURATION_MS, type Element, type FormatDefinition } from './creative';

/**
 * Studio video v1 (STU-2b): the timeline document a `video` creative document stores in its revisions. Graphic
 * documents keep CreativeDocumentV1; a video revision's snapshot is a VideoProjectV1 and carries `kind: 'video'` so
 * a snapshot read without its document row (review, measurement) is still told apart from a graphic one.
 *
 * Times are integer milliseconds on the timeline; clip sources are trimmed by source in/out milliseconds. Renders
 * snap every boundary to the project's frame grid (frameOf in packages/editor/src/video/time.ts), never drift.
 * The structural invariants (no overlap on video/audio tracks, in < out <= source duration, items inside the
 * project, transitions at most half of each neighbour, locks) are enforced by the pure reducer
 * (packages/editor/src/video/reduce.ts); this schema states shapes and bounds only, so a stored snapshot always reads.
 */

/** Longest project (architecture: video v1). */
export const VIDEO_PROJECT_MAX_DURATION_MS = VIDEO_EXPORT_MAX_DURATION_MS;
/** Longest source a clip may come from (PERSON_MEDIA_LIMITS: 10 minutes). */
export const VIDEO_SOURCE_MAX_MS = 600_000;
/** Shortest item on any track. */
export const VIDEO_MIN_ITEM_MS = 100;
/** Shortest project. */
export const VIDEO_MIN_DURATION_MS = 1_000;
export const VIDEO_MAX_TRACKS = 8;
export const VIDEO_MAX_ITEMS_PER_TRACK = 200;
export const VIDEO_MAX_SCENES = 30;
export const VIDEO_MAX_TRANSITION_MS = 5_000;
export const VIDEO_MAX_FADE_MS = 10_000;
export const VIDEO_MAX_ANIMATION_MS = 3_000;
export const VIDEO_CAPTION_MAX_CHARS = 300;

export const VideoFps = z.union([z.literal(24), z.literal(25), z.literal(30)]);
export type VideoFps = z.infer<typeof VideoFps>;

/** Output presets (architecture: max 1920 on the long edge). Safe areas keep text clear of platform chrome. */
export const VIDEO_FORMAT_KEYS = ['video_9x16', 'video_1x1', 'video_4x5', 'video_16x9'] as const;
export const VideoFormatKey = z.enum(VIDEO_FORMAT_KEYS);
export type VideoFormatKey = z.infer<typeof VideoFormatKey>;

export const VIDEO_FORMATS: Readonly<Record<VideoFormatKey, FormatDefinition>> = {
  video_9x16: {
    key: 'video_9x16',
    label: 'Vertical 9:16',
    width: 1080,
    height: 1920,
    safeArea: { top: 250, right: 64, bottom: 320, left: 64 },
    providerKeys: ['instagram_business', 'facebook_page', 'tiktok', 'x'],
  },
  video_1x1: {
    key: 'video_1x1',
    label: 'Square 1:1',
    width: 1080,
    height: 1080,
    safeArea: { top: 54, right: 54, bottom: 54, left: 54 },
    providerKeys: ['instagram_business', 'facebook_page', 'linkedin_page', 'x'],
  },
  video_4x5: {
    key: 'video_4x5',
    label: 'Portrait 4:5',
    width: 1080,
    height: 1350,
    safeArea: { top: 54, right: 54, bottom: 54, left: 54 },
    providerKeys: ['instagram_business', 'facebook_page', 'linkedin_page'],
  },
  video_16x9: {
    key: 'video_16x9',
    label: 'Landscape 16:9',
    width: 1920,
    height: 1080,
    safeArea: { top: 54, right: 96, bottom: 54, left: 96 },
    providerKeys: ['linkedin_page', 'facebook_page', 'x'],
  },
};

export const videoFormatFor = (key: string): FormatDefinition | undefined =>
  (VIDEO_FORMATS as Record<string, FormatDefinition>)[key];

const Ms = z.number().int().min(0);
/** Track, item and scene ids: stable, URL-safe, chosen by the client (items) or the template (tracks). */
export const VideoId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'id must be 1-40 letters, digits, _ or -');

export const VideoFormat = z.object({
  key: VideoFormatKey,
  width: z.number().int().min(64).max(1920),
  height: z.number().int().min(64).max(1920),
  fps: VideoFps,
});
export type VideoFormat = z.infer<typeof VideoFormat>;

/**
 * How a source fills the frame: `fill` scales to cover and crops around the focal point (zoom > 1 crops further,
 * i.e. reposition and crop within the frame); `fit` scales to fit inside and pads with black.
 */
export const ClipFrame = z.object({
  fit: z.enum(['fill', 'fit']).default('fill'),
  focalX: z.number().min(0).max(1).default(0.5),
  focalY: z.number().min(0).max(1).default(0.5),
  zoom: z.number().min(1).max(4).default(1),
});
export type ClipFrame = z.infer<typeof ClipFrame>;

/**
 * A transition into a clip from the clip that ends where it starts. It is centred on the cut: the first half blends
 * the tail of the previous clip into the second half's head, so no clip moves and the project length is unchanged.
 * The renderer freezes the outgoing clip's last frame and the incoming clip's first frame for the half beyond each
 * cut point (no handles needed). `cut` is no transition.
 */
export const TRANSITION_KINDS = ['cut', 'crossfade', 'fade_black', 'slide'] as const;
export const VideoTransition = z.object({
  kind: z.enum(TRANSITION_KINDS),
  durationMs: Ms.max(VIDEO_MAX_TRANSITION_MS),
});
export type VideoTransition = z.infer<typeof VideoTransition>;

export const VideoClipItem = z.object({
  id: VideoId,
  name: z.string().max(80).optional(),
  /** A video asset version, or an image shown as a still for the clip's length. */
  assetVersionId: z.string().min(1).max(40),
  sourceInMs: Ms.max(VIDEO_SOURCE_MAX_MS),
  sourceOutMs: Ms.max(VIDEO_SOURCE_MAX_MS),
  startMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
  frame: ClipFrame.default({}),
  transitionIn: VideoTransition.optional(),
  /** The clip's own sound. */
  gainDb: z.number().min(-60).max(12).default(0),
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
});
export type VideoClipItem = z.infer<typeof VideoClipItem>;

export const AudioItem = z.object({
  id: VideoId,
  name: z.string().max(80).optional(),
  assetVersionId: z.string().min(1).max(40),
  sourceInMs: Ms.max(VIDEO_SOURCE_MAX_MS),
  sourceOutMs: Ms.max(VIDEO_SOURCE_MAX_MS),
  startMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
  gainDb: z.number().min(-60).max(12).default(0),
  fadeInMs: Ms.max(VIDEO_MAX_FADE_MS).default(0),
  fadeOutMs: Ms.max(VIDEO_MAX_FADE_MS).default(0),
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
});
export type AudioItem = z.infer<typeof AudioItem>;

export const OverlayAnimation = z.object({
  kind: z.enum(['none', 'fade', 'slide_up']),
  durationMs: Ms.max(VIDEO_MAX_ANIMATION_MS),
});
export type OverlayAnimation = z.infer<typeof OverlayAnimation>;

/** Graphic element types an overlay may carry (they draw through the shared scene renderer). */
export const OVERLAY_ELEMENT_TYPES = ['text', 'logo', 'image', 'shape'] as const;

/** A graphic element (text, logo, image or shape) shown over the picture from startMs to endMs. */
export const OverlayItem = z.object({
  id: VideoId,
  startMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
  endMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
  element: ElementSchema.refine(
    (e: Element) => (OVERLAY_ELEMENT_TYPES as readonly string[]).includes(e.type),
    'overlays carry a text, logo, image or shape element',
  ),
  enter: OverlayAnimation.optional(),
  exit: OverlayAnimation.optional(),
  locked: z.boolean().default(false),
});
export type OverlayItem = z.infer<typeof OverlayItem>;

export const CaptionPosition = z.enum(['top', 'middle', 'bottom']);
export type CaptionPosition = z.infer<typeof CaptionPosition>;

export const CaptionItem = z.object({
  id: VideoId,
  startMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
  endMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
  text: z.string().min(1).max(VIDEO_CAPTION_MAX_CHARS),
  /** Overrides the track's position for this caption. */
  position: CaptionPosition.optional(),
  locked: z.boolean().default(false),
});
export type CaptionItem = z.infer<typeof CaptionItem>;

/** How a caption track draws (burnt in by the scene renderer; also written as a WebVTT sidecar). */
export const CaptionStyle = z.object({
  fontAssetVersionId: z.string().min(1).max(40),
  sizePx: z.number().min(16).max(200).default(48),
  weight: z.number().min(100).max(900).default(600),
  colourToken: z.string().max(60).optional(),
  colourValue: z.string().max(20).optional(),
  /** Colour token of the box behind the text; no box when absent. */
  boxToken: z.string().max(60).optional(),
  boxOpacity: z.number().min(0).max(1).default(0.6),
  position: CaptionPosition.default('bottom'),
});
export type CaptionStyle = z.infer<typeof CaptionStyle>;

const TrackBase = z.object({
  id: VideoId,
  name: z.string().min(1).max(60),
  locked: z.boolean().default(false),
});
export const VideoTrack = TrackBase.extend({
  kind: z.literal('video'),
  muted: z.boolean().default(false),
  items: z.array(VideoClipItem).max(VIDEO_MAX_ITEMS_PER_TRACK),
});
export const AudioTrack = TrackBase.extend({
  kind: z.literal('audio'),
  muted: z.boolean().default(false),
  items: z.array(AudioItem).max(VIDEO_MAX_ITEMS_PER_TRACK),
});
export const OverlayTrack = TrackBase.extend({
  kind: z.literal('overlay'),
  items: z.array(OverlayItem).max(VIDEO_MAX_ITEMS_PER_TRACK),
});
export const CaptionTrack = TrackBase.extend({
  kind: z.literal('caption'),
  style: CaptionStyle,
  items: z.array(CaptionItem).max(VIDEO_MAX_ITEMS_PER_TRACK),
});
export const Track = z.discriminatedUnion('kind', [VideoTrack, AudioTrack, OverlayTrack, CaptionTrack]);
export type VideoTrack = z.infer<typeof VideoTrack>;
export type AudioTrack = z.infer<typeof AudioTrack>;
export type OverlayTrack = z.infer<typeof OverlayTrack>;
export type CaptionTrack = z.infer<typeof CaptionTrack>;
export type Track = z.infer<typeof Track>;
export type TrackKind = Track['kind'];
export type TrackItem = VideoClipItem | AudioItem | OverlayItem | CaptionItem;

/** A storyboard section: grouping for scrubbing, scene reordering and (STU-3) the scope of an AI request. */
export const VideoScene = z.object({
  id: VideoId,
  title: z.string().min(1).max(80),
  startMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
  endMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
});
export type VideoScene = z.infer<typeof VideoScene>;

export const VideoProjectV1 = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('video'),
  brandVersionId: z.string(),
  templateVersionId: z.string().optional(),
  /** The built-in starter template the project was made from, when it was. */
  templateKey: z.string().max(60).optional(),
  format: VideoFormat,
  durationMs: Ms.min(VIDEO_MIN_DURATION_MS).max(VIDEO_PROJECT_MAX_DURATION_MS),
  tracks: z.array(Track).min(1).max(VIDEO_MAX_TRACKS),
  scenes: z.array(VideoScene).max(VIDEO_MAX_SCENES).default([]),
});
export type VideoProjectV1 = z.infer<typeof VideoProjectV1>;

/** A revision snapshot that is a video project (the `kind` field; graphic snapshots never carry it). */
export const isVideoProject = (snapshot: unknown): boolean =>
  typeof snapshot === 'object' && snapshot !== null && (snapshot as { kind?: unknown }).kind === 'video';

// ---- operations (one contract for people and agents, like graphic Operation) ------------------------------------

/**
 * Ripple (`ripple: true`) keeps the track gap-free around the edit: later items on the same track shift by the
 * change in length (insert/duplicate shift right, remove shifts left, trim shifts by the length difference, a ripple
 * move is a ripple remove followed by a ripple insert at the target time in the timeline without the item). Only
 * the edited track moves; a locked item that would move refuses the operation. Without ripple nothing else moves
 * and the edit must fit (no overlap on video and audio tracks).
 */
const Ripple = z.boolean().optional();
const ItemRef = { trackId: VideoId, itemId: VideoId };

export const VideoOperation = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insertClip'),
    trackId: VideoId,
    /** Read as the track's item kind; strict so an audio item's fades are never taken for a clip's fields. */
    item: z.union([VideoClipItem.strict(), AudioItem.strict()]),
    ripple: Ripple,
  }),
  z.object({
    op: z.literal('moveClip'),
    ...ItemRef,
    startMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
    /** Another track of the same kind. */
    toTrackId: VideoId.optional(),
    ripple: Ripple,
  }),
  z.object({
    op: z.literal('trimClip'),
    ...ItemRef,
    sourceInMs: Ms.max(VIDEO_SOURCE_MAX_MS),
    sourceOutMs: Ms.max(VIDEO_SOURCE_MAX_MS),
    ripple: Ripple,
  }),
  z.object({
    op: z.literal('splitClip'),
    ...ItemRef,
    atMs: Ms.max(VIDEO_PROJECT_MAX_DURATION_MS),
    newItemId: VideoId,
  }),
  z.object({ op: z.literal('duplicateClip'), ...ItemRef, newItemId: VideoId, ripple: Ripple }),
  z.object({ op: z.literal('removeClip'), ...ItemRef, ripple: Ripple }),
  z.object({
    op: z.literal('replaceClipSource'),
    ...ItemRef,
    assetVersionId: z.string().min(1).max(40),
    /** Where the new source starts; the clip keeps its length. Default 0. */
    sourceInMs: Ms.max(VIDEO_SOURCE_MAX_MS).optional(),
  }),
  z.object({ op: z.literal('setClipFrame'), ...ItemRef, frame: ClipFrame }),
  z.object({ op: z.literal('setTransition'), ...ItemRef, transition: VideoTransition.nullable() }),
  z.object({
    op: z.literal('setAudio'),
    ...ItemRef,
    gainDb: z.number().min(-60).max(12).optional(),
    muted: z.boolean().optional(),
    fadeInMs: Ms.max(VIDEO_MAX_FADE_MS).optional(),
    fadeOutMs: Ms.max(VIDEO_MAX_FADE_MS).optional(),
  }),
  z.object({ op: z.literal('upsertCaption'), trackId: VideoId, caption: CaptionItem }),
  z.object({ op: z.literal('removeCaption'), ...ItemRef }),
  z.object({ op: z.literal('setCaptionStyle'), trackId: VideoId, style: CaptionStyle }),
  z.object({ op: z.literal('setOverlay'), trackId: VideoId, overlay: OverlayItem }),
  z.object({ op: z.literal('removeOverlay'), ...ItemRef }),
  z.object({ op: z.literal('setTrackLock'), trackId: VideoId, locked: z.boolean() }),
  z.object({ op: z.literal('setTrackMute'), trackId: VideoId, muted: z.boolean() }),
  z.object({ op: z.literal('setItemLock'), ...ItemRef, locked: z.boolean() }),
  z.object({
    op: z.literal('setDuration'),
    durationMs: Ms.min(VIDEO_MIN_DURATION_MS).max(VIDEO_PROJECT_MAX_DURATION_MS),
  }),
  z.object({ op: z.literal('setScene'), scene: VideoScene }),
  z.object({ op: z.literal('removeScene'), sceneId: VideoId }),
  z.object({ op: z.literal('reorderScenes'), order: z.array(VideoId).min(1).max(VIDEO_MAX_SCENES) }),
  z.object({ op: z.literal('addTrack'), track: Track, index: z.number().int().min(0).optional() }),
  z.object({ op: z.literal('removeTrack'), trackId: VideoId }),
]);
export type VideoOperation = z.infer<typeof VideoOperation>;
export type VideoOperationName = VideoOperation['op'];

export const VideoOperationBatch = z.object({
  baseRevisionId: z.string(),
  operations: z.array(VideoOperation).min(1).max(100),
  summary: z.string().max(500),
  origin: z.enum(['user', 'agent']),
  agentRunId: z.string().optional(),
});
export type VideoOperationBatch = z.infer<typeof VideoOperationBatch>;

// ---- router DTOs ------------------------------------------------------------------------------------------------

/** operations.applyVideo: a video batch plus the document it targets (spec 11.4 applied to the timeline). */
export const VideoOperationsApply = VideoOperationBatch.extend({ documentId: z.string() });
export type VideoOperationsApply = z.infer<typeof VideoOperationsApply>;
/** operations.proposeVideo: the same guards, reduction and validation as a dry run. */
export const VideoOperationsPropose = VideoOperationsApply;
export const VideoTemplateList = z.object({ brandId: z.string() });

/**
 * What the editor needs to know about a source without probing it: kind, duration (video/audio), displayed size and
 * whether it has sound. The service resolves it for every asset version a project references.
 */
export const VideoMediaInfo = z.object({
  assetVersionId: z.string(),
  kind: z.enum(['video', 'audio', 'image']),
  mime: z.string(),
  durationMs: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  hasAudio: z.boolean(),
  /** Derivatives the editor can fetch through assets.media.signedUrl. */
  derivatives: z.array(z.string()).max(12),
});
export type VideoMediaInfo = z.infer<typeof VideoMediaInfo>;

// ---- built-in starter templates (STU-1a's creation screen consumes them) ---------------------------------------

/** A slot the creation screen (or STU-3 assembly) fills: a clip placeholder or a text/logo overlay. */
export const VideoTemplateSlot = z.object({
  key: z.string().min(1).max(60),
  kind: z.enum(['clip', 'text', 'logo', 'caption', 'audio']),
  label: z.string().max(120),
  trackId: VideoId,
  itemId: VideoId.optional(),
  sceneId: VideoId.optional(),
  startMs: Ms,
  endMs: Ms,
  /** Suggested text for text slots; the clip slot's shot description. */
  hint: z.string().max(300).optional(),
});
export type VideoTemplateSlot = z.infer<typeof VideoTemplateSlot>;

export const VideoTemplateSummary = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  formatKey: VideoFormatKey,
  fps: VideoFps,
  durationMs: z.number().int().positive(),
  scenes: z.array(VideoScene),
  slots: z.array(VideoTemplateSlot),
});
export type VideoTemplateSummary = z.infer<typeof VideoTemplateSummary>;
