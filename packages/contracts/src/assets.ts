import { z } from 'zod';
import { PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';

export const AssetKind = z.enum([
  'logo',
  'photo',
  'icon',
  'illustration',
  'font',
  'video',
  'audio',
  'template',
  'reference',
]);
export type AssetKind = z.infer<typeof AssetKind>;

export const AssetState = z.enum(['pending_review', 'approved', 'rejected', 'retired']);
export type AssetState = z.infer<typeof AssetState>;

export const UploadIntentState = z.enum(['issued', 'uploaded', 'quarantined', 'accepted', 'rejected']);
export type UploadIntentState = z.infer<typeof UploadIntentState>;

export const AssetPurpose = z.enum(['creative', 'logo', 'font', 'reference']);
export type AssetPurpose = z.infer<typeof AssetPurpose>;

/** Licence and identity metadata parsed from a font file at ingest (spec 9.1 step 4). */
export const FontMetadata = z.object({
  family: z.string().max(200).nullable(),
  subfamily: z.string().max(200).nullable(),
  postscriptName: z.string().max(200).nullable(),
  copyright: z.string().max(500).nullable(),
  licence: z.string().max(500).nullable(),
  licenceUrl: z.string().max(500).nullable(),
  fontVersion: z.string().max(100).nullable(),
  glyphs: z.number().int().nonnegative(),
});
export type FontMetadata = z.infer<typeof FontMetadata>;

export const FontStyle = z.enum(['normal', 'italic']);
export type FontStyle = z.infer<typeof FontStyle>;

/** CSS unicode-range syntax (U+0000-00FF, U+0131, U+02??): what a subset file covers, used as the FontFace descriptor. */
export const UNICODE_RANGE =
  /^U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?(?:,\s*U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)*$/i;

/**
 * One file of a font face imported from a font service. Google Fonts serves a face as one file per unicode subset;
 * files with the same source, family, weight and style are one face, registered together under one family name.
 */
export const ImportedFontFace = z.object({
  family: z.string().min(1).max(100),
  weight: z.number().int().min(1).max(1000),
  style: FontStyle,
  /**
   * A variable file serves a range of weights (css2 names the same file for every weight requested): the range it
   * covers, `weight` being its low end. Absent for a static file of one weight.
   */
  weightRange: z
    .object({ min: z.number().int().min(1).max(1000), max: z.number().int().min(1).max(1000) })
    .optional(),
  /** The subset the source names (latin, latin-ext); null when it names none. */
  subset: z.string().max(40).nullable(),
  unicodeRange: z.string().max(4000).regex(UNICODE_RANGE).nullable(),
});
export type ImportedFontFace = z.infer<typeof ImportedFontFace>;

/** Spec 9.1: accepted kinds and caps (recommended defaults). */
export const UPLOAD_CAPS_BYTES: Record<string, number> = {
  image: 50 * 1024 * 1024,
  svg: 2 * 1024 * 1024,
  font: 10 * 1024 * 1024,
  // Architecture (Studio, video v1): a source video is at most 1 GiB; audio at most 200 MiB. Generated clips are far
  // below both, so the generated path keeps working unchanged.
  video: 1024 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  pdf: 100 * 1024 * 1024,
};

export const ACCEPTED_MIMES: Record<string, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'],
  svg: ['image/svg+xml'],
  font: [
    'font/otf',
    'font/ttf',
    'font/woff2',
    'font/woff',
    'application/font-woff',
    'application/font-sfnt',
    'application/x-font-ttf',
    'application/x-font-otf',
  ],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac'],
  pdf: ['application/pdf'],
};

export const Provenance = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upload'),
    uploadedByUserId: z.string(),
    originalFilename: z.string().max(255),
    /** Recorded by the ingest pipeline: what the file itself declared (fonts) and whether it was sanitised. */
    fontMetadata: FontMetadata.optional(),
    sanitised: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('generated'),
    model: z.string(),
    promptHash: z.string(),
    inputs: z.array(z.string()),
    agentRunId: z.string().optional(),
  }),
  z.object({ kind: z.literal('derived'), fromAssetVersionId: z.string(), transform: z.string() }),
  z.object({
    kind: z.literal('imported'),
    source: z.string(),
    externalRef: z.string(),
    /** A font face imported from a font service (Google Fonts): which face, and the unicode subset this file covers. */
    font: ImportedFontFace.optional(),
    /** The licence as the source states it; recorded, never inferred. */
    licence: z.string().max(500).optional(),
    /** Recorded by the ingest pipeline from the file itself, as for an upload. */
    fontMetadata: FontMetadata.optional(),
  }),
]);
export type Provenance = z.infer<typeof Provenance>;

