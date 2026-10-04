// Asset library (spec 9): ingestion pipeline, rights, eligibility and delivery.
export { assetService, type AuthoriseUseOptions } from './service';
export { assetIngest, type IngestDeps } from './ingest/pipeline';
// STU-2a: video and audio ingest (videoIngestWorkflowV1) and the ffprobe/ffmpeg toolkit the video export path reuses.
export { mediaIngest, type MediaIngestDeps } from './ingest/video-pipeline';
export {
  MediaToolError,
  buildMediaDerivatives,
  checkProbe,
  decodeCheck,
  fitInside,
  mediaToolsAvailable,
  parseProbe,
  posterTimeMs,
  probeFile,
  runTool,
  inspectFile,
  stripMetadata,
  demuxerFor,
  withToolContext,
  personalTags,
  ffmpegPath,
  ffprobePath,
  type MediaRejection,
  type RawProbe,
} from './ingest/video';
export { TempDir, TempDiskBudgetExceededError, hashFile, sweepStaleTempDirs, withTempDir } from './temp-disk';
export * as ingestSteps from './ingest/steps';
export {
  ClamAvScanner,
  FakeScanner,
  FailClosedScanner,
  ScannerUnavailableError,
  createScannerFromEnv,
  type ByteStream,
  type Scanner,
  type ScanVerdict,
} from './ingest/scanner';
export {
  S3StorageProvider,
  MemoryStorageProvider,
  assertTenantKey,
  parseStorageKey,
  configureStorage,
  createStorageFromEnv,
  readS3Config,
  objectStoreMissingSettings,
  OBJECT_STORE_SETTINGS,
  uploadsCapability,
  storage,
  storageKeys,
  chunkStream,
  hashStoredObject,
  MULTIPART_PART_BYTES,
  type ByteRange,
  type StorageProvider,
  type S3StorageConfig,
  type SignedUrl,
  type StorageObjectHead,
  type UploadSignOptions,
} from './storage';
export {
  compatibleKinds,
  evaluateEligibility,
  rightsExpiryThreshold,
  rightsRequired,
  type EligibilityCandidate,
  type EligibilityRequest,
  type EligibilityVerdict,
  type RightsRecord,
} from './eligibility';
export {
  AssetRepository,
  AssetVersionRepository,
  AssetDerivativeRepository,
  UsageRightsRepository,
  AssetGrantRepository,
  AssetUsageRepository,
  UploadIntentRepository,
} from './repositories';
export { registerAssetOutboxRoutes, MEDIA_TASK_QUEUE, VIDEO_TASK_QUEUE } from './outbox-routes';
export {
  fontFileIdentity,
  groupFontFaces,
  renderFontFaces,
  styleFromSubfamily,
  weightFromSubfamily,
  type FontFileRow,
  type RenderFontFace,
} from './fonts';
export {
  configureGoogleFonts,
  css2Url,
  fetchGoogleFontFiles,
  parseCss2,
  type GoogleFontFaceSource,
  type GoogleFontFile,
  type GoogleFontsOptions,
} from './google-fonts';
