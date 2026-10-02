import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { SeoAuditCheckKey, SeoAuditSeverity } from '@oremedia/contracts/seo-audit';
import type { Tx } from '@oremedia/db';
import type { CapabilityCheck } from '@oremedia/observability';
import { providerClientSettings } from '@oremedia/module-publishing';
import { cmsRegistry, sourceRegistry } from '@oremedia/providers';

/**
 * RA-11: how an SEO finding becomes tracked work. The intelligence module owns the work object (a recommendation,
 * spec 16.4) and registers its create and its read here through the composition root, as the publishing module's
 * hooks.ts does: this module never imports another module's tables. The defaults are loud so a composition
 * mistake cannot pass silently.
 */
export interface FindingWorkInput {
  brandId: string;
  title: string;
  rationale: string;
  /** What the work is evidence of: the finding, its run, its rule, the website and the example pages. */
  provenance: {
    findingId: string;
    runId: string;
    check: SeoAuditCheckKey;
    severity: SeoAuditSeverity;
    destinationId: string;
    origin: string;
    pageCount: number;
    pages: string[];
  };
}
export interface FindingWorkRef {
  workType: string;
  workId: string;
  title: string;
  state: string;
}
export interface FindingWorkHooks {
  /** Creates the work in the caller's transaction; the work module asserts its own policy on the brand. */
  create(actor: ResolvedActor, input: FindingWorkInput, tx: Tx): Promise<FindingWorkRef>;
  /** The work items by id within the brand (tenant-scoped; an id of another brand is left out), for the list. */
  describe(brandId: string, workIds: readonly string[], tx?: Tx): Promise<FindingWorkRef[]>;
}
const unregisteredFindingWork: FindingWorkHooks = {
  create: async () => {
    throw new Error('finding work not registered (composition root must call registerFindingWork)');
  },
  describe: async () => {
    throw new Error('finding work not registered (composition root must call registerFindingWork)');
  },
};
let findingWorkHooks: FindingWorkHooks = unregisteredFindingWork;
export const registerFindingWork = (hooks: FindingWorkHooks): void => {
  findingWorkHooks = hooks;
};
export const resetFindingWork = (): void => {
  findingWorkHooks = unregisteredFindingWork;
};
export const findingWork: FindingWorkHooks = {
  create: (actor, input, tx) => findingWorkHooks.create(actor, input, tx),
  describe: (brandId, workIds, tx) => findingWorkHooks.describe(brandId, workIds, tx),
};

/**
 * Which source kinds this deployment connects (ledger R2-1). A source needs its app credentials
 * (PROVIDER_<KIND>_CLIENT_ID_REF / _SECRET_REF, read by providerClientsFromEnv as for channels) and must not be
 * listed in OREMEDIA_DISABLED_SOURCES, the explicit policy for a registered source that is not part of the current
 * rollout (as OREMEDIA_DISABLED_CHANNELS). A source whose capability names an `optInSetting` (R2-2: the Business
 * Profile kind behind OREMEDIA_ENABLE_GBP, while its platform API access is applied for) is besides disabled until
 * that variable reads `1`. Registered by the composition root; tests keep every source enabled.
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

/** The explicit opt-in a source's capability asks for, when it asks for one: present and `1`, or the kind is off. */
const optedIn = (env: NodeJS.ProcessEnv, kind: string): boolean => {
  const setting = sourceRegistry.capability(kind)?.optInSetting;
  return setting === undefined || env[setting] === '1';
};

export const sourceAvailabilityFromEnv =
  (env: NodeJS.ProcessEnv = process.env): SourceAvailability =>
  (kind) =>
    !disabledSourceKinds(env).has(kind) &&
    optedIn(env, kind) &&
    (cmsRegistry.capability(kind) !== undefined ||
      Object.values(providerClientSettings(kind)).every((name) => Boolean(env[name])));

/**
 * Configuration report capabilities `source:<kind>`, one per registered source adapter: the app credentials the
 * connect flow (api) and the daily token refresh (worker-core) read. A kind behind an opt-in is reported only once
 * the deployment opted in (the report never asks for credentials of a kind that is off by default).
 */
export const sourceCapabilities = (env: NodeJS.ProcessEnv = process.env): CapabilityCheck[] => {
  const disabled = disabledSourceKinds(env);
  return sourceRegistry
    .list()
    .filter(({ key }) => !disabled.has(key) && optedIn(env, key))
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