export const UsageRightsInput = z.object({
  assetId: z.string(),
  owner: z.string().max(200),
  licenceRef: z.string().max(500).optional(),
  permittedChannels: z.union([z.literal('all'), z.array(z.string()).max(50)]),
  territories: z.union([z.literal('all'), z.array(z.string()).max(100)]),
  expiresAt: z.string().datetime().optional(),
  releases: z.array(z.object({ kind: z.enum(['model', 'property', 'talent']), ref: z.string() })).default([]),
  restrictions: z.array(z.string().max(200)).default([]),
});

export const UploadIntentCreate = z.object({
  brandId: z.string(),
  kind: AssetKind,
  declaredMime: z.string().max(100),
  declaredBytes: z.number().int().positive(),
  originalFilename: z.string().max(255),
});

export const EligibilityQuery = z.object({
  brandId: z.string(),
  purpose: AssetPurpose,
  channelConnectionIds: z.array(z.string()).max(50).default([]),
  territory: z.string().optional(),
  scheduledFor: z.string().datetime().optional(),
  kinds: z.array(AssetKind).optional(),
  query: z.string().max(200).optional(),
});
export type EligibilityQuery = z.infer<typeof EligibilityQuery>;

export interface AssetRef {
  assetId: string;
  assetVersionId: string;
  kind: AssetKind;
  semanticRole: string | null;
  altText: string | null;
  contentHash: string;
  width: number | null;
  height: number | null;
  /** Video and audio: the duration ffprobe measured at ingest. */
  durationMs?: number | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 2 asset library DTOs (spec 7.5 assets router, 9.1 ingestion, 9.2 eligibility, 9.3 delivery).
// ---------------------------------------------------------------------------------------------------------------

export const MimeGroup = z.enum(['image', 'svg', 'font', 'video', 'audio', 'pdf']);
export type MimeGroup = z.infer<typeof MimeGroup>;

/** Which mime groups each asset kind may be uploaded as (spec 9.1 accepted kinds). */
export const KIND_MIME_GROUPS: Readonly<Record<AssetKind, readonly MimeGroup[]>> = {
  logo: ['svg', 'image'],
  photo: ['image'],
  icon: ['svg', 'image'],
  illustration: ['svg', 'image'],
  font: ['font'],
  video: ['video'],
  audio: ['audio'],
  template: ['image', 'svg', 'pdf'],
  reference: ['image', 'svg', 'pdf'],
};

/**
 * Longest generated clip ingest accepts, in seconds, per mime group (ADR-11, D-06): a generated video or audio upload
 * keeps these caps when it is probed by the video ingest workflow.
 */
export const MEDIA_DURATION_CAPS_SECONDS: Readonly<Record<'video' | 'audio', number>> = {
  video: 120,
  audio: 600,
};

/**
 * Studio architecture, video v1: what a person's own video or audio upload may be. Video and audio are processed by
 * videoIngestWorkflowV1 on task queue `video` (ffprobe inspection, poster, thumbnail strip, editing proxy, waveform).
 * Bytes are capped by UPLOAD_CAPS_BYTES at the intent; these are the limits ffprobe checks.
 */
export const PERSON_MEDIA_LIMITS = {
  /** Longest source, in seconds, per group. */
  durationSeconds: { video: 600, audio: 600 } as Readonly<Record<'video' | 'audio', number>>,
  /** Largest side of a source frame after rotation (8K UHD). */
  maxDimension: 7680,
  /** Smallest side of a source frame. */
  minDimension: 16,
  /** Frame rates outside this range are refused (average over the stream). */
  minFps: 1,
  maxFps: 240,
  /**
   * Variable frame rate is accepted (phones record it) unless it is extreme: the nominal rate (r_frame_rate) more
   * than this many times the average means frames are missing or bunched beyond what an edit can follow.
   */
  maxVfrRatio: 3,
} as const;

/** Codecs ffmpeg 6.1 in the render image decodes and the video pipeline accepts (architecture: video v1 limits). */
export const ACCEPTED_VIDEO_CODECS: readonly string[] = [
  'h264',
  'hevc',
  'vp8',
  'vp9',
  'av1',
  'prores',
  'mpeg4',
];
export const ACCEPTED_AUDIO_CODECS: readonly string[] = [
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'flac',
  'alac',
  'ac3',
  'eac3',
  'pcm_s16le',
  'pcm_s16be',
  'pcm_s24le',
  'pcm_s24be',
  'pcm_s32le',
  'pcm_f32le',
  'pcm_u8',
];

/** Archives are rejected in Release 1 (spec 9.1); named explicitly so the rejection reason is specific. */
export const ARCHIVE_MIMES: readonly string[] = [
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/x-bzip2',
  'application/java-archive',
];

/** Spec 9.2: rights must outlive the scheduled time plus the provider processing window. */
export const RIGHTS_PROCESSING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Spec 9.3: the web app receives 5-minute signed URLs. */
export const SIGNED_URL_TTL_SEC = 5 * 60;
/** A presigned PUT is valid for one hour; an intent not completed by then expires. */
export const UPLOAD_INTENT_TTL_SEC = 60 * 60;
/** Header-declared pixel budget for raster images: checked before any decode (decompression bombs, spec 18). */
export const MAX_IMAGE_PIXELS = 64_000_000;

/** Kinds compatible with each purpose (spec 9.2 "kind compatible with :purpose"). */
/**
 * Still-image kinds: what a graphic document's image, logo and background layers (and a video's stills and image
 * overlays) may use. STU-2b: the `creative` purpose also takes a person's video and audio uploads (with recorded
 * rights, like every creative asset) for timelines; graphic layers keep to these kinds.
 */
export const IMAGE_CREATIVE_KINDS: readonly AssetKind[] = ['photo', 'illustration', 'icon', 'logo'];

export const PURPOSE_KINDS: Readonly<Record<AssetPurpose, readonly AssetKind[]>> = {
  logo: ['logo'],
  font: ['font'],
  creative: [...IMAGE_CREATIVE_KINDS, 'video', 'audio'],
  reference: AssetKind.options,
};

/** Purposes that require recorded usage rights; 'unknown' rights make an asset ineligible for them. */
export const PURPOSES_REQUIRING_RIGHTS: readonly AssetPurpose[] = ['creative', 'logo'];

/**
 * Renditions kept for a version at ingest. Raster sources get thumbnail, preview and web; `png` (BSC-2) is a
 * transparent PNG of an SVG, for destinations that accept rasters only (website articles); raster uploads have none,
 * their original already is one. Video and audio (STU-2a video ingest) get thumbnail and preview (a poster frame, or
 * the waveform drawn for audio), plus poster (full-size WebP frame), strip (thumbnail sprite) with strip_map (its JSON
 * timings), proxy (720p H.264/AAC faststart MP4, or 128k AAC for audio) and waveform (peaks JSON).
 */
export const DerivativePurpose = z.enum([
  'thumbnail',
  'preview',
  'web',
  'png',
  'poster',
  'strip',
  'strip_map',
  'proxy',
  'waveform',
]);
export type DerivativePurpose = z.infer<typeof DerivativePurpose>;

export const UploadIntentComplete = z.object({ intentId: z.string() });

/** Where an upload stands: an intent's state, the asset it became once accepted, or why it was rejected (spec 9.1). */
export const UploadIntentGet = z.object({ intentId: z.string() });

export const AssetGet = z.object({ assetId: z.string() });

export const AssetVersionsList = z.object({ assetId: z.string(), page: PageRequest });

export const AssetSearch = z.object({ query: EligibilityQuery, page: PageRequest });

/**
 * Why an asset is not (or will soon not be) usable, as the library shows it (spec 21.2 asset states): the state
 * machine's non-approved states, rights missing or expired, rights expiring within the attention window, no
 * ingested version.
 */
export const AssetIssue = z.enum([
  'pending_review',
  'rejected',
  'retired',
  'rights_unknown',
  'rights_expired',
  'rights_expiring',
  'no_version',
]);
export type AssetIssue = z.infer<typeof AssetIssue>;
/** Rights expiring inside this window count as needing attention. */
export const RIGHTS_ATTENTION_DAYS = 30;

/**
 * The brand's assets in every state, newest first (spec 9.2 search returns eligible assets only; this is the
 * librarian's view). `needsAttention` keeps the rows with at least one issue; `state` and `kinds` narrow further.
 */
export const AssetList = z.object({
  brandId: z.string(),
  state: AssetState.optional(),
  kinds: z.array(AssetKind).max(20).optional(),
  query: z.string().max(200).optional(),
  needsAttention: z.boolean().optional(),
  page: PageRequest,
});

export const AssetApprove = z.object({
  assetId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
});

export const AssetRetire = z.object({
  assetId: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().max(200).optional(),
});

export const AssetUsagesList = z.object({ assetId: z.string(), page: PageRequest });

export const AssetGrantCreate = z.object({
  assetId: z.string(),
  granteeBrandId: z.string(),
  purpose: AssetPurpose,
  expiresAt: z.string().datetime().optional(),
});

/** Spec 9.3: a short-lived signed GET for the original or one derivative of a version. */
export const MediaSignedUrlRequest = z.object({
  assetVersionId: z.string(),
  derivative: z.union([z.literal('original'), DerivativePurpose]).default('preview'),
});

/** The widths a PNG download of a logo (or any image) is offered at, in pixels. */
export const DOWNLOAD_PNG_WIDTHS = [256, 512, 1024, 2048] as const;
export type DownloadPngWidth = (typeof DOWNLOAD_PNG_WIDTHS)[number];

/**
 * BSC-2: a file to save, not to show. A 5-minute signed GET whose response is an attachment with the right type and a
 * file name from the asset's name: the original as uploaded (an SVG stays vector), or a PNG at one of the offered
 * widths drawn from it (transparency kept). Never served inline from the API's origin.
 */
export const AssetDownloadRequest = z.object({
  assetVersionId: z.string(),
  format: z.enum(['original', 'png']),
  width: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048)]).optional(),
});
export type AssetDownloadRequest = z.infer<typeof AssetDownloadRequest>;

