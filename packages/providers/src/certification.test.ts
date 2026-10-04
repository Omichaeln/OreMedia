import { describe, expect, it } from 'vitest';
import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import { CapabilityCertifications, type CertifiableCapability } from '@oremedia/contracts/providers';
import { publishCapabilitiesOf } from './capability';
import { CmsRegistry, cmsRegistry } from './cms-registry';
import { ProviderRegistry, providerRegistry } from './registry';
import { SourceRegistry, sourceRegistry } from './source-registry';
import { allCapabilitiesCertifiedForTest, certifiedForTest } from './testing';

const issueOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CapabilityUnsupportedError) return e.details?.[0]?.issue;
    throw e;
  }
  return undefined;
};

/** Every capability certified except `missing`, so one capability's gate can be observed alone. */
const allBut = (...missing: CertifiableCapability[]) =>
  Object.fromEntries(
    Object.entries(allCapabilitiesCertifiedForTest()).filter(
      ([c]) => !missing.includes(c as CertifiableCapability),
    ),
  );

const stateOf = (statuses: Array<{ capability: string; state: string }>, capability: CertifiableCapability) =>
  statuses.find((s) => s.capability === capability)?.state;

describe('PR-06: certification is recorded per (provider, capability)', () => {
  it('the production registries record no capability certification yet, and every record would be valid and supported', () => {
    const all = [
      ...providerRegistry.list().map((p) => ({
        key: p.key,
        statuses: providerRegistry.certifications(p.key),
        records: p.capability.certifications,
      })),
      ...sourceRegistry.list().map((p) => ({
        key: p.key,
        statuses: sourceRegistry.certifications(p.key),
        records: p.capability.certifications,
      })),
      ...cmsRegistry.list().map((p) => ({
        key: p.key,
        statuses: cmsRegistry.certifications(p.key),
        records: p.capability.certifications,
      })),
    ];
    expect(all).toHaveLength(8);
    for (const { key, statuses, records } of all) {
      expect(statuses, key).toHaveLength(11);
      // A record must carry its date, environment and evidence, and name a capability the adapter supports.
      const parsed = CapabilityCertifications.parse(records ?? {});
      for (const capability of Object.keys(parsed) as CertifiableCapability[])
        expect(stateOf(statuses, capability), `${key}.${capability}`).toBe('certified');
      // Nothing has been run against a platform yet (docs/release/connection-inventory.md): unknown is uncertified.
      expect(
        statuses.filter((s) => s.state === 'certified'),
        key,
      ).toEqual([]);
    }
  });

  it('what each channel supports is derived from its capability register and its adapter methods', () => {
    const supported = (key: string) =>
      providerRegistry
        .certifications(key)
        .filter((s) => s.state !== 'not_supported')
        .map((s) => s.capability);
    const every: CertifiableCapability[] = [
      'connect',
      'page_picker',
      'publish_text',
      'publish_image',
      'publish_video',
      'edit',
      'delete',
      'comment_reply',
      'analytics',
      'token_refresh',
      'reconnect',
    ];
    expect(supported('linkedin_page')).toEqual(every);
    expect(supported('facebook_page')).toEqual(every);
    // Instagram requires media and has no edit or delete in its API.
    expect(supported('instagram_business')).toEqual(
      every.filter((c) => !['publish_text', 'edit', 'delete'].includes(c)),
    );
    // X: no edit endpoint for API clients, and no account picker (one login is one account).
    expect(supported('x')).toEqual(every.filter((c) => !['edit', 'page_picker'].includes(c)));
  });

  it('get(key, capability) refuses a supported capability without its record, passes a certified or unsupported one', () => {
    const linkedin = providerRegistry.forCertification('linkedin_page')!;
    const r = new ProviderRegistry().register(
      certifiedForTest(linkedin, '2026-10-01T00:00:00.000Z', allBut('publish_video', 'comment_reply')),
    );
    expect(r.get('linkedin_page', 'publish_text').key).toBe('linkedin_page');
    expect(issueOf(() => r.get('linkedin_page', 'publish_video'))).toBe(
      'capability_not_certified:linkedin_page:publish_video',
    );
    expect(issueOf(() => r.get('linkedin_page', 'comment_reply'))).toBe(
      'capability_not_certified:linkedin_page:comment_reply',
    );
    expect(r.get('linkedin_page').key).toBe('linkedin_page'); // the provider gate alone is unchanged
    expect(r.isUncertified('linkedin_page', 'publish_text')).toBe(false);
    expect(r.isUncertified('linkedin_page', 'publish_video')).toBe(true);
    // Not supported is not a certification question: the caller's own support check refuses it.
    const ig = new ProviderRegistry().register(
      certifiedForTest(providerRegistry.forCertification('instagram_business')!, undefined, {}),
    );
    expect(ig.get('instagram_business', 'edit').key).toBe('instagram_business');
    expect(stateOf(ig.certifications('instagram_business'), 'edit')).toBe('not_supported');
    expect(ig.isUncertified('instagram_business', 'edit')).toBe(false); // not supported is not uncertified
    // The provider gate comes first: an uncertified provider is refused whatever its capability records say.
    expect(issueOf(() => providerRegistry.get('linkedin_page', 'connect'))).toBe(
      'provider_not_certified:linkedin_page',
    );
  });

  it('a provider certified before PR-06 (no records) has every supported capability uncertified', () => {
    const r = new ProviderRegistry().register(
      certifiedForTest(providerRegistry.forCertification('facebook_page')!, undefined, {}),
    );
    expect(r.certifications('facebook_page').every((s) => s.state === 'uncertified')).toBe(true);
    expect(issueOf(() => r.get('facebook_page', 'connect'))).toBe(
      'capability_not_certified:facebook_page:connect',
    );
  });

  it('sources and the CMS keep the same per-capability gate on their own capability sets', () => {
    const sources = new SourceRegistry().register(
      certifiedForTest(sourceRegistry.forCertification('ga4_property')!, undefined, allBut('page_picker')),
    );
    expect(
      sourceRegistry
        .certifications('ga4_property')
        .filter((s) => s.state !== 'not_supported')
        .map((s) => s.capability),
    ).toEqual(['connect', 'page_picker', 'analytics', 'token_refresh', 'reconnect']);
    expect(sources.get('ga4_property', 'connect').key).toBe('ga4_property');
    expect(issueOf(() => sources.get('ga4_property', 'page_picker'))).toBe(
      'capability_not_certified:ga4_property:page_picker',
    );
    const cms = new CmsRegistry().register(
      certifiedForTest(cmsRegistry.forCertification('cms_site')!, undefined, allBut('delete')),
    );
    expect(
      cmsRegistry
        .certifications('cms_site')
        .filter((s) => s.state !== 'not_supported')
        .map((s) => s.capability),
    ).toEqual(['connect', 'publish_text', 'publish_image', 'edit', 'delete', 'reconnect']);
    expect(cms.isUncertified('cms_site', 'edit')).toBe(false);
    expect(cms.isUncertified('cms_site', 'delete')).toBe(true);
    expect(issueOf(() => cms.get('cms_site', 'delete'))).toBe('capability_not_certified:cms_site:delete');
  });

  it('publishCapabilitiesOf: text alone, images, a video, and both for mixed media', () => {
    const m = (mime: string) => ({ mime, width: 1, height: 1, bytes: 1 });
    expect(publishCapabilitiesOf({ media: [] })).toEqual(['publish_text']);
    expect(publishCapabilitiesOf({ media: [m('image/png'), m('image/jpeg')] })).toEqual(['publish_image']);
    expect(publishCapabilitiesOf({ media: [m('video/mp4')] })).toEqual(['publish_video']);
    expect(publishCapabilitiesOf({ media: [m('image/png'), m('video/mp4')] })).toEqual([
      'publish_image',
      'publish_video',
    ]);
  });
});
