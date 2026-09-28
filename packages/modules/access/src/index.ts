export { authenticate, resolveTenantContext, type Principal, type ResolvedTenant } from './resolve';
export { apiKeyAllows, principalHasScope } from './scopes';
export { policy, decide, assert as assertAllowed, stillHas } from './policy';
export {
  accessService,
  registerBrandChecker,
  type AuthOrigin,
  type SignInOptions,
  type SignInResult,
} from './service';
export {
  UserDirectory,
  MembershipRepository,
  BrandGrantRepository,
  ServicePrincipalRepository,
  ApiClientRepository,
  ExternalReviewerLinkRepository,
  PasswordSetupTokenRepository,
} from './repositories';
export {
  hashToken,
  newOpaqueToken,
  safeEqualHex,
  hashForAudit,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  RECENT_SIGN_IN_MS,
} from './authenticator';
export {
  CURRENT_SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  parsePasswordHash,
  PasswordHashingBusyError,
  verifyPassword,
  type ScryptParams,
} from './password';
