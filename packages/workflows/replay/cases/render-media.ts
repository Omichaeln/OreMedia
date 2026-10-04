import { Context } from '@temporalio/activity';
import type {
  AssetIngestActivitiesV1,
  AssetIngestInputV1,
  IngestDerivativeRef,
} from '@oremedia/contracts/assets';
import type { MediaProbeV1, VideoIngestActivitiesV1 } from '@oremedia/contracts/media';
import type {
  RenderFormatResult,
  RenderJobActivitiesV1,
  RenderResolveSuccess,
  VideoComposeResult,
  VideoRenderJobActivitiesV1,
  VideoRenderResolveSuccess,
} from '@oremedia/contracts/render';
import { hash, nonRetryable, tenant, type Recorder, type RecordingCase } from './types';

/**
 * worker-render: asset ingest (task queue `media`), still renders (`render`), and video ingest, timeline renders and
 * the render cancel relay (`video`). Each case is one representative execution; see ./types.ts.
 */
const KEY = 'assets/tnt_replay_1/brd_replay_1';
const QUARANTINE = 'quarantine/tnt_replay_1';

// ---- assetIngestWorkflowV1 ----
const derivative: IngestDerivativeRef = {
  purpose: 'thumbnail',
  key: `${QUARANTINE}/ui_replay/derivative-thumbnail`,
  mime: 'image/webp',
  width: 320,
  height: 240,
  bytes: 9_000,
  contentHash: hash('a'),
  transform: { op: 'resize' },
};
function assetIngest(rec: Recorder, overrides: Partial<AssetIngestActivitiesV1> = {}) {
  const base: AssetIngestActivitiesV1 = {
    beginIngest: async (i) => ({
      intentId: i.intentId,
      brandId: i.brandId,
      kind: 'photo',
      declaredMime: 'image/png',
      maxBytes: 20_000_000,
      storageKey: `${QUARANTINE}/${i.intentId}`,
    }),
    verifyUpload: async () => ({ ok: true, bytes: 500_000 }),
    sniffUpload: async () => ({ ok: true, mime: 'image/png', group: 'image' }),
    scanUpload: async () => ({ ok: true, engine: 'replay-scanner' }),
    sanitiseUpload: async (i) => ({
      ok: true,
      sanitisedKey: `${QUARANTINE}/${i.intentId}/sanitised`,
      previewKey: `${QUARANTINE}/${i.intentId}/preview.png`,
      mime: 'image/png',
      bytes: 480_000,
      width: 1600,
      height: 1200,
      colourProfile: 'srgb',
      sanitised: true,
    }),
    hashUpload: async () => ({ ok: true, contentHash: hash('b') }),
    buildDerivatives: async () => ({ ok: true, derivatives: [derivative] }),
    moveToImmutable: async () => ({
      assetId: 'ast_replay_1',
      assetVersionId: 'av_replay_1',
      originalKey: `${KEY}/ast_replay_1/av_replay_1/original`,
      derivatives: [{ ...derivative, key: `${KEY}/ast_replay_1/av_replay_1/thumbnail` }],
    }),
    catalogueAsset: async () => ({
      assetId: 'ast_replay_1',
      assetVersionId: 'av_replay_1',
      state: 'pending_review',
    }),
    finaliseUpload: async () => undefined,
  };
  return { media: rec<AssetIngestActivitiesV1>({ ...base, ...overrides }) };
}
const ingestInput = (n: number): AssetIngestInputV1 => ({
  ...tenant(1, `corr_replay_ingest_${n}`),
  intentId: `ui_replay_${n}`,
  brandId: 'brd_replay_1',
});
const assetCase = (
  name: string,
  description: string,
  n: number,
  overrides: (rec: Recorder) => Partial<AssetIngestActivitiesV1> = () => ({}),
): RecordingCase => ({
  workflowType: 'assetIngestWorkflowV1',
  name,
  description,
  queue: 'media',
  activities: (rec) => assetIngest(rec, overrides(rec)),
  args: [ingestInput(n)],
  workflowId: `asset-ingest:ui_replay_${n}`,
  state: 'completed',
});

