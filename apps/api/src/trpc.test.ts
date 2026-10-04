import { describe, expect, it } from 'vitest';
import { rateLimitRedisUrlFromEnv } from './trpc';

describe('REDIS_URL (the rate limiter store; main.ts exits when this throws)', () => {
  it('is required in production, so limits and the password lockout are shared by every replica', () => {
    expect(() => rateLimitRedisUrlFromEnv({ NODE_ENV: 'production' })).toThrow(
      /REDIS_URL is required in production/,
    );
    expect(() => rateLimitRedisUrlFromEnv({ NODE_ENV: 'production', REDIS_URL: '  ' })).toThrow();
    expect(rateLimitRedisUrlFromEnv({ NODE_ENV: 'production', REDIS_URL: 'redis://cache:6379' })).toBe(
      'redis://cache:6379',
    );
  });

  it('is optional elsewhere: unset means the in-memory store', () => {
    expect(rateLimitRedisUrlFromEnv({})).toBeNull();
    expect(rateLimitRedisUrlFromEnv({ NODE_ENV: 'test' })).toBeNull();
    expect(rateLimitRedisUrlFromEnv({ REDIS_URL: ' redis://localhost:6379 ' })).toBe(
      'redis://localhost:6379',
    );
  });
});
