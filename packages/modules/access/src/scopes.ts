import type { ApiScope, ApiScopeArea } from '@oremedia/contracts/access';
import type { Principal } from './resolve';

/**
 * Spec 7.6 per-key scopes. Only API client keys carry scopes; sessions, reviewer links and support sessions are
 * governed by the policy engine alone. A key with an empty scope list keeps read access (`*:read`) so keys issued
 * before enforcement keep working for reads, except the areas in EXPLICIT_READ_AREAS; a stored value outside the
 * vocabulary grants nothing.
 */
/**
 * Areas added after scopes were enforced whose reads carry personal data (customer comments and their authors):
 * a key reads them only with the explicit scope, never through the empty-list legacy read access.
 */
export const EXPLICIT_READ_AREAS: ReadonlySet<ApiScopeArea> = new Set<ApiScopeArea>(['community']);

export function apiKeyAllows(scopes: readonly string[], required: ApiScope): boolean {
  if (scopes.length === 0)
    return required.endsWith(':read') && !EXPLICIT_READ_AREAS.has(required.split(':')[0] as ApiScopeArea);
  return scopes.includes(required);
}

/** True when the principal may use a surface that requires `required` (non-key principals are not scoped). */
export function principalHasScope(principal: Principal, required: ApiScope): boolean {
  return principal.kind !== 'api_client' || apiKeyAllows(principal.scopes, required);
}