// ---- renderJobWorkflowV1 ----
const resolved: RenderResolveSuccess = {
  ok: true,
  rendererVersion: '1.0.0',
  brandVersionId: 'bv_replay_1',
  revisionContentHash: hash('c'),
  fonts: [
    {
      assetVersionId: 'av_replay_font',
      storageKey: `${KEY}/ast_f/av_replay_font/original`,
      contentHash: hash('f'),
      mime: 'font/ttf',
    },
  ],
  assets: [
    {
      assetVersionId: 'av_replay_logo',
      storageKey: `${KEY}/ast_l/av_replay_logo/original`,
      contentHash: hash('a'),
      mime: 'image/png',
      width: 400,
      height: 120,
    },
  ],
  targets: [
    { pageId: 'page_1', formatKey: 'square_1080', reflow: false },
    { pageId: 'page_1', formatKey: 'ig_feed_4x5', reflow: true },
  ],
  manifest: {
    rendererVersion: '1.0.0',
    fonts: [{ assetVersionId: 'av_replay_font', contentHash: hash('f') }],
    assets: [{ assetVersionId: 'av_replay_logo', contentHash: hash('a') }],
    brandVersionId: 'bv_replay_1',
    revisionContentHash: hash('c'),
  },
};
const rendered = (pageId: string, formatKey: string): RenderFormatResult => ({
  pageId,
  formatKey,
  storageKey: `${KEY}/exports/rev_replay_1/rj_replay/${pageId}-${formatKey}.png`,
  contentHash: hash('e'),
  bytes: 120_000,
  width: 1080,
  height: formatKey === 'ig_feed_4x5' ? 1350 : 1080,
  mime: 'image/png',
  findings: [],
});
function renderJob(rec: Recorder, overrides: Partial<RenderJobActivitiesV1> = {}) {
  const base: RenderJobActivitiesV1 = {
    beginRender: async (i) => ({
      renderJobId: i.renderJobId,
      revisionId: 'rev_replay_1',
      documentId: 'doc_replay_1',
      brandId: 'brd_replay_1',
      formatKeys: ['square_1080', 'ig_feed_4x5'],
    }),
    resolveRenderInputs: async () => resolved,
    renderFormat: async (i) => rendered(i.target.pageId, i.target.formatKey),
    storeExport: async (i) => ({
      storageKey: i.export.storageKey,
      contentHash: i.export.contentHash,
      bytes: i.export.bytes,
    }),
    completeRender: async (i) => ({ exportIds: i.exports.map((_e, n) => `exp_replay_${n + 1}`) }),
    failRender: async () => undefined,
  };
  return { render: rec<RenderJobActivitiesV1>({ ...base, ...overrides }) };
}
const renderInput = (n: number) => ({ ...tenant(1, `corr_replay_rj_${n}`), renderJobId: `rj_replay_${n}` });
const renderCase = (
  name: string,
  description: string,
  n: number,
  overrides: Partial<RenderJobActivitiesV1> = {},
): RecordingCase => ({
  workflowType: 'renderJobWorkflowV1',
  name,
  description,
  queue: 'render',
  activities: (rec) => renderJob(rec, overrides),
  args: [renderInput(n)],
  workflowId: `render:rj_replay_${n}`,
  state: 'completed',
});

