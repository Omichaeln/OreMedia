import {
  MEDIA_DURATION_CAPS_SECONDS,
  PERSON_MEDIA_LIMITS,
  type AssetIngestInputV1,
  type IngestDerivativeRef,
  type IngestScanResult,
  type IngestStepRejection,
  type IngestStepResult,
} from '@oremedia/contracts/assets';
import type {
  IngestMediaDerivativesInput,
  IngestMediaDerivativesResult,
  IngestMediaInspectInput,
  IngestMediaInspectResult,
} from '@oremedia/contracts/media';
import { requireTenant } from '@oremedia/db';
import { AssetVersionRepository, GeneratedUploadRepository } from '../repositories';
import { storageKeys } from '../storage';
import { TempDiskBudgetExceededError, withTempDir } from '../temp-disk';
import { loadIntent, type IngestDeps } from './pipeline';
import { ScannerUnavailableError } from './scanner';
import { buildMediaDerivatives, checkProbe, decodeCheck, probeFile } from './video';

/**
 * STU-2a: the storage-and-database side of the video ingest steps (videoIngestWorkflowV1), one function per activity,
 * beside the image pipeline (pipeline.ts). Each step re-loads the intent through the brand-scoped repository, streams
 * the quarantined object (to clamd, or to a private temp directory for ffprobe/ffmpeg) and never holds it in memory.
 * Temp directories are removed whatever happens (withTempDir).
 */
export interface MediaIngestDeps extends IngestDeps {
  /** Temp disk budget per job; default the upload cap plus 1.5 GiB (source + proxy + frames). */
  tmpMaxBytes?: number;
  /** Ceiling on the proxy transcode; default 30 minutes (a 10-minute 1080p source on one vCPU). */
  proxyTimeoutMs?: number;
  /** Progress for heartbeats: a phase and a fraction of the step. */
  onProgress?: (phase: string, fraction: number) => void;
}

const versionsRepo = new AssetVersionRepository();
const generatedRepo = new GeneratedUploadRepository();

const TMP_HEADROOM = 1536 * 1024 * 1024;

/** A job that outgrows its temp disk budget is a rejection the uploader sees, not an endless retry. */
async function withinBudget<R>(work: () => Promise<R>): Promise<R | IngestStepRejection> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof TempDiskBudgetExceededError)
      return {
        ok: false,
        reason: 'media_processing_failed',
        detail: 'the file needs more working space than one upload may use; upload a shorter or smaller file',
      };
    throw err;
  }
}
const mediaGroup = (group: string): 'video' | 'audio' => (group === 'audio' ? 'audio' : 'video');

/** Generated media keeps its generated caps (ADR-11); a person's upload has the Studio v1 limits. */
async function durationCapSeconds(intentId: string, group: 'video' | 'audio'): Promise<number> {
  const generated = await generatedRepo.findById(intentId);
  return generated?.provenance.kind === 'generated'
    ? MEDIA_DURATION_CAPS_SECONDS[group]
    : PERSON_MEDIA_LIMITS.durationSeconds[group];
}

