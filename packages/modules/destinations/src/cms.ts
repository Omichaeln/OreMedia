import type { ActivityHooks } from '@oremedia/contracts/agents';
import {
  MemoryProviderRateLimiter,
  cmsRegistry,
  createProviderIO,
  type CmsAdapter,
  type CmsRegistry,
  type ProviderIO,
  type RateLimiter,
} from '@oremedia/providers';

/**
 * How the destinations module reaches CMS adapters (ledger R2-3, as sources.ts does for source adapters): the
 * certified-only registry, one rate limiter keyed by kind and the ProviderIO factory. Generic code never names a
 * CMS; the registry gate refuses uncertified kinds for tenants.
 */
export interface DestinationCmsOptions {
  registry?: CmsRegistry;
  limiter?: RateLimiter;
  timeoutMs?: number;
  /** Tests only: allow loopback targets (refused in production by the dispatcher). */
  insecureAllowLoopback?: boolean;
}

let options: Required<Pick<DestinationCmsOptions, 'registry' | 'timeoutMs'>> &
  Pick<DestinationCmsOptions, 'limiter' | 'insecureAllowLoopback'> = {
  registry: cmsRegistry,
  timeoutMs: 30_000,
};
let limiter: RateLimiter | null = null;

export const configureDestinationCms = (opts: DestinationCmsOptions): void => {
  options = {
    registry: opts.registry ?? cmsRegistry,
    timeoutMs: opts.timeoutMs ?? 30_000,
    ...(opts.limiter ? { limiter: opts.limiter } : {}),
    ...(opts.insecureAllowLoopback ? { insecureAllowLoopback: true } : {}),
  };
  limiter = opts.limiter ?? null;
};

export const cmsRegistryInUse = (): CmsRegistry => options.registry;

/** Certified CMS adapters only; an unknown or uncertified kind is CAPABILITY_UNSUPPORTED (spec 14.6). */
export const cmsAdapterFor = (kind: string): CmsAdapter => options.registry.get(kind);

function rateLimiter(): RateLimiter {
  return (limiter ??=
    options.limiter ?? new MemoryProviderRateLimiter((kind) => options.registry.capability(kind)));
}

/**
 * A ProviderIO for one (kind, tenant) pair: every call is SSRF-checked, rate-limited and logged. The activity's
 * heartbeat is attached per request; `beforeSend` runs once before the first mutation leaves (the publishing
 * runtime commits the attempt's sentAt there, spec 14.3); `timeoutMs` bounds a rendered-page fetch (D-16).
 */
export function cmsIO(
  kind: string,
  tenantId: string,
  extra: { hooks?: ActivityHooks; beforeSend?: () => Promise<void>; timeoutMs?: number } = {},
): ProviderIO {
  const io = createProviderIO({
    providerKey: kind,
    tenantId,
    timeoutMs: extra.timeoutMs ?? options.timeoutMs,
    limiter: rateLimiter(),
    ...(options.insecureAllowLoopback ? { insecureAllowLoopback: true } : {}),
    ...(extra.beforeSend ? { beforeSend: extra.beforeSend } : {}),
  });
  const hooks = extra.hooks;
  if (!hooks) return io;
  return {
    request: (url, init, meta) => io.request(url, init, { ...meta, heartbeat: hooks.heartbeat }),
  };
}
