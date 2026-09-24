export { authenticate, resolveTenantContext, type Principal, type ResolvedTenant } from './resolve';
export { apiKeyAllows, principalHasScope } from './scopes';
export { policy, decide, assert as assertAllowed, stillHas } from './policy';
export { accessService, registerBrandChecker, type AuthOrigin, type SignInResult } from './service';
export {
  UserDirectory,
  MembershipRepository,
  BrandGrantRepository,
  ServicePrincipalRepository,
  ApiClientRepository,
  ExternalReviewerLinkRepository,
} from './repositories';
export {
  hashToken,
  newOpaqueToken,
  safeEqualHex,
  hashForAudit,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from './authenticator';
