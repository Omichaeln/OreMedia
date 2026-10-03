import type { VideoIngestActivitiesV1 } from '@oremedia/contracts/media';
import { policy } from '@oremedia/module-access';
import {
  ScannerUnavailableError,
  assetIngest,
  createScannerFromEnv,
  mediaIngest,
  storage,
  type MediaIngestDeps,
} from '@oremedia/module-assets';
import { loadActorGrants, resolveActivityActor } from './actor';
import { createAssetIngestActivities } from './asset-ingest';
import { heartbeat, inTenant } from './tenant';

/**
 * STU-2a activities for videoIngestWorkflowV1 (task queue `video`, worker-render). begin, verify, sniff and move are
 * the image ingest activities (same parameters, same implementation); scan, inspect and derivatives stream the
 * object (clamd INSTREAM, temp disk for ffprobe/ffmpeg) and heartbeat with their phase and progress, so a stalled
 * ffmpeg is noticed within the heartbeat timeout and the activity retried. Storage and scanner come from the
 * environment unless a worker passes its own (tests pass MemoryStorageProvider and FakeScanner).
 */
export function createVideoIngestActivities(
  overrides: Partial<Omit<MediaIngestDeps, 'onProgress'>> = {},
): VideoIngestActivitiesV1 {
  const shared = createAssetIngestActivities(overrides);
  let cached: Omit<MediaIngestDeps, 'onProgress'> | null = null;
  const deps = (): MediaIngestDeps => {
    if (!cached)
      cached = {
        storage: overrides.storage ?? storage(),
        scanner: overrides.scanner ?? createScannerFromEnv(),
        ...(overrides.tmpMaxBytes !== undefined ? { tmpMaxBytes: overrides.tmpMaxBytes } : {}),
        ...(overrides.proxyTimeoutMs !== undefined ? { proxyTimeoutMs: overrides.proxyTimeoutMs } : {}),
      };
    return {
      ...cached,
      onProgress: (phase, fraction) => heartbeat(`${phase}:${Math.round(fraction * 100)}%`),
    };
  };
  return {
    beginIngest: shared.beginIngest,
    verifyUpload: shared.verifyUpload,
    sniffUpload: shared.sniffUpload,
    moveToImmutable: shared.moveToImmutable,
    scanMediaUpload: (input) =>
      inTenant(input, loadActorGrants, async () => {
        heartbeat('scan');
        const r = await mediaIngest.scan(deps(), input);
        // No verdict is an infrastructure failure: thrown so Temporal retries; the workflow holds the intent.
        if (!r.ok && r.retryable) throw new ScannerUnavailableError(r.detail ?? r.reason);
        return r;
      }),
    inspectMediaUpload: (input) =>
      inTenant(input, loadActorGrants, () => {
        heartbeat('inspect');
        return mediaIngest.inspect(deps(), input);
      }),
    buildMediaDerivatives: (input) =>
      inTenant(input, loadActorGrants, () => {
        heartbeat('derivatives');
        return mediaIngest.derivatives(deps(), input);
      }),
    catalogueMediaAsset: (input) =>
      inTenant(input, loadActorGrants, async () => {
        // As for images: approved only if the uploader holds asset.approve now; decided here and passed explicitly.
        const { actor } = await resolveActivityActor(input);
        const decision = await policy.decide(actor, 'asset.approve', {
          type: 'brand',
          tenantId: input.tenantId,
          brandId: input.brandId,
          id: input.brandId,
        });
        return assetIngest.catalogue({ ...input, autoApprove: decision.allowed });
      }),
    finaliseMediaUpload: (input) =>
      inTenant(input, loadActorGrants, () => assetIngest.finalise(deps(), input)),
  };
}