/** Spec 9.2 reasons an asset is not eligible; `authoriseUse` surfaces them in RIGHTS_INELIGIBLE. */
export const EligibilityReason = z.enum([
  'state_not_approved',
  'brand_not_permitted',
  'kind_incompatible',
  'rights_unknown',
  'rights_expired',
  'channel_not_permitted',
  'territory_not_permitted',
]);
export type EligibilityReason = z.infer<typeof EligibilityReason>;

/** Spec 9.1 rejection codes. Rejections are values, never exceptions (steps.ts). */
export const IngestRejectionReason = z.enum([
  'object_missing',
  'exceeds_cap',
  'type_unrecognised',
  'type_mismatch',
  'declared_mime_mismatch',
  'archive_rejected',
  'malware_detected',
  'scanner_unavailable',
  'svg_unparsable',
  'svg_unsafe_content',
  'svg_unrenderable',
  // BSC-2: the specific reason an SVG is refused, so the uploader is told what to remove (svg_unsafe_content remains
  // for any other active content and for intents rejected before these existed).
  'svg_script',
  'svg_event_handler',
  'svg_external_reference',
  'svg_embedded_content',
  'svg_remote_image',
  'svg_entity_declaration',
  'svg_no_size',
  'font_unparsable',
  'font_collection_unsupported',
  'pixel_limit_exceeded',
  'image_undecodable',
  'format_unsupported',
  'duplicate_of',
  'media_malformed',
  'duration_exceeds_cap',
  // Video ingest (Studio video v1; appended): actionable reasons from ffprobe/ffmpeg, surfaced to the uploader.
  'media_no_video_stream',
  'media_no_audio_stream',
  'media_codec_unsupported',
  'media_undecodable',
  'media_frame_rate_unsupported',
  'media_dimensions_unsupported',
  'media_processing_failed',
]);
export type IngestRejectionReason = z.infer<typeof IngestRejectionReason>;

