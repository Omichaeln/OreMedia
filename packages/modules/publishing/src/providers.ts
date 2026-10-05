import type { ActivityHooks } from '@oremedia/contracts/agents';
import { CapabilityUnsupportedError } from '@oremedia/contracts/errors';
import type { CertifiableCapability } from '@oremedia/contracts/providers';
import {
  MemoryProviderRateLimiter,
  createProviderIO,
  providerRegistry,
  type ProviderAdapter,
  type ProviderIO,
  type ProviderRegistry,
  type RateLimiter,
} from '@oremedia/providers';

/**
 * How the publishing module reaches adapters (spec 14.5/14.6): the certified-only registry, one rate limiter
 * (memory by default; Redis-backed in production through configurePublishingProviders) and the ProviderIO factory.
 * Generic code never names a provider; the registry gate refuses uncertified keys for tenants.
 */
export interface PublishingProviderOptions {
  registry?: ProviderRegistry;
  limiter?: RateLimiter;
  /** Explicit per-request timeout (spec 14.5; reference risk R8 set none). */
  timeoutMs?: number;
  /** Tests only: allow loopback targets (refused in production by the dispatcher). */
  insecureAllowLoopback?: boolean;
}

let options: Required<Pick<PublishingProviderOptions, 'registry' | 'timeoutMs'>> &
  Pick<PublishingProviderOptions, 'limiter' | 'insecureAllowLoopback'> = {
  registry: providerRegistry,
  timeoutMs: 30_000,
};
let limiter: RateLimiter | null = null;

export const configurePublishingProviders = (opts: PublishingProviderOptions): void => {
  options = {
    registry: opts.registry ?? providerRegistry,
    timeoutMs: opts.timeoutMs ?? 30_000,
    ...(opts.limiter ? { limiter: opts.limiter } : {}),
    ...(opts.insecureAllowLoopback ? { insecureAllowLoopback: true } : {}),
  };
  limiter = opts.limiter ?? null;
};

export const registry = (): ProviderRegistry => options.registry;

/**
 * Certified adapters only; an unknown or uncertified key is CAPABILITY_UNSUPPORTED (spec 14.6). With `capability`
 * (PR-06), a supported capability without its own certification record is refused the same way.
 */
export const adapterFor = (providerKey: string, capability?: CertifiableCapability): ProviderAdapter =>
  options.registry.get(providerKey, capability);

/**
 * #89: the registry gate again when a scheduled call runs (a publish, an edit or delete, a reply), not only when it
 * was asked for: the issue of the refusal `adapterFor` gives for the provider or for any of `capabilities`
 * (`provider_not_certified:<key>`, `capability_not_certified:<key>:<capability>`), or null when all are certified.
 * The activity ends that attempt with the issue as its definitive refusal code before anything is sent.
 */
export function certificationRefusal(
  providerKey: string,
  capabilities: readonly CertifiableCapability[],
): string | null {
  try {
    adapterFor(providerKey);
    for (const capability of capabilities) adapterFor(providerKey, capability);
    return null;
  } catch (err) {
    if (!(err instanceof CapabilityUnsupportedError)) throw err;
    return (err.details?.[0]?.issue ?? 'capability_unsupported').slice(0, 80);
  }
}

function rateLimiter(): RateLimiter {
  return (limiter ??=
    options.limiter ?? new MemoryProviderRateLimiter((key) => options.registry.capability(key)));
}

/**
 * A ProviderIO for one (provider, tenant) pair. The activity's heartbeat is attached per request (spec 20.3:
 * per-activity context, never a singleton), so adapters need not know they run inside Temporal. `beforeSend` runs
 * once, just before the first mutation leaves (publishOnce commits the attempt's sentAt there, spec 14.3).
 */
export function providerIO(
  providerKey: string,
  tenantId: string,
  hooks?: ActivityHooks,
  beforeSend?: () => Promise<void>,
): ProviderIO {
  const io = createProviderIO({
    providerKey,
    tenantId,
    timeoutMs: options.timeoutMs,
    limiter: rateLimiter(),
    ...(options.insecureAllowLoopback ? { insecureAllowLoopback: true } : {}),
    ...(beforeSend ? { beforeSend } : {}),
  });
  if (!hooks) return io;
  return {
    request: (url, init, meta) => io.request(url, init, { ...meta, heartbeat: hooks.heartbeat }),
  };
}
