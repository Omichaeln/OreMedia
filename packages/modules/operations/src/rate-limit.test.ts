import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimitedError } from '@oremedia/contracts/errors';
import {
  MEMORY_BUCKET_SWEEP_MS,
  MemoryRateLimiterStore,
  RateLimiter,
  RedisRateLimiterStore,
} from './rate-limit';

const KIND = 'auth.password.attempt';

describe('attempt counters (per-account password lockout)', () => {
  it('counts every attempt first: the eleventh within the window is refused with the rest of the window', async () => {
    const limiter = new RateLimiter(new MemoryRateLimiterStore());
    for (let i = 0; i < 10; i++) await limiter.consumeAttempt('acct', KIND);
    const err = await limiter.consumeAttempt('acct', KIND).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBeGreaterThan(14 * 60_000);
    await limiter.consumeAttempt('other', KIND); // another subject is unaffected
  });

  it('concurrent attempts cannot all slip under the limit', async () => {
    const limiter = new RateLimiter(new MemoryRateLimiterStore());
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () => limiter.consumeAttempt('acct', KIND)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  });

  it('a success clears the counter', async () => {
    const limiter = new RateLimiter(new MemoryRateLimiterStore());
    for (let i = 0; i < 9; i++) await limiter.consumeAttempt('acct', KIND);
    await limiter.clearAttempts('acct', KIND);
    for (let i = 0; i < 10; i++) await limiter.consumeAttempt('acct', KIND);
    await expect(limiter.consumeAttempt('acct', KIND)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('an unknown kind is a programming error', async () => {
    const limiter = new RateLimiter(new MemoryRateLimiterStore());
    await expect(limiter.consumeAttempt('acct', 'nope')).rejects.toThrow(/no attempt policy/);
  });

  it('the Redis store resets a key by deleting it', async () => {
    const deleted: string[] = [];
    const chain = { incr: () => chain, pttl: () => chain, exec: async () => [] };
    const store = new RedisRateLimiterStore({
      multi: () => chain,
      pexpire: async () => 1,
      del: async (k: string) => deleted.push(k),
    });
    await store.reset('k');
    expect(deleted).toEqual(['k']);
  });
});

describe('in-memory store (no REDIS_URL outside production)', () => {
  afterEach(() => vi.useRealTimers());

  it('evicts buckets whose window has ended, so distinct callers cannot grow memory without bound', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-01T00:00:00Z') });
    const store = new MemoryRateLimiterStore();
    for (let i = 0; i < 100; i++) await store.hit(`rl:ip:${i}`, 60);
    await store.hit('rl:long', 3600);
    expect(store.size).toBe(101);
    vi.advanceTimersByTime(Math.max(61_000, MEMORY_BUCKET_SWEEP_MS));
    await store.hit('rl:new', 60);
    // The ended one-minute windows are gone; the live hour window and the new bucket remain, with their counts.
    expect(store.size).toBe(2);
    expect((await store.hit('rl:long', 3600)).count).toBe(2);
  });
});
