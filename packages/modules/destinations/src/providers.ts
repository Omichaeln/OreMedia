import type { ResolvedActor } from '@oremedia/contracts/policy';
import {
  providerActivationState,
  type CapabilityCertificationStatusV1,
  type ProviderActivationV1,
  type ProviderCredentialRefV1,
  type ProviderKind,
} from '@oremedia/contracts/providers';
import { requireTenant, type Tx } from '@oremedia/db';
import { policy } from '@oremedia/module-access';
import { channelActivationOf, providerRegistryInUse } from '@oremedia/module-publishing';
import { cmsRegistryInUse } from './cms';
import { sourceActivationOf } from './hooks';
import { registry as sourceRegistryInUse } from './sources';

/**
 * RA-01: every registered provider of the three registries with what this deployment says about it (certified,
 * disabled here, app credential references set: names only, never values) and the activation state derived from
 * those facts, so a settings screen can say why a provider cannot be connected instead of failing generically,
 * and (PR-06) every certifiable capability's state, so an uncertified capability is labelled as such. A
 * read of the deployment, not of tenant content: gated to owners and admins (audit.read) like the other
 * operations reads.
 */
function activation(
  kind: ProviderKind,
  entry: { key: string; version: number; capability: { certifiedAt: string | null } },
  facts: { disabled: boolean; credentialRefs: ProviderCredentialRefV1[] },
  vendor: string,
  capabilities: CapabilityCertificationStatusV1[],
): ProviderActivationV1 {
  const base = {
    key: entry.key,
    kind,
    vendor,
    capabilityVersion: entry.version,
    certifiedAt: entry.capability.certifiedAt,
    disabled: facts.disabled,
    credentialRefs: facts.credentialRefs,
    capabilities,
  };
  return { ...base, ...providerActivationState(base) };
}

export function listProviders(): ProviderActivationV1[] {
  const channels = providerRegistryInUse();
  const sources = sourceRegistryInUse();
  const cms = cmsRegistryInUse();
  return [
    ...channels
      .list()
      .map((p) =>
        activation(
          'channel',
          p,
          channelActivationOf(p.key),
          p.capability.vendor ?? p.key,
          channels.certifications(p.key),
        ),
      ),
    ...sources
      .list()
      .map((s) =>
        activation(
          'source',
          s,
          sourceActivationOf(s.key),
          s.capability.vendor,
          sources.certifications(s.key),
        ),
      ),
    ...cms
      .list()
      .map((c) =>
        activation('cms', c, sourceActivationOf(c.key), c.capability.vendor, cms.certifications(c.key)),
      ),
  ];
}

export const providerService = {
  async list(actor: ResolvedActor, tx?: Tx): Promise<{ items: ProviderActivationV1[] }> {
    const { tenantId } = requireTenant();
    await policy.assert(actor, 'audit.read', { type: 'tenant', tenantId, id: tenantId }, {}, tx);
    return { items: listProviders() };
  },
};
