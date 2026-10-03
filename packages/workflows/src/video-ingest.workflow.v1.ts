import { proxyActivities } from '@temporalio/workflow';
import type {
  AssetIngestInputV1,
  AssetIngestResultV1,
  IngestStepRejection,
} from '@oremedia/contracts/assets';
import type { VideoIngestActivitiesV1 } from '@oremedia/contracts/media';
import { isFailureOfType } from './asset-ingest.workflow.v1';

/**
 * STU-2a: complete(intentId) of a video or audio upload → videoIngestWorkflowV1 on task queue `video` (worker-render,
 * ffmpeg 6.1 + ffprobe). Same shape as assetIngestWorkflowV1 (verify, sniff, scan, then the media steps, move,
 * catalogue, finalise); a rejected step is a value that ends the run through finaliseMediaUpload with its reason and
 * a user-safe detail. The original is stored as uploaded (nothing is re-encoded); the derivatives are the poster,
 * thumbnail strip, editing proxy and waveform. Once deployed this file is immutable; changes ship as v2.
 */

/** Domain errors that no retry can fix (a foreign id, a lost permission, an illegal state). */
const NON_RETRYABLE_ERROR_TYPES = [
  'PolicyDeniedError',
  'NotFoundError',
  'ValidationFailedError',
  'ConflictError',
  'TenantContextMissingError',
  'IllegalTransitionError',
  'TempDiskBudgetExceededError',
];

/** The orchestration, separated from the activity proxies so it can be exercised with fakes. */
export async function runVideoIngest(
  acts: VideoIngestActivitiesV1,
  input: AssetIngestInputV1,
): Promise<AssetIngestResultV1> {
  const begin = await acts.beginIngest(input);
  const cleanupKeys: string[] = [begin.storageKey];

  const finish = async (
    rejection: IngestStepRejection,
    outcome: 'rejected' | 'quarantined',
  ): Promise<AssetIngestResultV1> => {
    await acts.finaliseMediaUpload({
      ...input,
      outcome,
      reason: rejection.reason,
      ...(rejection.detail ? { detail: rejection.detail } : {}),
      ...(rejection.duplicateOfAssetId ? { duplicateOfAssetId: rejection.duplicateOfAssetId } : {}),
      cleanupKeys,
    });
    if (outcome === 'quarantined') return { outcome, reason: rejection.reason };
    return {
      outcome,
      reason: rejection.reason,
      ...(rejection.duplicateOfAssetId ? { duplicateOfAssetId: rejection.duplicateOfAssetId } : {}),
    };
  };

  const verified = await acts.verifyUpload(input); // 1. exists, size ≤ cap
  if (!verified.ok) return finish(verified, 'rejected');

  const sniffed = await acts.sniffUpload(input); // 2. content sniffing is authoritative
  if (!sniffed.ok) return finish(sniffed, 'rejected');
  if (sniffed.group !== 'video' && sniffed.group !== 'audio')
    return finish(
      { ok: false, reason: 'type_mismatch', detail: `${sniffed.group} is not video or audio` },
      'rejected',
    );
  const group = sniffed.group;

  let scanned; // 3. scan the stream; no verdict → stays quarantined, never accepted
  try {
    scanned = await acts.scanMediaUpload(input);
  } catch (err) {
    if (isFailureOfType(err, 'ScannerUnavailableError'))
      return finish({ ok: false, reason: 'scanner_unavailable' }, 'quarantined');
    throw err;
  }
  if (!scanned.ok)
    return finish(scanned, scanned.reason === 'scanner_unavailable' ? 'quarantined' : 'rejected');

  // 4–5. ffprobe inspection against the limits, a decode check, the content hash and the dedupe proposal
  const inspected = await acts.inspectMediaUpload({ ...input, mime: sniffed.mime, group });
  if (!inspected.ok) return finish(inspected, 'rejected');

  // 6. poster, thumbnail strip, editing proxy, waveform
  const built = await acts.buildMediaDerivatives({
    ...input,
    mime: sniffed.mime,
    group,
    probe: inspected.probe,
  });
  if (!built.ok) return finish(built, 'rejected');
  cleanupKeys.push(...built.derivatives.map((d) => d.key));

  // 7. the upload itself is the original (stored as uploaded); derivatives go to their immutable keys
  const moved = await acts.moveToImmutable({
    ...input,
    sanitisedKey: begin.storageKey,
    derivatives: built.derivatives,
  });

  const probe = inspected.probe;
  const catalogued = await acts.catalogueMediaAsset({
    ...input,
    assetId: moved.assetId,
    assetVersionId: moved.assetVersionId,
    originalKey: moved.originalKey,
    contentHash: inspected.contentHash,
    mime: sniffed.mime,
    bytes: verified.bytes,
    width: probe.video?.width ?? null,
    height: probe.video?.height ?? null,
    colourProfile: null,
    sanitised: false,
    derivatives: moved.derivatives,
    probe,
  }); // 8

  await acts.finaliseMediaUpload({ ...input, outcome: 'accepted', cleanupKeys });
  return {
    outcome: 'accepted',
    assetId: catalogued.assetId,
    assetVersionId: catalogued.assetVersionId,
    state: catalogued.state,
  };
}

export async function videoIngestWorkflowV1(input: AssetIngestInputV1): Promise<AssetIngestResultV1> {
  const fast = proxyActivities<VideoIngestActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '2s',
      maximumInterval: '1 minute',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  // Scanning and inspecting stream up to 1 GiB (clamd, temp disk); they heartbeat as bytes move.
  const streaming = proxyActivities<VideoIngestActivitiesV1>({
    startToCloseTimeout: '20 minutes',
    heartbeatTimeout: '2 minutes',
    retry: {
      initialInterval: '10s',
      maximumInterval: '2 minutes',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  // Derivatives transcode a source of up to 10 minutes (the proxy dominates); ffmpeg progress heartbeats.
  const transcode = proxyActivities<VideoIngestActivitiesV1>({
    startToCloseTimeout: '45 minutes',
    heartbeatTimeout: '2 minutes',
    retry: {
      initialInterval: '30s',
      maximumInterval: '5 minutes',
      maximumAttempts: 3,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  // Moving copies objects of up to 1 GiB server side (CopyObject).
  const move = proxyActivities<VideoIngestActivitiesV1>({
    startToCloseTimeout: '10 minutes',
    retry: {
      initialInterval: '5s',
      maximumInterval: '1 minute',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  return runVideoIngest(
    {
      beginIngest: fast.beginIngest,
      verifyUpload: fast.verifyUpload,
      sniffUpload: fast.sniffUpload,
      scanMediaUpload: streaming.scanMediaUpload,
      inspectMediaUpload: streaming.inspectMediaUpload,
      buildMediaDerivatives: transcode.buildMediaDerivatives,
      moveToImmutable: move.moveToImmutable,
      catalogueMediaAsset: fast.catalogueMediaAsset,
      finaliseMediaUpload: fast.finaliseMediaUpload,
    },
    input,
  );
}