export const mediaIngest = {
  /** Step 3 over a stream: clamd INSTREAM reads the object as it arrives. No verdict is retryable (quarantine). */
  async scan(deps: MediaIngestDeps, input: AssetIngestInputV1): Promise<IngestStepResult<IngestScanResult>> {
    const intent = await loadIntent(input, 'quarantined');
    const progress = (bytes: number) => deps.onProgress?.('scan', Math.min(1, bytes / intent.maxBytes));
    try {
      let verdict;
      if (deps.scanner.scanStream) {
        const stream = await deps.storage.getObjectStream(intent.storageKey);
        if (!stream) return { ok: false, reason: 'object_missing' };
        verdict = await deps.scanner.scanStream(stream, progress);
      } else {
        // A scanner without stream support (test doubles) gets the bytes.
        const bytes = await deps.storage.getObject(intent.storageKey);
        if (!bytes) return { ok: false, reason: 'object_missing' };
        verdict = await deps.scanner.scan(bytes);
      }
      if (!verdict.clean) return { ok: false, reason: 'malware_detected', detail: verdict.signature };
      return { ok: true, engine: verdict.engine };
    } catch (err) {
      if (err instanceof ScannerUnavailableError)
        return { ok: false, reason: 'scanner_unavailable', retryable: true, detail: err.message };
      throw err;
    }
  },

  /**
   * Streams the source to temp disk (hashing it on the way), runs ffprobe, checks the limits, decodes the first
   * seconds, and proposes a duplicate when the brand already holds the same bytes.
   */
  async inspect(
    deps: MediaIngestDeps,
    input: IngestMediaInspectInput,
  ): Promise<IngestStepResult<IngestMediaInspectResult>> {
    const intent = await loadIntent(input, 'quarantined');
    const group = mediaGroup(input.group);
    const maxDurationSeconds = await durationCapSeconds(intent.id, group);
    return withinBudget<IngestStepResult<IngestMediaInspectResult>>(() =>
      withTempDir({ maxBytes: intent.maxBytes + 64 * 1024 * 1024 }, async (dir) => {
        const source = await dir.download(deps.storage, intent.storageKey, 'source', {
          onProgress: (bytes) => deps.onProgress?.('download', Math.min(1, bytes / intent.maxBytes)),
        });
        if (!source) return { ok: false, reason: 'object_missing' };
        const probe = await probeFile(source.path, source.bytes);
        if ('ok' in probe) return probe;
        const refused = checkProbe(probe, group, { maxDurationSeconds });
        if (refused) return refused;
        const undecodable = await decodeCheck(source.path, group);
        if (undecodable) return undecodable;
        const existing = await versionsRepo.findLiveByHash(intent.brandId, source.contentHash, null);
        if (existing)
          return {
            ok: false,
            reason: 'duplicate_of',
            duplicateOfAssetId: existing.assetId,
            detail: 'identical content already exists in this brand',
          };
        return { ok: true, contentHash: source.contentHash, probe };
      }),
    );
  },

  /**
   * Poster, thumbnail strip, editing proxy and waveform, written back under the intent's quarantine prefix with their
   * content hashes (move copies them to their immutable keys, as for images).
   */
  async derivatives(
    deps: MediaIngestDeps,
    input: IngestMediaDerivativesInput,
  ): Promise<IngestStepResult<IngestMediaDerivativesResult>> {
    const intent = await loadIntent(input, 'quarantined');
    const group = mediaGroup(input.group);
    const { tenantId } = requireTenant();
    return withinBudget<IngestStepResult<IngestMediaDerivativesResult>>(() =>
      withTempDir({ maxBytes: deps.tmpMaxBytes ?? intent.maxBytes + TMP_HEADROOM }, async (dir) => {
        const source = await dir.download(deps.storage, intent.storageKey, 'source');
        if (!source) return { ok: false, reason: 'object_missing' };
        const built = await buildMediaDerivatives(
          dir,
          source.path,
          input.probe,
          group,
          { maxDurationSeconds: Math.ceil(input.probe.durationMs / 1000) },
          {
            ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
            ...(deps.proxyTimeoutMs ? { proxyTimeoutMs: deps.proxyTimeoutMs } : {}),
          },
        );
        if (!built.ok) return built;
        const refs: IngestDerivativeRef[] = [];
        for (const f of built.files) {
          const key = storageKeys.quarantine(tenantId, intent.id, `derivative-${f.purpose}`);
          const stored = await dir.upload(deps.storage, key, f.name, f.mime);
          refs.push({
            purpose: f.purpose,
            key,
            mime: f.mime,
            width: f.width,
            height: f.height,
            bytes: stored.bytes,
            contentHash: stored.contentHash,
            transform: f.transform,
          });
        }
        return { ok: true, derivatives: refs };
      }),
    );
  },
};
