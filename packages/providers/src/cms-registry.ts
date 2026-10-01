import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import type { CmsAdapter, CmsCapabilityV1 } from './cms-contract';
import { wordpressCmsAdapter } from './cms/wordpress/adapter';

/**
 * Ledger R2-3: the CMS adapters keyed by destination kind, with the same certification gate as ProviderRegistry
 * and SourceRegistry (spec 14.6 / 20.2): only an adapter whose capability carries `certifiedAt` is usable for
 * tenants; the others are reachable only through `forCertification` (internal tooling). One adapter per kind:
 * the pilot's CMS (D-16) is the `cms_site` adapter of this deployment.
 */
export class CmsRegistry {
  private readonly adapters = new Map<string, CmsAdapter>();

  register(adapter: CmsAdapter): this {
    if (this.adapters.has(adapter.key)) throw new Error(`cms ${adapter.key} already registered`);
    if (adapter.capability.key !== adapter.key) throw new Error(`capability key mismatch for ${adapter.key}`);
    this.adapters.set(adapter.key, adapter);
    return this;
  }

  /** Certified adapters only (tenant-facing); the same refusals as ProviderRegistry.get, on `kind`. */
  get(kind: string): CmsAdapter {
    const a = this.adapters.get(kind);
    if (!a) throw new CapabilityUnsupportedError([{ path: 'kind', issue: `unknown_provider:${kind}` }]);
    if (!a.capability.certifiedAt)
      throw new CapabilityUnsupportedError([{ path: 'kind', issue: `provider_not_certified:${kind}` }]);
    return a;
  }

  forCertification(kind: string): CmsAdapter | undefined {
    return this.adapters.get(kind);
  }

  capability(kind: string): CmsCapabilityV1 | undefined {
    return this.adapters.get(kind)?.capability;
  }

  /** Every registered CMS adapter, certified or flagged as not, for the settings screen and the configuration report. */
  list(): Array<{ key: string; version: number; certified: boolean; capability: CmsCapabilityV1 }> {
    return [...this.adapters.values()].map((a) => ({
      key: a.key,
      version: a.capability.version,
      certified: a.capability.certifiedAt !== null,
      capability: a.capability,
    }));
  }
}

/**
 * The R2-3 reference adapter (D-16 working assumption: WordPress REST with an Application Password). It carries
 * `certifiedAt: null`, so `get()` refuses it for tenants until the read-back tests ran against the pilot site.
 */
export const cmsRegistry = new CmsRegistry().register(wordpressCmsAdapter);
