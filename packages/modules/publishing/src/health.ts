import type { ChannelHealth } from '@oremedia/contracts/providers';
import { NotFoundError } from '@oremedia/contracts/errors';
import { requireTenant, withTransaction } from '@oremedia/db';
import { audit } from '@oremedia/module-operations';
import { healthFromReadFailure } from './common';
import { ChannelConnectionRepository } from './repositories';

const connectionsRepo = new ChannelConnectionRepository();

/** A health that did not change is re-stamped (`health_checked_at`) at most this often: pulls run per post. */
export const HEALTH_RESTAMP_MS = 60 * 60_000;

/**
 * RA-01: the one writer of a channel connection's health outside the refresh workflow (which writes it under its
 * own lock with the status). The comment and metrics pulls (worker-ingest) report what the platform answered;
 * generic code maps the adapter's classification (common.ts) and records it here: under the row lock, audited
 * when it changes (`channel.health`, as `destination.health` is), never on a disconnected connection, and a
 * connection that no longer exists is left alone (a pull may outlive it).
 */
export const channelHealth = {
  /**
   * `now` is when the read happened: a stamp older than the row's `health_checked_at` is ignored (a slow pull
   * finishing after a newer one, or after the refresh workflow wrote), so a stale ok never overwrites a newer fact.
   * Only an active or refresh_needed connection is written: a reconnect_needed row's `revoked` came from the
   * refresh workflow and stands until a person reconnects; a disabled row is out of scope.
   */
  async record(channelConnectionId: string, health: ChannelHealth, now = new Date()): Promise<void> {
    await withTransaction(async (tx) => {
      let locked;
      try {
        locked = await connectionsRepo.lock(channelConnectionId, tx);
      } catch (err) {
        if (err instanceof NotFoundError) return;
        throw err;
      }
      if (locked.status !== 'active' && locked.status !== 'refresh_needed') return;
      if (locked.healthCheckedAt && locked.healthCheckedAt.getTime() > now.getTime()) return;
      if (locked.health === health) {
        if (!locked.healthCheckedAt || now.getTime() - locked.healthCheckedAt.getTime() >= HEALTH_RESTAMP_MS)
          await connectionsRepo.update(locked.id, locked.version, { healthCheckedAt: now }, tx);
        return;
      }
      await connectionsRepo.update(locked.id, locked.version, { health, healthCheckedAt: now }, tx);
      await audit.record(
        requireTenant().actor,
        'channel.health',
        { type: 'channel_connection', id: locked.id },
        health === 'ok' ? 'allowed' : 'denied',
        tx,
        {
          brandId: locked.brandId,
          channelConnectionId: locked.id,
          fromState: locked.health,
          toState: health,
        },
      );
    });
  },

  /** A read that went through: the access works. */
  recordRead: (channelConnectionId: string, now = new Date()) =>
    channelHealth.record(channelConnectionId, 'ok', now),

  /** A read that failed: recorded when the failure says something about the access; the health it set, or null. */
  async recordReadFailure(
    channelConnectionId: string,
    err: unknown,
    now = new Date(),
  ): Promise<ChannelHealth | null> {
    const health = healthFromReadFailure(err);
    if (health) await channelHealth.record(channelConnectionId, health, now);
    return health;
  },
};