/**
 * What the uploader is told when ingest refuses a file (BSC-2): the problem and what to do about it, in words a
 * designer acts on. Shown in place of the reason code wherever an upload's outcome is shown.
 */
export const INGEST_REJECTION_MESSAGES: Readonly<Record<IngestRejectionReason, string>> = {
  object_missing: 'The upload did not arrive. Try uploading the file again.',
  exceeds_cap:
    'The file is larger than allowed for its type (2 MB for SVG, 50 MB for images, 10 MB for fonts, 1 GB for video, 200 MB for audio). Export a smaller file and upload it again.',
  type_unrecognised: 'The file type could not be recognised. Upload SVG, PNG, WebP or JPEG.',
  type_mismatch:
    'This type of file cannot be used here. Logos and icons take SVG, PNG or WebP; photos take PNG, JPEG or WebP.',
  declared_mime_mismatch:
    'The file’s contents do not match its name or type. Re-export it from your design tool and upload it again.',
  archive_rejected: 'Archives (zip and similar) cannot be uploaded. Upload the files inside one by one.',
  malware_detected: 'The virus scanner flagged this file. It was deleted and not catalogued.',
  scanner_unavailable:
    'The virus scanner could not check the file yet. It is held and checked again shortly; nothing is needed from you.',
  svg_unparsable:
    'The SVG could not be read. Re-export it from your design tool as plain SVG and upload it again.',
  svg_unsafe_content:
    'The SVG contains active content that is not allowed in brand files. Re-export it as plain SVG (outlines, fills, gradients) and upload it again.',
  svg_unrenderable:
    'The SVG could not be drawn. Re-export it from your design tool as plain SVG (convert text to outlines) and upload it again.',
  svg_script:
    'The SVG contains a script (a <script> element or a javascript: link). Remove it, or re-export as plain SVG, and upload it again.',
  svg_event_handler:
    'The SVG contains event handler attributes (onload, onclick and similar), which run code. Remove them, or re-export as plain SVG, and upload it again.',
  svg_external_reference:
    'The SVG loads something from another address (an external link, url(http…) or @import in its styles). Embed or remove what it points to so the file is self-contained, and upload it again.',
  svg_embedded_content:
    'The SVG embeds another document or player (foreignObject, iframe, object, or a data: address that is not an image). Remove it, or re-export as plain SVG, and upload it again.',
  svg_remote_image:
    'The SVG shows an image fetched from another address. Embed the image in the file (or convert it to vector) and upload it again.',
  svg_entity_declaration:
    'The SVG declares XML entities that point to other files or expand into other entities, which are not allowed. Re-export it as plain SVG (for example Illustrator: Export As > SVG) and upload it again.',
  svg_no_size:
    'The SVG has no size: give the root <svg> a width and height, or a viewBox, and upload it again.',
  font_unparsable: 'The font file could not be read. Upload an OTF, TTF, WOFF or WOFF2 file.',
  font_collection_unsupported: 'Font collections (.ttc) are not supported. Upload each face as its own file.',
  pixel_limit_exceeded:
    'The image is too large in pixels (more than 64 megapixels). Export it at a smaller size and upload it again.',
  image_undecodable: 'The image could not be decoded. Re-export it and upload it again.',
  format_unsupported: 'This file format is not supported here.',
  duplicate_of: 'This file is already in the brand’s assets. Use the existing asset instead.',
  media_malformed:
    'The file is damaged or incomplete (for example an upload cut short, or a length that does not match its contents). Export it again and upload the new file.',
  duration_exceeds_cap:
    'The media is longer than allowed (10 minutes for video and audio). Trim it and upload it again.',
  media_no_video_stream: 'The file has no video picture. Upload it as audio, or choose a video file.',
  media_no_audio_stream: 'The file has no sound. Upload an audio file with an audio track.',
  media_codec_unsupported:
    'The file uses a codec that cannot be processed. Export it as H.264 (video) with AAC (audio) and upload it again.',
  media_undecodable: 'The file could not be decoded. Export it again and upload the new file.',
  media_frame_rate_unsupported:
    'The frame rate cannot be edited reliably. Re-export at a constant frame rate (24, 25, 30 or 60 fps) and upload it again.',
  media_dimensions_unsupported:
    'The picture size is outside what can be processed (at most 8K, at least 16 pixels per side). Export a smaller version and upload it again.',
  media_processing_failed: 'Processing failed. Try again; if it keeps failing, export the file again.',
};

