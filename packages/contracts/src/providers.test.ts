import { describe, expect, it } from 'vitest';
import {
  CapabilityCertificationV1,
  capabilityCertificationStatuses,
  providerActivationState,
  type CapabilityCertificationStatusV1,
} from './providers';

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

describe('PR-06 capability certification', () => {
  const record = { certifiedAt: '2026-10-01T00:00:00.000Z', environment: 'staging', evidence: 'D-04 run 1' };

  it('a capability is not_supported whatever is recorded, certified with a record, else uncertified', () => {
    const statuses = capabilityCertificationStatuses(new Set(['connect', 'publish_text']), {
      connect: record,
      edit: record,
    });
    expect(statuses).toHaveLength(11);
    expect(statuses.find((s) => s.capability === 'connect')).toEqual({
      capability: 'connect',
      state: 'certified',
      certification: record,
    });
    expect(statuses.find((s) => s.capability === 'publish_text')?.state).toBe('uncertified');
    expect(statuses.find((s) => s.capability === 'edit')?.state).toBe('not_supported');
    expect(capabilityCertificationStatuses(new Set(['connect']), undefined)[0]?.state).toBe('uncertified');
  });

  it('a record needs its date, environment and evidence', () => {
    expect(CapabilityCertificationV1.safeParse(record).success).toBe(true);
    expect(CapabilityCertificationV1.safeParse({ ...record, evidence: '' }).success).toBe(false);
    expect(CapabilityCertificationV1.safeParse({ ...record, environment: '' }).success).toBe(false);
    expect(CapabilityCertificationV1.safeParse({ ...record, certifiedAt: 'yesterday' }).success).toBe(false);
  });

  it('a certified provider whose connect is not certified reads uncertified, with the capability reason', () => {
    const capabilities: CapabilityCertificationStatusV1[] = [
      { capability: 'connect', state: 'uncertified', certification: null },
    ];
    expect(
      providerActivationState({
        key: 'x',
        certifiedAt: '2026-10-01T00:00:00.000Z',
        disabled: false,
        credentialRefs: [],
        capabilities,
      }),
    ).toEqual({ state: 'uncertified', reason: 'capability_not_certified:x:connect' });
    expect(
      providerActivationState({
        key: 'x',
        certifiedAt: '2026-10-01T00:00:00.000Z',
        disabled: false,
        credentialRefs: [],
        capabilities: [{ capability: 'connect', state: 'certified', certification: record }],
      }).state,
    ).toBe('ready');
  });
});
