import {
  MemoryProviderRateLimiter,
  createProviderIO,
  sourceRegistry,
  type ProviderIO,
  type RateLimiter,
  type SourceAdapter,
  type SourceRegistry,
} from '@oremedia/providers';

/**
 * How the destinations module reaches source adapters (ledger R2-1, as packages/modules/publishing/src/providers.ts
 * does for channels): the certified-only source registry, one rate limiter keyed by kind and the ProviderIO
 * factory. Generic code never names a source; the registry gate refuses uncertified kinds for tenants.
 */
export interface DestinationSourceOptions {
  registry?: SourceRegistry;
  limiter?: RateLimiter;
  timeoutMs?: number;
  /** Tests only: allow loopback targets (refused in production by the dispatcher). */
  insecureAllowLoopback?: boolean;
}

let options: Required<Pick<DestinationSourceOptions, 'registry' | 'timeoutMs'>> &
  Pick<DestinationSourceOptions, 'limiter' | 'insecureAllowLoopback'> = {
  registry: sourceRegistry,
  timeoutMs: 30_000,
};
let limiter: RateLimiter | null = null;

export const configureDestinationSources = (opts: DestinationSourceOptions): void => {
  options = {
    registry: opts.registry ?? sourceRegistry,
    timeoutMs: opts.timeoutMs ?? 30_000,
    ...(opts.limiter ? { limiter: opts.limiter } : {}),
    ...(opts.insecureAllowLoopback ? { insecureAllowLoopback: true } : {}),
  };
  limiter = opts.limiter ?? null;
};

export const registry = (): SourceRegistry => options.registry;

/** Certified source adapters only; an unknown or uncertified kind is CAPABILITY_UNSUPPORTED (spec 14.6). */
export const sourceAdapterFor = (kind: string): SourceAdapter => options.registry.get(kind);

function rateLimiter(): RateLimiter {
  return (limiter ??=
    options.limiter ?? new MemoryProviderRateLimiter((kind) => options.registry.capability(kind)));
}

/** A ProviderIO for one (kind, tenant) pair: every source read is SSRF-checked, rate-limited and logged. */
export function sourceIO(kind: string, tenantId: string): ProviderIO {
  return createProviderIO({
    providerKey: kind,
    tenantId,
    timeoutMs: options.timeoutMs,
    limiter: rateLimiter(),
    ...(options.insecureAllowLoopback ? { insecureAllowLoopback: true } : {}),
  });
}