/** The message for a stored rejection reason, or null when the stored value is not a known reason. */
export const ingestRejectionMessage = (reason: string | null | undefined): string | null => {
  const parsed = IngestRejectionReason.safeParse(reason);
  return parsed.success ? INGEST_REJECTION_MESSAGES[parsed.data] : null;
};

export interface IngestStepRejection {
  ok: false;
  reason: IngestRejectionReason;
  /** Short, user-safe detail (never raw parser output). */
  detail?: string;
  /** Set with reason 'duplicate_of': the existing asset the uploader is invited to link instead. */
  duplicateOfAssetId?: string;
  /** Infrastructure failure (scanner unreachable): the activity retries; the intent stays quarantined. */
  retryable?: boolean;
}
export type IngestStepResult<T extends object> = ({ ok: true } & T) | IngestStepRejection;

export interface IngestDerivativeRef {
  purpose: DerivativePurpose;
  key: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  contentHash: string;
  transform: Record<string, string | number | boolean>;
}

// --- assetIngestWorkflowV1 contract (workflows import only contracts) ---------------------------------------

/** Every activity input carries the tenant context (spec 5.2) plus the intent; activities re-load the rest. */
export const AssetIngestInputV1 = TenantContextInput.extend({ intentId: z.string(), brandId: z.string() });
export type AssetIngestInputV1 = z.infer<typeof AssetIngestInputV1>;

