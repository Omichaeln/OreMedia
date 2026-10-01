import type {
  DestinationHealth,
  DestinationRefreshInputV1,
  DestinationRefreshResultV1,
  DestinationRefreshRuntimeV1,
  DestinationReportsRuntimeV1,
  DestinationTokenRefreshInputV1,
  DestinationVerifyInputV1,
  DestinationVerifyResultV1,
  DestinationVerifyRuntimeV1,
} from '@oremedia/contracts/destinations';
import type { SeoAuditRuntimeV1 } from '@oremedia/contracts/seo-audit';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { requireTenant, runAsPlatform, withTransaction } from '@oremedia/db';
import { MemoryRateLimiterStore, audit, type RateLimiterStore } from '@oremedia/module-operations';
import { aadFor, credentialBroker, providerClientFor } from '@oremedia/module-publishing';
import { logger } from '@oremedia/observability';
import { cmsIO } from './cms';
import { createSeoAuditRuntime } from './audit-runtime';
import { createDestinationReportRuntime } from './report-runtime';
import { BrandDestinationRepository, DestinationRefreshDueRepository } from './repositories';
import { StoredKind, enabledCmsAdapter } from './service';
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
  /** Per-destination report-run lock (R2-1 part B; the same store in production). */
  reportLock?: RateLimiterStore;
  /** Per-destination audit-run lock (R2-4; the same store in production). */
  auditLock?: RateLimiterStore;
}

export interface DestinationRuntime {
  refresh: DestinationRefreshRuntimeV1;
  /** R2-1 part B (worker-ingest): the report sweep's activities, refreshing a dead token through `refresh`. */
  reports: DestinationReportsRuntimeV1;
  /** R2-3 (worker-core): destinationVerifyWorkflowV1, the health check of a destination connected with a secret. */
  verify: DestinationVerifyRuntimeV1;
  /** R2-4 (worker-ingest): the weekly audit sweep's and an on-demand audit's activities. */
  audit: SeoAuditRuntimeV1;
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

  const verify: DestinationVerifyRuntimeV1 = {
    /**
     * R2-3: opens the sealed secret here (the API never can), asks the adapter to verify it against the site and
     * records the health found: healthy, unreachable when the site refuses the identity (a person reconnects),
     * degraded when the site could not be reached (the next verification or write tries again). Under the same
     * per-destination lock as a refresh; audited either way.
     */
    async verifyDestinationCredential({
      tenantId,
      destinationId,
    }: DestinationVerifyInputV1): Promise<DestinationVerifyResultV1> {
      const lock = await refreshLock.hit(
        `lock:destination-verify:${tenantId}:${destinationId}`,
        REFRESH_LOCK_SECONDS,
      );
      if (lock.count > 1) return { ok: false, reason: 'locked' };
      const row = await destinationsRepo.getById(destinationId);
      if (row.status !== 'active') return { ok: false, reason: 'not_active' };
      if (!row.credentialRefId) return { ok: false, reason: 'no_credential' };
      const adapter = enabledCmsAdapter(StoredKind.parse(row.kind));
      const credentialRefId = row.credentialRefId;
      let verified: Awaited<ReturnType<typeof adapter.verify>>;
      try {
        verified = await credentialBroker.withCredentialRef(
          { tenantId, credentialRefId, aad: aadFor(tenantId, row.id) },
          (creds) =>
            adapter.verify(
              { siteUrl: row.externalId, username: creds.extra?.['username'] ?? '' },
              creds,
              cmsIO(adapter.key, tenantId),
            ),
        );
      } catch (err) {
        verified =
          err instanceof PolicyDeniedError && err.reason === 'credential_destroyed'
            ? { ok: false, reason: 'reconnect_required', detail: 'credential destroyed' }
            : { ok: false, reason: 'transient', detail: (err as Error)?.name ?? 'error' };
        if (verified.reason === 'transient')
          log.warn(
            { destinationId, errorName: (err as Error)?.name, errorCode: (err as { code?: string })?.code },
            'destination verification failed',
          );
      }
      const health: DestinationHealth = verified.ok
        ? 'healthy'
        : verified.reason === 'transient'
          ? 'degraded'
          : 'unreachable';
      return withTransaction(async (tx) => {
        const locked = await destinationsRepo.lock(row.id, tx);
        if (locked.status !== 'active' || locked.credentialRefId !== credentialRefId)
          return { ok: false, reason: 'not_active' }; // disconnected or reconnected meanwhile
        await destinationsRepo.update(locked.id, locked.version, { health, healthCheckedAt: now() }, tx);
        await audit.record(
          workflowActor(),
          'destination.verify',
          { type: 'brand_destination', id: locked.id },
          verified.ok ? 'allowed' : 'denied',
          tx,
          {
            brandId: locked.brandId,
            kind: locked.kind,
            fromState: locked.health,
            toState: health,
            reason: verified.ok ? null : verified.reason,
          },
        );
        return verified.ok
          ? { ok: true, health }
          : { ok: false, reason: verified.reason === 'rejected' ? 'reconnect_required' : verified.reason };
      });
    },
  };

  return {
    refresh,
    reports: createDestinationReportRuntime(refresh, {
      now,
      ...(opts.reportLock ? { reportLock: opts.reportLock } : {}),
    }),
    verify,
    audit: createSeoAuditRuntime({ now, ...(opts.auditLock ? { auditLock: opts.auditLock } : {}) }),
  };
}