// ---- videoIngestWorkflowV1 ----
const probe: MediaProbeV1 = {
  schemaVersion: 1,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs: 30_000,
  bitRate: 8_000_000,
  bytes: 30_000_000,
  video: {
    codec: 'h264',
    profile: 'High',
    pixelFormat: 'yuv420p',
    codedWidth: 1920,
    codedHeight: 1080,
    width: 1920,
    height: 1080,
    rotation: 0,
    fps: 30,
    nominalFps: 30,
    variableFrameRate: false,
    bitRate: 7_800_000,
  },
  audio: [{ codec: 'aac', channels: 2, sampleRate: 48_000, bitRate: 128_000 }],
};
function videoIngest(rec: Recorder, overrides: Partial<VideoIngestActivitiesV1> = {}) {
  const base: VideoIngestActivitiesV1 = {
    beginIngest: async (i) => ({
      intentId: i.intentId,
      brandId: i.brandId,
      kind: 'video',
      declaredMime: 'video/mp4',
      maxBytes: 1 << 30,
      storageKey: `${QUARANTINE}/${i.intentId}`,
    }),
    verifyUpload: async () => ({ ok: true, bytes: 30_000_000 }),
    sniffUpload: async () => ({ ok: true, mime: 'video/mp4', group: 'video' }),
    scanMediaUpload: async () => ({ ok: true, engine: 'replay-scanner' }),
    inspectMediaUpload: async (i) => ({
      ok: true,
      sourceKey: `${QUARANTINE}/${i.intentId}/stripped`,
      contentHash: hash('a'),
      bytes: 30_000_000,
      sanitised: true,
      probe,
    }),
    buildMediaDerivatives: async (i) => ({
      ok: true,
      derivatives: [
        {
          purpose: 'proxy',
          key: `${QUARANTINE}/${i.intentId}/derivative-proxy`,
          mime: 'video/mp4',
          width: 1280,
          height: 720,
          bytes: 9_000_000,
          contentHash: hash('b'),
          transform: { op: 'proxy' },
        },
      ],
      playedMs: 30_040,
    }),
    moveToImmutable: async (i) => ({
      assetId: 'ast_replay_v1',
      assetVersionId: 'av_replay_v1',
      originalKey: `${KEY}/ast_replay_v1/av_replay_v1/original`,
      derivatives: i.derivatives,
    }),
    catalogueMediaAsset: async () => ({
      assetId: 'ast_replay_v1',
      assetVersionId: 'av_replay_v1',
      state: 'pending_review',
    }),
    finaliseMediaUpload: async () => undefined,
  };
  return { video: rec<VideoIngestActivitiesV1>({ ...base, ...overrides }) };
}
const videoIngestCase = (
  name: string,
  description: string,
  n: number,
  overrides: Partial<VideoIngestActivitiesV1> = {},
): RecordingCase => ({
  workflowType: 'videoIngestWorkflowV1',
  name,
  description,
  queue: 'video',
  activities: (rec) => videoIngest(rec, overrides),
  args: [ingestInput(100 + n)],
  workflowId: `video-ingest:ui_replay_${100 + n}`,
  state: 'completed',
});

