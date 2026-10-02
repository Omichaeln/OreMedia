import { CMS_AUDIT_DATA_TYPE, SEO_AUDIT_DESTINATION_KIND } from '@oremedia/contracts/seo-audit';
import { requireTenant, type Tx } from '@oremedia/db';
import { audit } from '@oremedia/module-operations';
import { credentialBroker } from '@oremedia/module-publishing';
import { seoAuditRunsToPrune } from './audit-runtime';
import { reportRetention } from './report-runtime';
import {
  BrandDestinationRepository,
  DestinationReportRowRepository,
  SeoAuditPageRepository,
  SeoAuditRunRepository,
} from './repositories';

const destinationsRepo = new BrandDestinationRepository();
const rowsRepo = new DestinationReportRowRepository();
const runsRepo = new SeoAuditRunRepository();
const pagesRepo = new SeoAuditPageRepository();
/** Destinations read per statement while the tenant's are walked. */
const WALK_PAGE = 200;

/** Every destination of the current tenant, in id order, whatever its brand, status, kind or credential. */
async function eachDestination(
  tx: Tx,
  fn: (row: Awaited<ReturnType<BrandDestinationRepository['listForTenant']>>[number]) => Promise<void>,
): Promise<void> {
  for (let after: string | null = null; ;) {
    const rows = await destinationsRepo.listForTenant(after, WALK_PAGE, tx);
    for (const row of rows) await fn(row);
    const last = rows[rows.length - 1];
    if (rows.length < WALK_PAGE || !last) return;
    after = last.id;
  }
}

/**
 * The destinations module's TTL handlers for the platform retention sweep (retentionSweepWorkflowV1, spec 17.5),
 * registered by worker-core under the `source_use_policy` class: each destination's retention is its brand's
 * source-use policy (D-17: the policy's retentionDays with `retain`, else the operational cache of report rows or
 * the keep rule of audit runs), the same rule the report and audit runs prune by. The sweep applies it on its own
 * clock, whether or not the destination is still connected, holds a credential, its kind is enabled or certified
 * for reads, or its last fetch succeeded: no provider is called to expire local rows. Dry run counts only.
 */
/** RA-01: a disconnected destination's credential the remote revoke has not shredded within this long is shredded here. */
export const DISCONNECT_SHRED_FLOOR_MS = 60 * 60_000;

export const destinationRetention = {
  /**
   * RA-01, the floor under the remote revoke: the credential a disconnect left to destinationRevokeWorkflowV1
   * that is still intact an hour later (the worker was down, the event dead-lettered) is shredded here, audited.
   * Counts only in a dry run.
   */
  async shredDisconnectedCredentials(now: Date, dryRun: boolean, tx: Tx): Promise<number> {
    const { actor } = requireTenant();
    const before = new Date(now.getTime() - DISCONNECT_SHRED_FLOOR_MS);
    let total = 0;
    await eachDestination(tx, async (row) => {
      if (
        row.status !== 'disconnected' ||
        !row.credentialRefId ||
        row.updatedAt.getTime() >= before.getTime()
      )
        return;
      if (!(await credentialBroker.credentialRefIntact(row.credentialRefId, tx))) return;
      total += 1;
      if (dryRun) return;
      await credentialBroker.destroyCredentialRef(row.credentialRefId, 'disconnected', tx);
      await audit.record(
        actor,
        'destination.credential_shredded',
        { type: 'brand_destination', id: row.id },
        'allowed',
        tx,
        { brandId: row.brandId, kind: row.kind, reason: 'disconnect_shred_floor' },
      );
    });
    return total;
  },

  /** Report rows of days before each destination's cut-off; returns the rows removed (or counted). */
  async pruneReports(now: Date, dryRun: boolean, tx: Tx): Promise<number> {
    const { actor } = requireTenant();
    let total = 0;
    await eachDestination(tx, async (row) => {
      const { days, cutoff, dataType } = await reportRetention(row, now, tx);
      if (dryRun) {
        total += await rowsRepo.countBefore(row.brandId, row.id, cutoff, tx);
        return;
      }
      const n = await rowsRepo.deleteBefore(row.brandId, row.id, cutoff, tx);
      total += n;
      if (n > 0)
        await audit.record(
          actor,
          'destination.report.pruned',
          { type: 'brand_destination', id: row.id },
          'allowed',
          tx,
          {
            brandId: row.brandId,
            kind: row.kind,
            count: n,
            scope: dataType,
            reason: `cutoff=${cutoff},retentionDays=${days}`,
          },
        );
    });
    return total;
  },

  /** Audit runs (with their pages) past each website destination's retention; returns the runs removed (or counted). */
  async pruneSeoAudits(now: Date, dryRun: boolean, tx: Tx): Promise<number> {
    const { actor } = requireTenant();
    let total = 0;
    await eachDestination(tx, async (row) => {
      if (row.kind !== SEO_AUDIT_DESTINATION_KIND) return;
      const { ids, reason } = await seoAuditRunsToPrune(row, now, tx);
      if (dryRun) {
        total += ids.length;
        return;
      }
      await pagesRepo.deleteForRuns(row.brandId, ids, tx);
      const n = await runsRepo.deleteRuns(row.brandId, ids, tx);
      total += n;
      if (n > 0)
        await audit.record(
          actor,
          'seo_audit.pruned',
          { type: 'brand_destination', id: row.id },
          'allowed',
          tx,
          { brandId: row.brandId, kind: row.kind, count: n, scope: CMS_AUDIT_DATA_TYPE, reason },
        );
    });
    return total;
  },
};
