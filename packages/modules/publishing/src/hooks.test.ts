import { describe, expect, it } from 'vitest';
import { providerRegistry } from '@oremedia/providers';
import { channelCapabilities, providerClientSettings, providerClientsFromEnv } from './hooks';

describe('channel capabilities (startup configuration report)', () => {
  it('one capability per registered provider, named channel:<providerKey>', () => {
    expect(channelCapabilities().map((c) => c.capability)).toEqual(
      providerRegistry.list().map((p) => `channel:${p.key}`),
    );
    expect(channelCapabilities().length).toBeGreaterThan(0);
  });

  it('checks the names providerClientsFromEnv reads, and nothing else', () => {
    const [first] = providerRegistry.list();
    const key = first?.key as string;
    const names = providerClientSettings(key);
    const check = channelCapabilities().find((c) => c.capability === `channel:${key}`);
    expect(check?.missing({})).toEqual([names.clientId, names.clientSecret]);
    expect(check?.missing({ [names.clientId]: 'id-value' })).toEqual([names.clientSecret]);
    const env = { [names.clientId]: 'id-value', [names.clientSecret]: 'secret-value' };
    expect(check?.missing(env)).toEqual([]);
    // The reader accepts exactly the environment the check calls configured.
    expect(providerClientsFromEnv(env)(key)).toEqual({ clientId: 'id-value', clientSecret: 'secret-value' });
    expect(() => providerClientsFromEnv({ [names.clientId]: 'id-value' })(key)).toThrow(names.clientSecret);
  });

  it('omits only explicitly disabled channels and keeps all others required', () => {
    const configured = channelCapabilities({ OREMEDIA_DISABLED_CHANNELS: ' x, ' });
    expect(configured.map((c) => c.capability)).not.toContain('channel:x');
    expect(configured.map((c) => c.capability)).toContain('channel:facebook_page');
    expect(channelCapabilities().map((c) => c.capability)).toContain('channel:x');
  });
});
