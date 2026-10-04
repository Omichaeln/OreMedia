import type {
  DeletionRuntimeV1,
  IdempotencyKeyPurgeRuntimeV1,
  RetentionRuntimeV1,
} from '@oremedia/contracts/operations';
import { requireTenant, runAsPlatform, withTransaction } from '@oremedia/db';
import { logger } from '@oremedia/observability';
import { deletion } from './deletion';
import { IDEMPOTENCY_PURGE_BATCH, IdempotencyKeyPurgeRepository } from './idempotent';
import { retention } from './retention';

const purgeRepo = new IdempotencyKeyPurgeRepository();

/**
 * The runtime behind deletionRequestWorkflowV1, retentionSweepWorkflowV1 (spec 17.5) and
 * idempotencyKeyPurgeWorkflowV1 (spec 7.3), task queue `core`. The activity host establishes the tenant context of
 * the first two; each step is one transaction, so a handler's rows and its fan-out entry commit together and a
 * retried step finds its entry done. The purge is platform-level and declares its platform job itself.
 */
export function createOperationsRuntime(): {
  deletion: DeletionRuntimeV1;
  retention: RetentionRuntimeV1;
  idempotencyPurge: IdempotencyKeyPurgeRuntimeV1;
} {
  const actor = () => requireTenant().actor;
  return {
    deletion: {
      beginDeletion: (input) => withTransaction((tx) => deletion.begin(actor(), input.deletionRequestId, tx)),
      runDeletionHandler: (input) =>
        withTransaction((tx) => deletion.runHandler(actor(), input.deletionRequestId, input.handler, tx)),
      finishDeletion: (input) =>
        withTransaction((tx) => deletion.finish(actor(), input.deletionRequestId, tx)),
    },
    retention: {
      listRetentionTenants: (input) => retention.tenants(input.correlationId),
      applyRetention: async (input) => ({
        tenantId: input.tenantId,
        dryRun: input.dryRun,
        classes: await withTransaction((tx) =>
          retention.apply(actor(), new Date(input.now), input.dryRun, tx),
        ),
      }),
    },
    idempotencyPurge: {
      /** Expired idempotency records (replay caches, some holding a response), across tenants in bounded batches. */
      async purgeExpiredIdempotencyKeys(input) {
        const at = new Date(input.now);
        let rows = 0;
        for (;;) {
          const batch = await runAsPlatform('idempotency-key-purge', input.correlationId, () =>
            withTransaction((tx) => purgeRepo.purgeExpired(at, tx)),
          );
          rows += batch;
          if (batch < IDEMPOTENCY_PURGE_BATCH) break;
        }
        if (rows > 0) logger().info({ count: rows }, 'expired idempotency records purged');
        return { rows };
      },
    },
  };
}
