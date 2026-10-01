import { describe, expect, it } from 'vitest';
import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import { SourceRegistry, sourceRegistry } from './source-registry';
import { certifiedForTest } from './testing';

const KINDS = ['ga4_property', 'search_console_site', 'gbp_location'];

describe('source registry (ledger R2-1): registered, none enabled for tenants until certified', () => {
  it('registers every source adapter with scopes, rate limits and certifiedAt null', () => {
    const listed = sourceRegistry.list();
    expect(listed.map((l) => l.key).sort()).toEqual([...KINDS].sort());
    for (const entry of listed) {
      expect(entry.certified).toBe(false);
      expect(entry.capability.certifiedAt).toBeNull();
      expect(entry.capability.requiredScopes.length).toBeGreaterThan(0);
      expect(entry.capability.rateLimits.length).toBeGreaterThan(0);
      expect(entry.capability.latencyHours).toBeGreaterThan(0);
    }
  });
  it('get() refuses an uncertified or unknown kind with the same refusal as channels; forCertification exposes it', () => {
    for (const kind of KINDS) {
      try {
        sourceRegistry.get(kind);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CapabilityUnsupportedError);
        expect((e as CapabilityUnsupportedError).details?.[0]).toEqual({
          path: 'kind',
          issue: `provider_not_certified:${kind}`,
        });
      }
      expect(sourceRegistry.forCertification(kind)?.key).toBe(kind);
    }
    try {
      sourceRegistry.get('cms_site');
      expect.unreachable();
    } catch (e) {
      expect((e as CapabilityUnsupportedError).details?.[0]?.issue).toBe('unknown_provider:cms_site');
    }
  });
  it('only an explicit certified registration passes the gate; a key mismatch or a duplicate is refused', () => {
    const r = new SourceRegistry();
    for (const kind of KINDS) r.register(certifiedForTest(sourceRegistry.forCertification(kind)!));
    for (const kind of KINDS) expect(r.get(kind).capability.certifiedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(r.list().every((l) => l.certified)).toBe(true);
    expect(() => r.register(sourceRegistry.forCertification('ga4_property')!)).toThrow(/already registered/);
  });
});
