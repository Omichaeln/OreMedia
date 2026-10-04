import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryConnectStateStore, RedisConnectStateStore, type ConnectState } from './channels';

const state = (expiresAt: number): ConnectState => ({
  tenantId: 'ten_1',
  brandId: 'brd_1',
  providerKey: 'fixture',
  redirectUri: 'https://app.example/connect/callback',
  codeVerifier: 'v'.repeat(43),
  actorId: 'usr_1',
  expiresAt,
});

describe('connect state stores', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the memory store evicts expired entries on put, so abandoned flows do not accumulate', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const store = new MemoryConnectStateStore();
    for (let i = 0; i < 50; i++) await store.put(`abandoned_${i}`, state(Date.now() + 600_000));
    expect(store.size).toBe(50);
    vi.setSystemTime(1_000_000 + 600_001);
    await store.put('fresh', state(Date.now() + 600_000));
    expect(store.size).toBe(1);
    expect(await store.take('abandoned_0')).toBeNull();
    expect(await store.take('fresh')).toMatchObject({ actorId: 'usr_1' });
    expect(await store.take('fresh')).toBeNull(); // one-shot
  });

  it('the Redis store sets each state with its own expiry under its prefix and takes it once with GETDEL', async () => {
    const data = new Map<string, string>();
    const sets: Array<[string, number]> = [];
    const redis = {
      async set(key: string, value: string, _mode: 'PX', ttlMs: number) {
        sets.push([key, ttlMs]);
        data.set(key, value);
        return 'OK';
      },
      async getdel(key: string) {
        const v = data.get(key) ?? null;
        data.delete(key);
        return v;
      },
    };
    const channels = new RedisConnectStateStore(redis, 'connect:channel:');
    const destinations = new RedisConnectStateStore(redis, 'connect:destination:');
    const value = state(Date.now() + 600_000);
    await channels.put('st_1', value);
    expect(sets[0]![0]).toBe('connect:channel:st_1');
    expect(sets[0]![1]).toBeGreaterThan(599_000);
    expect(await destinations.take('st_1')).toBeNull(); // another flow's state never completes this one
    expect(await channels.take('st_1')).toEqual(value);
    expect(await channels.take('st_1')).toBeNull();
    await channels.put('st_old', state(Date.now() - 1));
    expect(await channels.take('st_old')).toBeNull();
  });
});
