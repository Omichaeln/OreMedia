import { z } from 'zod';
import type {
  AssetIngestInputV1,
  IngestBeginResult,
  IngestCatalogueInput,
  IngestCatalogueResult,
  IngestDerivativeRef,
  IngestFinaliseInput,
  IngestMoveInput,
  IngestMoveResult,
  IngestScanResult,
  IngestSniffResult,
  IngestStepResult,
  IngestVerifyResult,
} from './assets';

/**
 * Studio video v1 (STU-2a): what ffprobe found in a video or audio source, kept on the asset version
 * (asset_versions.media_info) so the timeline editor, the compositor and the library read it without probing again.
 * Width and height are the displayed frame (after rotation); `codedWidth`/`codedHeight` are the stored frame.
 */
export const MediaVideoStream = z.object({
  codec: z.string().max(40),
  profile: z.string().max(60).nullable(),
  pixelFormat: z.string().max(40).nullable(),
  codedWidth: z.number().int().positive(),
  codedHeight: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Clockwise rotation the player applies (0, 90, 180, 270), from the display matrix or the rotate tag. */
  rotation: z.number().int(),
  /** Average frame rate over the stream (frames per second, 3 decimals). */
  fps: z.number().positive(),
  /** Nominal frame rate (r_frame_rate); differs from fps for variable frame rate sources. */
  nominalFps: z.number().positive(),
  variableFrameRate: z.boolean(),
  bitRate: z.number().int().nonnegative().nullable(),
});
export type MediaVideoStream = z.infer<typeof MediaVideoStream>;

export const MediaAudioStream = z.object({
  codec: z.string().max(40),
  channels: z.number().int().nonnegative(),
  sampleRate: z.number().int().nonnegative(),
  bitRate: z.number().int().nonnegative().nullable(),
});
export type MediaAudioStream = z.infer<typeof MediaAudioStream>;

export const MediaProbeV1 = z.object({
  schemaVersion: z.literal(1),
  /** ffprobe's format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", "mp3", "wav". */
  container: z.string().max(80),
  durationMs: z.number().int().nonnegative(),
  bitRate: z.number().int().nonnegative().nullable(),
  bytes: z.number().int().nonnegative(),
  video: MediaVideoStream.nullable(),
  /** Every audio stream, in stream order (the first is the one proxies and waveforms use). */
  audio: z.array(MediaAudioStream).max(16),
});
export type MediaProbeV1 = z.infer<typeof MediaProbeV1>;

/** Waveform peaks derivative (purpose `waveform`): a fixed number of peaks per second, bounded by the duration cap. */
export const WAVEFORM_PEAKS_PER_SECOND = 20;
export const WaveformV1 = z.object({
  schemaVersion: z.literal(1),
  peaksPerSecond: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  /** Absolute peak of each window, 0..1000 (mono mix of the first audio stream). */
  peaks: z.array(z.number().int().min(0).max(1000)).max(WAVEFORM_PEAKS_PER_SECOND * 600 + 1),
});
export type WaveformV1 = z.infer<typeof WaveformV1>;

/** Thumbnail strip map (purpose `strip_map`): where each frame of the strip sprite sits and which time it shows. */
export const STRIP_FRAMES = 10;
export const StripMapV1 = z.object({
  schemaVersion: z.literal(1),
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  columns: z.number().int().positive(),
  frames: z
    .array(z.object({ index: z.number().int().nonnegative(), timeMs: z.number().int().nonnegative() }))
    .max(STRIP_FRAMES),
});
export type StripMapV1 = z.infer<typeof StripMapV1>;

// --- videoIngestWorkflowV1 contract (workflows import only contracts) ----------------------------------------

/** Inspection result: the streamed content hash (dedupe) and the probe, after the limits were checked. */
export interface IngestMediaInspectResult {
  contentHash: string;
  probe: MediaProbeV1;
}
export type IngestMediaInspectInput = AssetIngestInputV1 & { mime: string; group: 'video' | 'audio' };
export type IngestMediaDerivativesInput = AssetIngestInputV1 & {
  mime: string;
  group: 'video' | 'audio';
  probe: MediaProbeV1;
};
export interface IngestMediaDerivativesResult {
  derivatives: IngestDerivativeRef[];
}
export type IngestMediaCatalogueInput = IngestCatalogueInput & { probe: MediaProbeV1 };
export type IngestMediaFinaliseInput = IngestFinaliseInput & {
  /** Short, user-safe detail kept with the rejection (what was found, what the limit is). */
  detail?: string;
};

/**
 * The activity surface of videoIngestWorkflowV1 (task queue `video`, worker-render). beginIngest, verifyUpload,
 * sniffUpload and moveToImmutable are the same activities assetIngestWorkflowV1 runs (same parameters); the media
 * steps stream the object instead of loading it. Activity parameters are frozen once deployed.
 */
export interface VideoIngestActivitiesV1 {
  beginIngest(input: AssetIngestInputV1): Promise<IngestBeginResult>;
  verifyUpload(input: AssetIngestInputV1): Promise<IngestStepResult<IngestVerifyResult>>;
  sniffUpload(input: AssetIngestInputV1): Promise<IngestStepResult<IngestSniffResult>>;
  scanMediaUpload(input: AssetIngestInputV1): Promise<IngestStepResult<IngestScanResult>>;
  inspectMediaUpload(input: IngestMediaInspectInput): Promise<IngestStepResult<IngestMediaInspectResult>>;
  buildMediaDerivatives(
    input: IngestMediaDerivativesInput,
  ): Promise<IngestStepResult<IngestMediaDerivativesResult>>;
  moveToImmutable(input: IngestMoveInput): Promise<IngestMoveResult>;
  catalogueMediaAsset(input: IngestMediaCatalogueInput): Promise<IngestCatalogueResult>;
  finaliseMediaUpload(input: IngestMediaFinaliseInput): Promise<void>;
}
