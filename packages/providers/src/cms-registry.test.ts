import { describe, expect, it } from 'vitest';
import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import { CmsRegistry, cmsRegistry } from './cms-registry';
import { certifiedForTest } from './testing';

describe('cms registry (ledger R2-3): registered, not enabled for tenants until certified', () => {
  it('registers the cms_site adapter with its vendor, actions and certifiedAt null', () => {
    const listed = cmsRegistry.list();
    expect(listed.map((l) => l.key)).toEqual(['cms_site']);
    const entry = listed[0]!;
    expect(entry.certified).toBe(false);
    expect(entry.capability.certifiedAt).toBeNull();
    expect(entry.capability.vendor).toBe('WordPress');
    expect(entry.capability).toMatchObject({ edit: true, delete: true, unpublish: true });
    expect(entry.capability.rateLimits.length).toBeGreaterThan(0);
  });
  it('get() refuses an uncertified or unknown kind as the channel and source registries do', () => {
    try {
      cmsRegistry.get('cms_site');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CapabilityUnsupportedError);
      expect((e as CapabilityUnsupportedError).details?.[0]).toEqual({
        path: 'kind',
        issue: 'provider_not_certified:cms_site',
      });
    }
    expect(cmsRegistry.forCertification('cms_site')?.key).toBe('cms_site');
    try {
      cmsRegistry.get('discord_webhook');
      expect.unreachable();
    } catch (e) {
      expect((e as CapabilityUnsupportedError).details?.[0]?.issue).toBe('unknown_provider:discord_webhook');
    }
  });
  it('only an explicit certified registration passes the gate; a duplicate is refused', () => {
    const r = new CmsRegistry().register(certifiedForTest(cmsRegistry.forCertification('cms_site')!));
    expect(r.get('cms_site').capability.certifiedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(() => r.register(cmsRegistry.forCertification('cms_site')!)).toThrow(/already registered/);
  });
});
