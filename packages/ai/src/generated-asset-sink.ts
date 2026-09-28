import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { withTransaction } from '@oremedia/db';
import { assetService } from '@oremedia/module-assets';

type GeneratedUpload = Parameters<typeof assetService.uploadGenerated>[1];

/** The asset-module surface a generator needs; a narrow seam so unit tests supply a fake without a database. */
export interface GeneratedAssetSink {
  /** Commits on its own: a retried tool call must find the uploads even when the tool's unit of work rolls back. */
  upload(
    actor: ResolvedActor,
    input: GeneratedUpload,
    opts: { autonomyMode: AutonomyMode },
  ): Promise<{ intentId: string }>;
  status: typeof assetService.generatedUploadStatus;
}

export const generatedAssetSink: GeneratedAssetSink = {
  upload: (actor, input, opts) =>
    withTransaction((tx) => assetService.uploadGenerated(actor, input, tx, opts)),
  status: (intentIds, tx) => assetService.generatedUploadStatus(intentIds, tx),
};
