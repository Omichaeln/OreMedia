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
 * ADR-11: with OPENROUTER_API_KEY_REF set, the built-in policy permits the OpenRouter gateway and its default model
 * must be configured (OREMEDIA_MODEL_ID, an OpenRouter model id such as `vendor/model`): no model is guessed.
 */
const builtInFor = (env: NodeJS.ProcessEnv): ModelRoutingPolicy => {
  if (!env['OPENROUTER_API_KEY_REF']) return builtIn();
  const model = env['OREMEDIA_MODEL_ID'];
  if (!model)
    throw new Error('OREMEDIA_MODEL_ID is required with OPENROUTER_API_KEY_REF (an OpenRouter model id)');
  return ModelRoutingPolicy.parse({
    schemaVersion: 1,
    defaultModel: model,
    permittedVendors: ['openrouter'],
  });
};

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

let platformPolicy: ModelRoutingPolicy = builtIn();
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
  platformPolicy = builtIn();
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
  return (await policySource(tenantId)) ?? tenantPolicies.get(tenantId) ?? platformPolicy;
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
  const vendor = ModelVendor.safeParse(provider);
  if (!vendor.success || !policy.permittedVendors.includes(vendor.data))
    throw new PolicyDeniedError(
      'model_routing_denied',
      `Model vendor ${provider} is not permitted for this company`,
    );
  if (policy.deniedModels.includes(model))
    throw new PolicyDeniedError('model_routing_denied', `Model ${model} is not permitted for this company`);
  if (policy.permittedRegions.length && !region)
    throw new PolicyDeniedError(
      'model_routing_denied',
      'The inference region is not configured, so this company’s region restriction cannot be met',
    );
  if (region && policy.permittedRegions.length && !policy.permittedRegions.includes(region))
    throw new PolicyDeniedError('model_routing_denied', `Region ${region} is not permitted for this company`);
  return policy;
}
