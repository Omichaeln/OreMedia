import { describe, expect, it } from 'vitest';
import { providerActivationState } from './providers';

describe('providerActivationState (RA-01): the reasons in the order they are checked', () => {
  const refs = [
    { name: 'PROVIDER_X_CLIENT_ID_REF', present: true },
    { name: 'PROVIDER_X_SECRET_REF', present: true },
  ];

  it('uncertified first, then disabled, then missing credentials, else ready', () => {
    expect(
      providerActivationState({ key: 'x', certifiedAt: null, disabled: true, credentialRefs: [] }),
    ).toEqual({
      state: 'uncertified',
      reason: 'provider_not_certified:x',
    });
    expect(
      providerActivationState({
        key: 'x',
        certifiedAt: '2026-10-01T00:00:00.000Z',
        disabled: true,
        credentialRefs: [],
      }),
    ).toEqual({ state: 'disabled', reason: 'provider_disabled:x' });
    expect(
      providerActivationState({
        key: 'x',
        certifiedAt: '2026-10-01T00:00:00.000Z',
        disabled: false,
        credentialRefs: [refs[0]!, { name: 'PROVIDER_X_SECRET_REF', present: false }],
      }),
    ).toEqual({ state: 'credentials_missing', reason: 'credentials_missing:PROVIDER_X_SECRET_REF' });
    expect(
      providerActivationState({
        key: 'x',
        certifiedAt: '2026-10-01T00:00:00.000Z',
        disabled: false,
        credentialRefs: refs,
      }),
    ).toEqual({ state: 'ready', reason: null });
    // A kind with nothing to set (a CMS) is ready once certified and not disabled.
    expect(
      providerActivationState({
        key: 'cms_site',
        certifiedAt: '2026-10-01T00:00:00.000Z',
        disabled: false,
        credentialRefs: [],
      }).state,
    ).toBe('ready');
  });
});
