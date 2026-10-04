import { RateLimitedError } from '@oremedia/contracts/errors';
import { count, METRIC } from '@oremedia/observability';

/**
 * Spec 4.3: rate limit per principal and per tenant. Sliding window in Redis when configured; an in-memory
 * limiter otherwise (single-process development and tests). Never the durable record (spec 3.1).
 */
export interface RateLimitPolicy {
  limit: number;
  windowSec: number;
}

export interface RateLimiterStore {
  hit(key: string, windowSec: number): Promise<{ count: number; ttlMs: number }>;
  /** Ends the key's window (the next hit starts a new one). */
  reset(key: string): Promise<void>;
}

/** How often the in-memory store drops the buckets whose window has ended. */
export const MEMORY_BUCKET_SWEEP_MS = 60_000;

export class MemoryRateLimiterStore implements RateLimiterStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private sweptAt = Date.now();
  /** Live buckets (tests and diagnostics). */
  get size(): number {
    return this.buckets.size;
  }
  /** Ended windows are evicted at most once a minute, so many distinct callers cannot grow memory without bound. */
  private sweep(now: number) {
    if (now - this.sweptAt < MEMORY_BUCKET_SWEEP_MS) return;
    this.sweptAt = now;
    for (const [key, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(key);
  }
  async hit(key: string, windowSec: number) {
    const now = Date.now();
    this.sweep(now);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      return { count: 1, ttlMs: windowSec * 1000 };
    }
    b.count++;
    return { count: b.count, ttlMs: b.resetAt - now };
  }
  async reset(key: string) {
    this.buckets.delete(key);
  }
}

export interface RedisLike {
  multi(): RedisMulti;
  pexpire(k: string, ms: number): Promise<unknown>;
  del(k: string): Promise<unknown>;
}
interface RedisMulti {
  incr(k: string): RedisMulti;
  pttl(k: string): RedisMulti;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export class RedisRateLimiterStore implements RateLimiterStore {
  constructor(private readonly redis: RedisLike) {}
  async hit(key: string, windowSec: number) {
    const res = await this.redis.multi().incr(key).pttl(key).exec();
    const c = Number(res?.[0]?.[1] ?? 1);
    let ttl = Number(res?.[1]?.[1] ?? -1);
    if (ttl < 0) {
      await this.redis.pexpire(key, windowSec * 1000);
      ttl = windowSec * 1000;
    }
    return { count: c, ttlMs: ttl };
  }
  async reset(key: string) {
    await this.redis.del(key);
  }
}

const DEFAULT_PRINCIPAL: RateLimitPolicy = { limit: 600, windowSec: 60 };
const DEFAULT_TENANT: RateLimitPolicy = { limit: 6000, windowSec: 60 };
/** Expensive paths get tighter limits (per principal). */
const PATH_POLICIES: Record<string, RateLimitPolicy> = {
  'agents.runs.start': { limit: 30, windowSec: 60 },
  'creative.renders.request': { limit: 60, windowSec: 60 },
  'assets.uploads.createIntent': { limit: 120, windowSec: 60 },
  'publishing.publications.schedule': { limit: 120, windowSec: 60 },
  // D-03 sign-in routes, keyed per client address before anyone is authenticated.
  'auth.google.start': { limit: 30, windowSec: 60 },
  'auth.google.callback': { limit: 30, windowSec: 60 },
  'auth.sign_out': { limit: 30, windowSec: 60 },
  'auth.password.sign_in': { limit: 20, windowSec: 60 },
  'auth.password.setup': { limit: 10, windowSec: 60 },
  // Each call runs up to two scrypt hashes (128 MiB each): a signed-in person changes a password rarely.
  'access.account.setPassword': { limit: 10, windowSec: 60 },
};

/**
 * Attempt counters, keyed by what is under attack rather than by who asks (a distributed guesser shares one
 * counter). Every attempt is counted before it is checked, so concurrent attempts cannot all slip under the limit; a
 * success clears the counter. Ten attempts for one account within fifteen minutes without a success lock password
 * checks for that account until the window ends.
 */
const ATTEMPT_POLICIES: Record<string, RateLimitPolicy> = {
  'auth.password.attempt': { limit: 10, windowSec: 15 * 60 },
};

export class RateLimiter {
  constructor(private readonly store: RateLimiterStore) {}

  /** Throws RATE_LIMITED with retry-after (spec 7.1). */
  async consume(tenantId: string, principalId: string, path: string): Promise<void> {
    const perPath = PATH_POLICIES[path];
    const checks: Array<[string, RateLimitPolicy]> = [
      [`rl:t:${tenantId}:${DEFAULT_TENANT.windowSec}`, DEFAULT_TENANT],
      [`rl:p:${tenantId}:${principalId}:${DEFAULT_PRINCIPAL.windowSec}`, DEFAULT_PRINCIPAL],
    ];
    if (perPath) checks.push([`rl:pp:${tenantId}:${principalId}:${path}`, perPath]);
    for (const [key, policy] of checks) {
      const { count: c, ttlMs } = await this.store.hit(key, policy.windowSec);
      if (c > policy.limit) {
        count(METRIC.policyDenials, 1, { reason: 'rate_limited' });
        throw new RateLimitedError(Math.max(1000, ttlMs));
      }
    }
  }

  /** Counts one attempt against `subject`; throws RATE_LIMITED (retry-after = the rest of the window) over the limit. */
  async consumeAttempt(subject: string, kind: string): Promise<void> {
    const policy = attemptPolicy(kind);
    const { count: c, ttlMs } = await this.store.hit(`rl:f:${kind}:${subject}`, policy.windowSec);
    if (c > policy.limit) {
      count(METRIC.policyDenials, 1, { reason: 'rate_limited' });
      throw new RateLimitedError(Math.max(1000, ttlMs));
    }
  }

  /** A successful attempt: `subject` starts again with a clean counter. */
  async clearAttempts(subject: string, kind: string): Promise<void> {
    attemptPolicy(kind);
    await this.store.reset(`rl:f:${kind}:${subject}`);
  }
}

function attemptPolicy(kind: string): RateLimitPolicy {
  const policy = ATTEMPT_POLICIES[kind];
  if (!policy) throw new Error(`no attempt policy for ${kind}`);
  return policy;
}
