import { afterEach, describe, expect, it } from 'vitest';
import { ProviderTransportError, SourceReadError, providerRegistry } from '@oremedia/providers';
import { healthFromClass, healthFromReadFailure } from './common';
import {
  channelActivationFromEnv,
  channelActivationOf,
  channelCapabilities,
  configureChannelActivation,
  providerClientSettings,
  providerClientsFromEnv,
} from './hooks';

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

describe('channel activation (RA-01): the facts the providers listing and connect.start read', () => {
  afterEach(() => configureChannelActivation(null));

  it('from the environment: disabled by OREMEDIA_DISABLED_CHANNELS, credential references by name with whether each is set', () => {
    const [first] = providerRegistry.list();
    const key = first?.key as string;
    const names = providerClientSettings(key);
    const of = channelActivationFromEnv({
      [names.clientId]: 'id-value',
      OREMEDIA_DISABLED_CHANNELS: ` ${key.toUpperCase()} `,
    });
    expect(of(key)).toEqual({
      disabled: true,
      credentialRefs: [
        { name: names.clientId, present: true },
        { name: names.clientSecret, present: false },
      ],
    });
    expect(JSON.stringify(of(key))).not.toContain('id-value'); // names only, never values
    expect(channelActivationFromEnv({})('x').disabled).toBe(false);
  });

  it('every channel is enabled with nothing to set until the composition root says otherwise', () => {
    expect(channelActivationOf('x')).toEqual({ disabled: false, credentialRefs: [] });
    configureChannelActivation((key) => ({ disabled: key === 'x', credentialRefs: [] }));
    expect(channelActivationOf('x').disabled).toBe(true);
    expect(channelActivationOf('linkedin_page').disabled).toBe(false);
  });
});

describe('channel health from the provider error classification (RA-01, generic for every provider)', () => {
  it('a refused token is token_expired, a grant that is gone is revoked, anything else says nothing', () => {
    expect(healthFromClass({ kind: 'refresh_token' })).toBe('token_expired');
    expect(healthFromClass({ kind: 'reconnect_required' })).toBe('revoked');
    expect(healthFromClass({ kind: 'rate_limited', phase: 'before_send' })).toBeNull();
    expect(healthFromClass({ kind: 'rejected', code: 'duplicate' })).toBeNull();
    expect(healthFromClass({ kind: 'unknown' })).toBeNull();
  });

  it('a read failure: transport is unreachable; a 401 maps its classification; a 403 may be one permission, not a dead grant', () => {
    expect(healthFromReadFailure(new ProviderTransportError(new Error('reset'), 'after_send'))).toBe(
      'unreachable',
    );
    expect(healthFromReadFailure(new SourceReadError('x', 401, { kind: 'refresh_token' }, 'expired'))).toBe(
      'token_expired',
    );
    expect(
      healthFromReadFailure(new SourceReadError('x', 401, { kind: 'reconnect_required' }, 'revoked')),
    ).toBe('revoked');
    expect(
      healthFromReadFailure(new SourceReadError('x', 403, { kind: 'reconnect_required' }, 'no permission')),
    ).toBeNull();
    expect(healthFromReadFailure(new Error('platform 500'))).toBeNull();
  });
});
