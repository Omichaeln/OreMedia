import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import type { SourceAdapter, SourceCapabilityV1 } from './source-contract';
import { ga4PropertyAdapter } from './sources/ga4_property/adapter';
import { gbpLocationAdapter } from './sources/gbp_location/adapter';
import { searchConsoleSiteAdapter } from './sources/search_console_site/adapter';

/**
 * Ledger R2-1: the source adapters keyed by destination kind, with the same certification gate as
 * ProviderRegistry (spec 14.6 / 20.2): only an adapter whose capability carries `certifiedAt` is usable for
 * tenants; the others are reachable only through `forCertification` (internal tooling). A kind without a
 * registered adapter (a CMS, a webhook) is refused the same way as an unknown provider.
 */
export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): this {
    if (this.adapters.has(adapter.key)) throw new Error(`source ${adapter.key} already registered`);
    if (adapter.capability.key !== adapter.key) throw new Error(`capability key mismatch for ${adapter.key}`);
    this.adapters.set(adapter.key, adapter);
    return this;
  }

  /** Certified adapters only (tenant-facing); the same refusals as ProviderRegistry.get, on `kind`. */
  get(kind: string): SourceAdapter {
    const a = this.adapters.get(kind);
    if (!a) throw new CapabilityUnsupportedError([{ path: 'kind', issue: `unknown_provider:${kind}` }]);
    if (!a.capability.certifiedAt)
      throw new CapabilityUnsupportedError([{ path: 'kind', issue: `provider_not_certified:${kind}` }]);
    return a;
  }

  forCertification(kind: string): SourceAdapter | undefined {
    return this.adapters.get(kind);
  }

  capability(kind: string): SourceCapabilityV1 | undefined {
    return this.adapters.get(kind)?.capability;
  }

  /** Every registered source, certified or flagged as not, for the settings screen and the configuration report. */
  list(): Array<{ key: string; version: number; certified: boolean; capability: SourceCapabilityV1 }> {
    return [...this.adapters.values()].map((a) => ({
      key: a.key,
      version: a.capability.version,
      certified: a.capability.certifiedAt !== null,
      capability: a.capability,
    }));
  }
}

/**
 * The R2-1 sources and the R2-2 Business Profile location. All carry `certifiedAt: null`, so `get()` refuses them
 * for tenants until the adapter is certified against the deployment's own Google Cloud project
 * (docs/platform-apps/google.md); the Business Profile kind is besides offered only behind OREMEDIA_ENABLE_GBP.
 */
export const sourceRegistry = new SourceRegistry()
  .register(ga4PropertyAdapter)
  .register(searchConsoleSiteAdapter)
  .register(gbpLocationAdapter);
