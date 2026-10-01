import type { CapabilityCheck } from '@oremedia/observability';
import { providerClientSettings } from '@oremedia/module-publishing';
import { cmsRegistry, sourceRegistry } from '@oremedia/providers';

/**
 * Which source kinds this deployment connects (ledger R2-1). A source needs its app credentials
 * (PROVIDER_<KIND>_CLIENT_ID_REF / _SECRET_REF, read by providerClientsFromEnv as for channels) and must not be
 * listed in OREMEDIA_DISABLED_SOURCES, the explicit policy for a registered source that is not part of the current
 * rollout (as OREMEDIA_DISABLED_CHANNELS). Registered by the composition root; tests keep every source enabled.
 * A CMS kind (R2-3) needs no app credentials (the site's own integration identity is sealed per destination), so
 * only the disabled list applies to it.
 */
export type SourceAvailability = (kind: string) => boolean;
let availability: SourceAvailability = () => true;
export const configureSourceAvailability = (fn: SourceAvailability | null): void => {
  availability = fn ?? (() => true);
};
export const sourceAvailable = (kind: string): boolean => availability(kind);

const disabledSourceKinds = (env: NodeJS.ProcessEnv): ReadonlySet<string> =>
  new Set(
    (env['OREMEDIA_DISABLED_SOURCES'] ?? '')
      .split(',')
      .map((kind) => kind.trim().toLowerCase())
      .filter(Boolean),
  );

export const sourceAvailabilityFromEnv =
  (env: NodeJS.ProcessEnv = process.env): SourceAvailability =>
  (kind) =>
    !disabledSourceKinds(env).has(kind) &&
    (cmsRegistry.capability(kind) !== undefined ||
      Object.values(providerClientSettings(kind)).every((name) => Boolean(env[name])));

/**
 * Configuration report capabilities `source:<kind>`, one per registered source adapter: the app credentials the
 * connect flow (api) and the daily token refresh (worker-core) read.
 */
export const sourceCapabilities = (env: NodeJS.ProcessEnv = process.env): CapabilityCheck[] => {
  const disabled = disabledSourceKinds(env);
  return sourceRegistry
    .list()
    .filter(({ key }) => !disabled.has(key))
    .map(({ key }) => ({
      capability: `source:${key}`,
      missing: (checkEnv) => Object.values(providerClientSettings(key)).filter((name) => !checkEnv[name]),
    }));
};

/**
 * Configuration report capabilities `cms:<vendor>` (R2-3), one per registered CMS adapter: nothing to set (the
 * integration identity is sealed per destination), so the line reports the adapter as present unless its kind is
 * listed in OREMEDIA_DISABLED_SOURCES.
 */
export const cmsCapabilities = (env: NodeJS.ProcessEnv = process.env): CapabilityCheck[] => {
  const disabled = disabledSourceKinds(env);
  return cmsRegistry
    .list()
    .filter(({ key }) => !disabled.has(key))
    .map(({ capability }) => ({ capability: `cms:${capability.vendor.toLowerCase()}`, missing: () => [] }));
};
