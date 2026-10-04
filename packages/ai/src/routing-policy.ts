import { existsSync, readFileSync } from 'node:fs';
import { ModelRoutingPolicy, ModelVendor } from '@oremedia/contracts/agents';
import { PolicyDeniedError } from '@oremedia/contracts/errors';

/**
 * Spec 12.7: tenant model-routing policy (permitted vendors, inference regions, denied models), checked before
 * EVERY model call. The model id is configuration (MODEL_ROUTING_POLICY_REF / OREMEDIA_MODEL_ID), never a literal at
 * a call site. The policy document itself is a contract (packages/contracts agents: the agents router accepts it,
 * this module enforces it) and is re-exported here for existing callers.
 */
export { ModelRoutingPolicy, ModelVendor };

/** Configuration default; overridden by MODEL_ROUTING_POLICY_REF / OREMEDIA_MODEL_ID (Appendix A). */
export const DEFAULT_MODEL_ID = 'claude-opus-5';

const builtIn = (): ModelRoutingPolicy =>
  ModelRoutingPolicy.parse({
    schemaVersion: 1,
    defaultModel: DEFAULT_MODEL_ID,
    permittedVendors: ['anthropic'],
  });

/**
 * The vendor the deployment's model calls go through: OREMEDIA_MODEL_PROVIDER when set (the name modelConfigFromEnv
 * reads first), else OpenRouter wherever OPENROUTER_API_KEY_REF is set (ADR-11), else Anthropic. A service that
 * makes no model call (the api) holds no key, so it names the gateway with OREMEDIA_MODEL_PROVIDER.
 */
const gatewayOf = (env: NodeJS.ProcessEnv): string =>
  env['OREMEDIA_MODEL_PROVIDER']?.trim() || (env['OPENROUTER_API_KEY_REF'] ? 'openrouter' : 'anthropic');

/**
 * ADR-11: on the OpenRouter gateway the built-in policy permits OpenRouter and its default model must be configured
 * (OREMEDIA_MODEL_ID, an OpenRouter model id such as `vendor/model`): no model is guessed. The built-in policy
 * permits the vendor modelConfigFromEnv routes to, so the two never disagree.
 */
const builtInFor = (env: NodeJS.ProcessEnv): ModelRoutingPolicy => {
  const gateway = gatewayOf(env);
  if (gateway === 'anthropic') return builtIn();
  if (gateway !== 'openrouter')
    return ModelRoutingPolicy.parse({ ...builtIn(), permittedVendors: [gateway] });
  const model = env['OREMEDIA_MODEL_ID'];
  if (!model)
    throw new Error(
      'OREMEDIA_MODEL_ID is required on the OpenRouter gateway (OPENROUTER_API_KEY_REF or OREMEDIA_MODEL_PROVIDER=openrouter): an OpenRouter model id',
    );
  return ModelRoutingPolicy.parse({
    schemaVersion: 1,
    defaultModel: model,
    permittedVendors: ['openrouter'],
  });
};

/**
 * Whether this process is told the deployment's model route, so that modelConfigFromEnv's provider and model are
 * what the deployment runs rather than the built-in defaults: a gateway key (worker-core, worker-ingest), the
 * gateway named by OREMEDIA_MODEL_PROVIDER, or a mounted MODEL_ROUTING_POLICY_REF. The api makes no model call and
 * holds no key: without OREMEDIA_MODEL_PROVIDER (and OREMEDIA_MODEL_ID) it does not know the route, and must not
 * present the built-in Anthropic default as the model in use (docs/runbooks/deploy-railway.md).
 */
export function modelRouteConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const ref = env['MODEL_ROUTING_POLICY_REF'];
  return Boolean(
    env['OPENROUTER_API_KEY_REF'] ||
    env['ANTHROPIC_API_KEY_REF'] ||
    env['OREMEDIA_MODEL_PROVIDER']?.trim() ||
    (ref && existsSync(ref)),
  );
}

/**
 * MODEL_ROUTING_POLICY_REF names a JSON document mounted from the secret manager (a file path); when absent the
 * built-in policy applies with OREMEDIA_MODEL_ID as the default model.
 */
export function routingPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRoutingPolicy {
  const ref = env['MODEL_ROUTING_POLICY_REF'];
  const base =
    ref && existsSync(ref)
      ? ModelRoutingPolicy.parse(JSON.parse(readFileSync(ref, 'utf8')))
      : builtInFor(env);
  const modelId = env['OREMEDIA_MODEL_ID'];
  return modelId ? { ...base, defaultModel: modelId } : base;
}