export type AssetIngestOutcome = 'accepted' | 'rejected' | 'quarantined';

export type AssetIngestResultV1 =
  | { outcome: 'accepted'; assetId: string; assetVersionId: string; state: AssetState }
  | { outcome: 'rejected'; reason: IngestRejectionReason; duplicateOfAssetId?: string }
  | { outcome: 'quarantined'; reason: IngestRejectionReason };

export interface IngestBeginResult {
  intentId: string;
  brandId: string;
  kind: AssetKind;
  declaredMime: string;
  maxBytes: number;
  storageKey: string;
}
export interface IngestVerifyResult {
  bytes: number;
}
export interface IngestSniffResult {
  mime: string;
  group: MimeGroup;
}
export interface IngestScanResult {
  engine: string;
}
export interface IngestSanitiseResult {
  sanitisedKey: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  colourProfile: string | null;
  fontMetadata?: FontMetadata;
  /** Rasterised PNG of a sanitised SVG, used as the source of its derivatives. */
  previewKey?: string;
  sanitised: boolean;
}
export interface IngestHashResult {
  contentHash: string;
}
export interface IngestDerivativesResult {
  derivatives: IngestDerivativeRef[];
}
export interface IngestMoveResult {
  assetId: string;
  assetVersionId: string;
  originalKey: string;
  derivatives: IngestDerivativeRef[];
}
export interface IngestCatalogueResult {
  assetId: string;
  assetVersionId: string;
  state: AssetState;
}

export type IngestSanitiseInput = AssetIngestInputV1 & { mime: string; group: MimeGroup };
export type IngestHashInput = AssetIngestInputV1 & { sanitisedKey: string };
export type IngestDerivativesInput = AssetIngestInputV1 & {
  sanitisedKey: string;
  mime: string;
  group: MimeGroup;
  previewKey?: string;
};
export type IngestMoveInput = AssetIngestInputV1 & {
  sanitisedKey: string;
  derivatives: IngestDerivativeRef[];
};
export type IngestCatalogueInput = AssetIngestInputV1 & {
  assetId: string;
  assetVersionId: string;
  originalKey: string;
  contentHash: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  colourProfile: string | null;
  fontMetadata?: FontMetadata;
  sanitised: boolean;
  derivatives: IngestDerivativeRef[];
};
export type IngestFinaliseInput = AssetIngestInputV1 & {
  outcome: AssetIngestOutcome;
  reason?: IngestRejectionReason;
  duplicateOfAssetId?: string;
  /** Quarantine-prefixed keys to delete; the activity refuses anything outside quarantine/{tenant}/. */
  cleanupKeys: string[];
};

/**
 * The activity surface of assetIngestWorkflowV1 (spec 9.1 steps 1–8). Activity parameters are frozen once
 * deployed: a change ships as a new interface version and a new workflow version.
 */