// ---- videoRenderJobWorkflowV1 ----
const videoResolved: VideoRenderResolveSuccess = {
  ok: true,
  rendererVersion: '1.0.0+video.1',
  brandVersionId: 'bv_replay_1',
  revisionContentHash: hash('c'),
  formatKey: 'video_16x9',
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 30_000,
  dedupeKey: hash('d'),
  reuse: null,
  sources: [],
  fonts: [],
  assets: [],
  manifest: {
    rendererVersion: '1.0.0+video.1',
    fonts: [],
    assets: [],
    brandVersionId: 'bv_replay_1',
    revisionContentHash: hash('c'),
  },
  tempBudgetBytes: 1 << 30,
  overlayFrameCount: 2,
  findings: [],
};
const composed: VideoComposeResult = {
  pageId: 'timeline',
  formatKey: 'video_16x9',
  storageKey: `${KEY}/exports/rev_replay_1/rjv/timeline-video_16x9.mp4`,
  contentHash: hash('e'),
  bytes: 9_000_000,
  width: 1920,
  height: 1080,
  durationMs: 30_000,
  fps: 30,
  posterStorageKey: `${KEY}/exports/rev_replay_1/rjv/timeline-video_16x9.poster.webp`,
  posterContentHash: hash('f'),
  encodeMs: 20_000,
};
type VideoCompose = 'ok' | 'hang' | 'too_large';
function videoRender(
  rec: Recorder,
  compose: VideoCompose = 'ok',
  resolve: Partial<VideoRenderResolveSuccess> = {},
) {
  const acts: VideoRenderJobActivitiesV1 = {
    beginVideoRender: async (i) => ({
      renderJobId: i.renderJobId,
      revisionId: 'rev_replay_1',
      documentId: 'doc_replay_1',
      brandId: 'brd_replay_1',
      formatKeys: ['video_16x9'],
    }),
    resolveVideoRender: async () => ({ ...videoResolved, ...resolve }),
    renderVideoOverlays: async () => ({ frames: [], findings: [] }),
    composeVideo: async () => {
      if (compose === 'too_large')
        throw nonRetryable('TempDiskBudgetExceededError', 'temp disk budget exceeded (replay fixture)');
      if (compose === 'hang') {
        // Heartbeat like ffmpeg progress until the cancellation is delivered through the heartbeat.
        const ctx = Context.current();
        for (;;) {
          ctx.heartbeat('encoding');
          await ctx.sleep(200);
        }
      }
      return composed;
    },
    storeVideoExport: async () => ({
      storageKey: composed.storageKey,
      contentHash: composed.contentHash,
      bytes: composed.bytes,
      durationMs: 30_000,
      fps: 30,
      posterStorageKey: composed.posterStorageKey,
    }),
    completeVideoRender: async () => ({ exportIds: ['exp_replay_v1'] }),
    failVideoRender: async () => undefined,
    discardVideoRenderWork: async () => ({ deleted: 2 }),
  };
  return { video: rec(acts) };
}
const videoRenderInput = (n: number) => ({
  ...tenant(1, `corr_replay_vr_${n}`),
  renderJobId: `rjv_replay_${n}`,
});
const videoRenderCase = (
  name: string,
  description: string,
  n: number,
  compose: VideoCompose,
  extra: Partial<RecordingCase> = {},
  resolve: Partial<VideoRenderResolveSuccess> = {},
): RecordingCase => ({
  workflowType: 'videoRenderJobWorkflowV1',
  name,
  description,
  queue: 'video',
  activities: (rec) => videoRender(rec, compose, resolve),
  args: [videoRenderInput(n)],
  workflowId: `video-render:rjv_replay_${n}`,
  state: 'completed',
  ...extra,
});

