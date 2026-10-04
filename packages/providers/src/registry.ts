import {
  capabilityCertificationStatuses,
  type CapabilityCertificationStatusV1,
  type CertifiableCapability,
  type ProviderCapabilityV1,
} from '@oremedia/contracts/providers';
import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import { assertCapabilityCertified } from './capability';
import type { ProviderAdapter } from './contract';
import { linkedInPageAdapter } from './linkedin_page/adapter';
import { instagramBusinessAdapter } from './instagram_business/adapter';
import { facebookPageAdapter } from './facebook_page/adapter';
import { xAdapter } from './x/adapter';

/**
 * Spec 14.6 / 20.2: a registry keyed by provider key. Only certified adapters (capability.certifiedAt set) can be
 * used for tenants; uncertified adapters are reachable only through `forCertification` (internal tooling).
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    if (this.adapters.has(adapter.key)) throw new Error(`provider ${adapter.key} already registered`);
    if (adapter.capability.key !== adapter.key) throw new Error(`capability key mismatch for ${adapter.key}`);
    this.adapters.set(adapter.key, adapter);
    return this;
  }

  /**
   * Certified adapters only (tenant-facing). With `capability` (PR-06), a capability the adapter supports must
   * also carry its own certification record, else the same CAPABILITY_UNSUPPORTED (`capability_not_certified`).
   */
  get(key: string, capability?: CertifiableCapability): ProviderAdapter {
    const a = this.adapters.get(key);
    if (!a) throw new CapabilityUnsupportedError([{ path: 'providerKey', issue: `unknown_provider:${key}` }]);
    if (!a.capability.certifiedAt)
      throw new CapabilityUnsupportedError([{ path: 'providerKey', issue: `provider_not_certified:${key}` }]);
    if (capability) assertCapabilityCertified('providerKey', key, capability, this.certifications(key));
    return a;
  }

  /** PR-06: every certifiable capability's state on a registered provider; empty for an unknown key. */
  certifications(key: string): CapabilityCertificationStatusV1[] {
    const a = this.adapters.get(key);
    return a ? capabilityCertificationStatuses(channelCapabilitySupport(a), a.capability.certifications) : [];
  }

  /** PR-06: whether the capability is supported here but carries no certification record (refused or labelled). */
  isUncertified(key: string, capability: CertifiableCapability): boolean {
    return this.certifications(key).find((s) => s.capability === capability)?.state === 'uncertified';
  }

  forCertification(key: string): ProviderAdapter | undefined {
    return this.adapters.get(key);
  }

  /**
   * Any registered adapter, certified or not: for work that winds a connection down (RA-01 remote revoke on
   * disconnect), which a provider decertified since the connection was made must not block. Never for a connect,
   * a publish or a read: those go through `get`.
   */
  lookup(key: string): ProviderAdapter | undefined {
    return this.adapters.get(key);
  }

  capability(key: string): ProviderCapabilityV1 | undefined {
    return this.adapters.get(key)?.capability;
  }

  /** Capabilities visible to the UI and the adaptation skill: certified ones, plus uncertified flagged as such. */
  list(): Array<{ key: string; version: number; certified: boolean; capability: ProviderCapabilityV1 }> {
    return [...this.adapters.values()].map((a) => ({
      key: a.key,
      version: a.capability.version,
      certified: a.capability.certifiedAt !== null,
      capability: a.capability,
    }));
  }
}

/**
 * PR-06: the certifiable capabilities a channel adapter offers, from its capability register and the optional
 * methods it implements; the rest are `not_supported`. Text-only publishing is what the adapter's own validation
 * accepts for a variant without media (Instagram requires media), the check the product runs before release.
 */
export function channelCapabilitySupport(adapter: ProviderAdapter): Set<CertifiableCapability> {
  const cap = adapter.capability;
  const supported = new Set<CertifiableCapability>(['connect', 'token_refresh', 'reconnect']);
  if (adapter.selectAccount) supported.add('page_picker');
  if (adapter.validateVariant({ text: 'Certification', altTexts: [], media: [], settings: {} }).ok)
    supported.add('publish_text');
  if (cap.media.image) supported.add('publish_image');
  if (cap.media.video) supported.add('publish_video');
  if (cap.edit && adapter.editPost) supported.add('edit');
  if (cap.delete && adapter.deletePost) supported.add('delete');
  if (cap.comments.reply && adapter.comment) supported.add('comment_reply');
  if (
    (adapter.fetchPostMetrics && cap.analytics.post.length > 0) ||
    (adapter.fetchAccountMetrics && cap.analytics.account.length > 0)
  )
    supported.add('analytics');
  return supported;
}

/**
 * Release 1 adapters (spec 14.8; D-04 open: X built as the fourth channel). All four carry `certifiedAt: null`, so
 * `get()` refuses them for tenants until certification with the platform's own app (docs/runbooks/certify-a-provider.md).
 */
export const providerRegistry = new ProviderRegistry()
  .register(linkedInPageAdapter)
  .register(instagramBusinessAdapter)
  .register(facebookPageAdapter)
  .register(xAdapter);