export interface AssetIngestActivitiesV1 {
  beginIngest(input: AssetIngestInputV1): Promise<IngestBeginResult>;
  verifyUpload(input: AssetIngestInputV1): Promise<IngestStepResult<IngestVerifyResult>>;
  sniffUpload(input: AssetIngestInputV1): Promise<IngestStepResult<IngestSniffResult>>;
  scanUpload(input: AssetIngestInputV1): Promise<IngestStepResult<IngestScanResult>>;
  sanitiseUpload(input: IngestSanitiseInput): Promise<IngestStepResult<IngestSanitiseResult>>;
  hashUpload(input: IngestHashInput): Promise<IngestStepResult<IngestHashResult>>;
  buildDerivatives(input: IngestDerivativesInput): Promise<IngestStepResult<IngestDerivativesResult>>;
  moveToImmutable(input: IngestMoveInput): Promise<IngestMoveResult>;
  catalogueAsset(input: IngestCatalogueInput): Promise<IngestCatalogueResult>;
  finaliseUpload(input: IngestFinaliseInput): Promise<void>;
}

// ---- Brand fonts (brand kit typography): the brand's font faces, and importing a family from Google Fonts --------

/** Provenance `source` of files imported from Google Fonts. */
export const GOOGLE_FONTS_SOURCE = 'google_fonts';
/** Recorded as the licence of every Google Fonts file: the service publishes each family's licence (OFL or Apache 2.0). */
export const GOOGLE_FONTS_LICENCE_NOTE =
  'Open-source licence (SIL Open Font License or Apache 2.0) per fonts.google.com';
/** The subsets kept when an import names none: css2 answers one file per subset. */
export const GOOGLE_FONTS_DEFAULT_SUBSETS: readonly string[] = ['latin', 'latin-ext'];
/** At most this many files per import (weights × styles × subsets). */
export const GOOGLE_FONTS_MAX_FILES = 40;

/**
 * Import a family from Google Fonts into the brand's fonts. Family names are letters, digits, spaces and hyphens as
 * fonts.google.com shows them (e.g. "IBM Plex Sans"); weights are the static instances wanted.
 */
export const GoogleFontImport = z.object({
  brandId: z.string(),
  family: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, 'letters, digits, spaces and hyphens only'),
  weights: z
    .array(
      z
        .number()
        .int()
        .min(100)
        .max(900)
        .refine((w) => w % 100 === 0, 'a multiple of 100'),
    )
    .min(1)
    .max(9),
  styles: z.array(FontStyle).min(1).max(2).default(['normal']),
  /** Unicode subsets to keep; default latin and latin-ext. */
  subsets: z
    .array(z.string().regex(/^[a-z0-9-]{1,40}$/))
    .min(1)
    .max(10)
    .optional(),
});
export type GoogleFontImport = z.infer<typeof GoogleFontImport>;

export const BrandFontsList = z.object({ brandId: z.string() });

/** What an import did with each file: already in the brand (reused), or queued for ingest as a new asset. */
export interface GoogleFontImportFile {
  weight: number;
  /** A variable file: the weights it covers (one file, one asset, whatever weights were asked for). */
  weightRange: { min: number; max: number } | null;
  style: FontStyle;
  subset: string | null;
  unicodeRange: string | null;
  contentHash: string;
  outcome: 'existing' | 'queued';
  assetId: string | null;
  intentId: string | null;
}
export interface GoogleFontImportResult {
  family: string;
  files: GoogleFontImportFile[];
}

/** One file of a brand font face (a subset file of an imported face, or the whole of an uploaded one). */
export interface BrandFontFile {
  assetId: string;
  assetVersionId: string;
  mime: string;
  bytes: number;
  subset: string | null;
  unicodeRange: string | null;
}

/**
 * A brand font face: the unit a type role chooses. `assetId` is the file a role names (the latin subset of an
 * imported face, else its first file); every file of the face is registered under one family name for rendering.
 */
export interface BrandFontFace {
  key: string;
  assetId: string;
  assetVersionId: string;
  name: string;
  state: AssetState;
  family: string | null;
  subfamily: string | null;
  weight: number | null;
  /** A variable face: every weight in the range renders from its files. */
  weightRange: { min: number; max: number } | null;
  style: FontStyle;
  format: string;
  source: 'upload' | 'google_fonts' | 'other';
  licence: string | null;
  files: BrandFontFile[];
}