export const renderMediaCases: RecordingCase[] = [
  assetCase(
    'accepted',
    'All eight steps pass: verified, sniffed, scanned, sanitised, hashed, derived, moved, catalogued.',
    1,
  ),
  assetCase(
    'verify-retried-then-accepted',
    'The first verify fails transiently and is retried by the activity policy (2 s), then the upload is accepted.',
    2,
    () => {
      let attempts = 0;
      return {
        verifyUpload: async () => {
          if (attempts++ === 0) throw new Error('object store unavailable (replay fixture)');
          return { ok: true, bytes: 500_000 };
        },
      };
    },
  ),
  assetCase(
    'rejected-at-sniff',
    'Content sniffing disagrees with the declared type: rejected and cleaned up.',
    3,
    () => ({
      sniffUpload: async () => ({ ok: false, reason: 'declared_mime_mismatch' }),
    }),
  ),
  assetCase(
    'quarantined-scanner-unavailable',
    'The scanner stays unreachable: the upload stays quarantined, never accepted.',
    4,
    () => ({
      scanUpload: async () => {
        throw nonRetryable('ScannerUnavailableError', 'scanner unreachable (replay fixture)');
      },
    }),
  ),
  assetCase(
    'rejected-duplicate',
    'The content hash matches an existing asset: rejected as a duplicate of it.',
    5,
    () => ({
      hashUpload: async () => ({ ok: false, reason: 'duplicate_of', duplicateOfAssetId: 'ast_replay_0' }),
    }),
  ),
  renderCase('ready', 'Two formats rendered and stored in order, then completed as ready.', 1),
  renderCase(
    'resolve-rejected',
    'An input is no longer eligible: resolve refuses and the job fails with that reason.',
    2,
    {
      resolveRenderInputs: async () => ({
        ok: false,
        reason: 'rights_ineligible',
        detail: 'licence expired (replay fixture)',
      }),
    },
  ),
  renderCase(
    'render-failed',
    'The renderer fails non-retryably on the first format: the job fails as render_failed.',
    3,
    {
      renderFormat: async () => {
        throw nonRetryable('RenderIntegrityError', 'blank frame (replay fixture)');
      },
    },
  ),
  videoIngestCase('accepted', 'A video passes every step; the longer played duration is recorded.', 1),
  videoIngestCase('type-mismatch', 'The upload sniffs as an image: rejected as not video or audio.', 2, {
    sniffUpload: async () => ({ ok: true, mime: 'image/png', group: 'image' }),
  }),
  videoIngestCase(
    'quarantined-scanner-unavailable',
    'The stream scanner stays unreachable: quarantined.',
    3,
    {
      scanMediaUpload: async () => {
        throw nonRetryable('ScannerUnavailableError', 'scanner unreachable (replay fixture)');
      },
    },
  ),
  videoIngestCase(
    'rejected-at-inspect',
    'ffprobe finds an unsupported codec: rejected with that reason.',
    4,
    {
      inspectMediaUpload: async () => ({
        ok: false,
        reason: 'media_codec_unsupported',
        detail: 'prores (replay fixture)',
      }),
    },
  ),
  videoRenderCase('ready', 'Overlays, compose, store and complete: ready.', 1, 'ok'),
  videoRenderCase(
    'reused',
    'The same render exists: the export is reused without overlays or compose.',
    2,
    'ok',
    {},
    {
      reuse: {
        storageKey: composed.storageKey,
        contentHash: composed.contentHash,
        bytes: composed.bytes,
        width: 1920,
        height: 1080,
        durationMs: 30_000,
        fps: 30,
        posterStorageKey: composed.posterStorageKey,
      },
    },
  ),
  videoRenderCase(
    'cancelled-during-compose',
    'The cancel signal cancels the running compose (delivered through its heartbeat); the work is discarded and the run ends cancelled.',
    3,
    'hang',
    {
      drive: async (h, ctx) => {
        await ctx.untilCall('composeVideo');
        await h.signal('cancelRender');
      },
    },
  ),
  videoRenderCase(
    'too-large',
    'Compose exceeds the temp disk budget: the work is discarded and the job fails as too_large.',
    4,
    'too_large',
  ),
  {
    workflowType: 'videoRenderSignalRelayV1',
    name: 'relay-cancel',
    description: 'The outbox relays a cancel to a running render (external signal).',
    queue: 'video',
    activities: (rec) => videoRender(rec, 'hang'),
    before: async (ctx) => {
      await ctx.start('videoRenderJobWorkflowV1', [videoRenderInput(5)], 'video-render:rjv_replay_5');
      await ctx.untilCall('composeVideo');
    },
    args: [{ workflowId: 'video-render:rjv_replay_5', signal: 'cancelRender' }],
    workflowId: 'video-render-signal-replay-1',
    state: 'completed',
  },
  {
    workflowType: 'videoRenderSignalRelayV1',
    name: 'target-gone',
    description: 'The render is no longer running: the external signal fails and the relay completes anyway.',
    queue: 'video',
    activities: () => ({}),
    args: [{ workflowId: 'video-render:rjv_replay_404', signal: 'cancelRender' }],
    workflowId: 'video-render-signal-replay-2',
    state: 'completed',
  },
];