/**
 * The deployment's own policy, which a tenant without a stored policy runs under: the one routingPolicyFromEnv
 * reads (a mounted MODEL_ROUTING_POLICY_REF, else the built-in policy for the configured gateway), the same
 * configuration modelConfigFromEnv picks the provider and model from. Read on first use; configureRoutingPolicy
 * replaces it (tests). Without this, an OpenRouter deployment's worker asserted provider `openrouter` against an
 * Anthropic-only default and refused every call of every company that had not stored a policy.
 */
let platformPolicy: ModelRoutingPolicy | undefined;
const platform = (): ModelRoutingPolicy => (platformPolicy ??= routingPolicyFromEnv());
/** Tests and the fake adapter run under a policy that permits the `fake` vendor. */
const tenantPolicies = new Map<string, ModelRoutingPolicy>();

/**
 * Where a tenant's own policy is stored: the composition root registers the agents module's
 * model_routing_policies reader (spec 12.7). Without one (unit tests, tools) no tenant has a stored policy.
 */
export type RoutingPolicySource = (tenantId: string) => Promise<ModelRoutingPolicy | null>;
const noStoredPolicy: RoutingPolicySource = async () => null;
let policySource: RoutingPolicySource = noStoredPolicy;

export function configureRoutingPolicy(policy: ModelRoutingPolicy): void {
  platformPolicy = ModelRoutingPolicy.parse(policy);
}
/** In-process override for tests: applies only to a tenant the registered source has no stored policy for. */
export function setTenantRoutingPolicy(tenantId: string, policy: ModelRoutingPolicy | null): void {
  if (policy) tenantPolicies.set(tenantId, ModelRoutingPolicy.parse(policy));
  else tenantPolicies.delete(tenantId);
}
export function registerRoutingPolicySource(source: RoutingPolicySource): void {
  policySource = source;
}
/** Test seam. */
export function resetRoutingPolicies(): void {
  platformPolicy = undefined;
  regionOverride = undefined;
  tenantPolicies.clear();
  policySource = noStoredPolicy;
}

/**
 * The inference region this deployment's model calls run in (OREMEDIA_MODEL_REGION, as the vendor names it), or
 * null when it is not configured. configureModelRegion overrides it (tests; the composition root if ever needed).
 */
let regionOverride: string | null | undefined;
export function configureModelRegion(region: string | null | undefined): void {
  regionOverride = region;
}
export function modelRegion(env: NodeJS.ProcessEnv = process.env): string | null {
  if (regionOverride !== undefined) return regionOverride;
  return env['OREMEDIA_MODEL_REGION']?.trim() || null;
}

export async function routingPolicyFor(tenantId: string): Promise<ModelRoutingPolicy> {
  return (await policySource(tenantId)) ?? tenantPolicies.get(tenantId) ?? platform();
}

/**
 * Throws FORBIDDEN(model_routing_denied) when the tenant's policy does not permit the vendor, model or region. The
 * region is the deployment's (modelRegion) unless a caller names one. A policy that restricts regions fails closed:
 * with no region configured it cannot be shown to hold, so the call is refused.
 */
export async function assertRoutingAllowed(
  tenantId: string,
  provider: string,
  model: string,
  region: string | null = modelRegion(),
): Promise<ModelRoutingPolicy> {
  const policy = await routingPolicyFor(tenantId);
  const denial = routeDenial(policy, provider, model, region);
  if (denial) throw new PolicyDeniedError('model_routing_denied', denial);
  return policy;
}

/**
 * Why `policy` refuses the route (vendor, model, region), or null when it permits it: the rule assertRoutingAllowed
 * enforces, also used to tell an administrator, before a policy is stored, that it would refuse the model in use.
 */
export function routeDenial(
  policy: ModelRoutingPolicy,
  provider: string,
  model: string,
  region: string | null,
): string | null {
  const vendor = ModelVendor.safeParse(provider);
  if (!vendor.success || !policy.permittedVendors.includes(vendor.data))
    return `Model vendor ${provider} is not permitted for this company`;
  if (policy.deniedModels.includes(model)) return `Model ${model} is not permitted for this company`;
  if (policy.permittedRegions.length && !region)
    return 'The inference region is not configured, so this company’s region restriction cannot be met';
  if (region && policy.permittedRegions.length && !policy.permittedRegions.includes(region))
    return `Region ${region} is not permitted for this company`;
  return null;
}
