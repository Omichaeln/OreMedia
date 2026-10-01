import type {
  DestinationRefreshInputV1,
  DestinationRefreshResultV1,
  DestinationRefreshRuntimeV1,
  DestinationTokenRefreshInputV1,
} from '@oremedia/contracts/destinations';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { requireTenant, runAsPlatform, withTransaction } from '@oremedia/db';
import { MemoryRateLimiterStore, audit, type RateLimiterStore } from '@oremedia/module-operations';
import { aadFor, credentialBroker, providerClientFor } from '@oremedia/module-publishing';
import { logger } from '@oremedia/observability';
import { BrandDestinationRepository, DestinationRefreshDueRepository } from './repositories';
import { sourceAdapterFor, sourceIO } from './sources';

const destinationsRepo = new BrandDestinationRepository();
const dueRepo = new DestinationRefreshDueRepository();
const REFRESH_LOCK_SECONDS = 60;
/** The platform job the due listing declares (spec 5.3); references only leave it. */
const REFRESH_JOB = 'destination-token-refresh';

export interface DestinationRuntimeOptions {
  now?: () => Date;
  /** Per-destination refresh lock (Redis-backed in production; memory by default). */
  refreshLock?: RateLimiterStore;
}

export interface DestinationRuntime {
  refresh: DestinationRefreshRuntimeV1;
}

/**
 * The runtime behind destinationTokenRefreshWorkflowV1 (ledger R2-1; worker-core, the process whose KMS may
 * decrypt): the destinations due for refresh across tenants, and one refresh under a per-destination lock, modelled
 * on the channel token refresh (packages/modules/publishing/src/runtime.ts). A refreshed grant becomes a new
 * credential row and the old one is destroyed; a revoked grant leaves the destination `unreachable` with an audit
 * record, a transient failure leaves it as it was for the next run.
 */
export function createDestinationRuntime(opts: DestinationRuntimeOptions = {}): DestinationRuntime {
  const now = opts.now ?? (() => new Date());
  const refreshLock = opts.refreshLock ?? new MemoryRateLimiterStore();
  const log = logger().child('destinations');
  const workflowActor = () => requireTenant().actor;

  const refresh: DestinationRefreshRuntimeV1 = {
    listDueDestinationRefreshes: ({ correlationId, now: at, withinHours }: DestinationTokenRefreshInputV1) =>
      runAsPlatform(REFRESH_JOB, correlationId, () =>
        dueRepo.listDue(new Date(Date.parse(at) + withinHours * 3_600_000)),
      ),

    async refreshDestinationCredential({
      tenantId,
      destinationId,
    }: DestinationRefreshInputV1): Promise<DestinationRefreshResultV1> {
      const lock = await refreshLock.hit(
        `lock:${REFRESH_JOB}:${tenantId}:${destinationId}`,
        REFRESH_LOCK_SECONDS,
      );
      if (lock.count > 1) return { ok: false, reason: 'locked' };
      const row = await destinationsRepo.getById(destinationId);
      if (row.status !== 'active' || !row.credentialRefId) return { ok: false, reason: 'not_active' };
      const adapter = sourceAdapterFor(row.kind);
      const credentialRefId = row.credentialRefId;
      let refreshed: Awaited<ReturnType<typeof adapter.refresh>>;
      try {
        refreshed = await credentialBroker.withCredentialRef(
          { tenantId, credentialRefId, aad: aadFor(tenantId, row.id) },
          (creds) => adapter.refresh(creds, providerClientFor(adapter.key), sourceIO(adapter.key, tenantId)),
        );
      } catch (err) {
        refreshed =
          err instanceof PolicyDeniedError && err.reason === 'credential_destroyed'
            ? { ok: false, reason: 'reconnect_required' }
            : { ok: false, reason: 'transient' };
        // Name and code only (as provider-io logs): a token endpoint error message can carry a URL with secrets.
        if (refreshed.reason === 'transient')
          log.warn(
            { destinationId, errorName: (err as Error)?.name, errorCode: (err as { code?: string })?.code },
            'destination token refresh failed',
          );
      }
      return withTransaction(async (tx) => {
        const locked = await destinationsRepo.lock(row.id, tx);
        if (locked.status !== 'active' || locked.credentialRefId !== credentialRefId)
          return { ok: false, reason: 'not_active' }; // disconnected or rotated meanwhile
        if (refreshed.ok) {
          const sealed = await credentialBroker.seal(tenantId, locked.id, refreshed.credentials);
          const nextRef = await credentialBroker.createCredentialRef(sealed, tx);
          const tokenExpiresAt = refreshed.tokenExpiresAt ? new Date(refreshed.tokenExpiresAt) : null;
          await destinationsRepo.update(
            locked.id,
            locked.version,
            { credentialRefId: nextRef, tokenExpiresAt, health: 'healthy', healthCheckedAt: now() },
            tx,
          );
          await credentialBroker.destroyCredentialRef(credentialRefId, 'rotated', tx);
          await audit.record(
            workflowActor(),
            'destination.token_refresh',
            { type: 'brand_destination', id: locked.id },
            'allowed',
            tx,
            { brandId: locked.brandId, kind: locked.kind, fromState: locked.health, toState: 'healthy' },
          );
          return { ok: true, tokenExpiresAt: tokenExpiresAt ? tokenExpiresAt.toISOString() : null };
        }
        // A revoked grant cannot be read until a person connects again: the destination is unreachable.
        if (refreshed.reason === 'reconnect_required' && locked.health !== 'unreachable')
          await destinationsRepo.update(
            locked.id,
            locked.version,
            { health: 'unreachable', healthCheckedAt: now() },
            tx,
          );
        await audit.record(
          workflowActor(),
          'destination.token_refresh',
          { type: 'brand_destination', id: locked.id },
          'denied',
          tx,
          {
            brandId: locked.brandId,
            kind: locked.kind,
            fromState: locked.health,
            toState: refreshed.reason === 'reconnect_required' ? 'unreachable' : locked.health,
            reason: refreshed.reason,
          },
        );
        return { ok: false, reason: refreshed.reason };
      });
    },
  };

  return { refresh };
}
