import { z } from 'zod';
import { MembershipRole } from './tenancy';
import { ServicePrincipalGrant } from './policy';
import { AutonomyMode } from './tenancy';

export const MembershipStatus = z.enum(['invited', 'active', 'disabled']);
export const TenantStatus = z.enum(['active', 'suspended', 'closing']);
export const UserStatus = z.enum(['active', 'disabled', 'deleted']);
export const ServicePrincipalKind = z.enum(['agent', 'api_client', 'mcp_client', 'integration']);
export const SupportSessionMode = z.enum(['read_only', 'escalated']);

export const TenantCreate = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]{3,80}$/),
});
export const MemberInvite = z.object({
  email: z.string().email(),
  role: MembershipRole,
  allBrands: z.boolean().default(false),
});
export const MemberSetRole = z.object({
  membershipId: z.string(),
  expectedVersion: z.number().int(),
  role: MembershipRole,
  allBrands: z.boolean().optional(),
});
export const BrandGrantSet = z.object({
  membershipId: z.string(),
  brandId: z.string(),
  roles: z.array(z.string()).max(10),
});
export const ServicePrincipalCreate = z.object({
  kind: ServicePrincipalKind,
  name: z.string().min(1).max(120),
  grants: z.array(ServicePrincipalGrant).max(100),
  maxAutonomy: AutonomyMode.default('create'),
});
export const ServicePrincipalRevoke = z.object({
  servicePrincipalId: z.string(),
  expectedVersion: z.number().int(),
});
/**
 * Spec 7.6 per-key scopes for API client keys (public REST, MCP and bearer tRPC calls). A scope is
 * `<area>:<read|write>`: `read` covers queries, `write` covers mutations of that area. Scopes narrow a key; they
 * never widen the service principal's grants (the policy engine still decides every action). A key with an empty
 * scope list (every key issued before scopes were enforced) keeps read access only: every `*:read`, no `*:write`,
 * and never `community:read` (customer comments and their authors are personal data: an explicit scope only).
 */
export const API_SCOPE_AREAS = [
  'access',
  'brands',
  'assets',
  'creative',
  'content',
  'review',
  'channels',
  'publications',
  'agents',
  'skills',
  'insights',
  'experiments',
  'measurement',
  'operations',
  'community',
] as const;
export type ApiScopeArea = (typeof API_SCOPE_AREAS)[number];
export const ApiScope = z.enum(
  API_SCOPE_AREAS.flatMap((a) => [`${a}:read`, `${a}:write`]) as [
    `${ApiScopeArea}:${'read' | 'write'}`,
    ...Array<`${ApiScopeArea}:${'read' | 'write'}`>,
  ],
);
export type ApiScope = z.infer<typeof ApiScope>;

export const ApiClientCreate = z.object({
  servicePrincipalId: z.string(),
  scopes: z.array(ApiScope).max(50),
  expiresAt: z.string().datetime().optional(),
});
export const ApiClientRotate = z.object({ apiClientId: z.string() });
export const ExternalLinkCreate = z.object({
  reviewRequestId: z.string(),
  email: z.string().email(),
  expiresAt: z.string().datetime(),
});
export const ExternalLinkRevoke = z.object({ linkId: z.string() });
export const SupportSessionOpen = z.object({
  tenantId: z.string(),
  reason: z.string().min(10).max(1000),
  ticketRef: z.string().min(1).max(80),
  consentRecorded: z.boolean(),
  durationMinutes: z.number().int().min(5).max(240).default(60),
});
/**
 * Spec 5.7: a support session is read-only until a second operator escalates it. The escalation is time-boxed: the
 * session's expiry becomes min(current expiry, now + durationMinutes).
 */
export const SupportSessionEscalate = z.object({
  supportSessionId: z.string(),
  reason: z.string().min(10).max(1000),
  durationMinutes: z.number().int().min(5).max(60).default(30),
});

/**
 * D-03: an identity the OpenID Connect adapter has verified (ID token signature, issuer, audience, expiry, nonce).
 * The access module decides what it may do: email_verified and the hosted-domain allowlist first, then the user it
 * resolves to. Google only authenticates; authorisation stays Oremedia's policy layer.
 */
export const IdentityProvider = z.enum(['google']);
export const VerifiedExternalIdentity = z.object({
  provider: IdentityProvider,
  subject: z.string().min(1).max(255),
  email: z.string().email().max(320).optional(),
  emailVerified: z.boolean(),
  /** Google Workspace hosted domain (`hd` claim); absent for consumer accounts. */
  hostedDomain: z.string().max(253).optional(),
  name: z.string().max(200).optional(),
});
export type VerifiedExternalIdentity = z.infer<typeof VerifiedExternalIdentity>;

/** Every reason a sign-in is refused, as recorded in auth_events.reason. */
export const SignInRefusalReason = z.enum([
  'flow_invalid', // missing, tampered or expired state/flow cookie
  'provider_error', // the provider returned an error (e.g. the person cancelled)
  'token_invalid', // code exchange or ID token validation failed (signature, iss, aud, exp, nonce)
  'email_not_verified',
  'domain_not_allowed',
  'not_invited',
  'account_disabled',
  'identity_conflict', // the user is already linked to another subject at this provider (e.g. a reassigned address)
  // First link by email (existing user, invitation, bootstrap owner) from an account Google is not authoritative
  // for: no `hd` equal to the email's domain and not a Gmail address (a consumer account on a company address).
  'email_not_authoritative',
  'internal_error', // an unexpected failure in the sign-in routes (recorded so no attempt goes unaudited)
  // Password sign-in: unknown email, no password set, or a wrong password (never told apart outside auth_events).
  'invalid_credentials',
  'link_invalid', // a password setup link that is unknown, expired, already used or no longer applicable
]);
export type SignInRefusalReason = z.infer<typeof SignInRefusalReason>;

/**
 * The code the callback passes back to the sign-in screen (`/sign-in?error=<code>`). Deliberately coarse: protocol
 * failures all read `sign_in_failed`, so the page reveals nothing an attacker could probe.
 */
export const SignInErrorCode = z.enum([
  'not_invited',
  'domain_not_allowed',
  'email_not_verified',
  'account_disabled',
  'email_not_authoritative',
  'sign_in_failed',
  'unavailable',
]);
export type SignInErrorCode = z.infer<typeof SignInErrorCode>;

export const signInErrorCodeFor = (reason: SignInRefusalReason): SignInErrorCode => {
  switch (reason) {
    case 'not_invited':
    case 'domain_not_allowed':
    case 'email_not_verified':
    case 'account_disabled':
    case 'email_not_authoritative':
      return reason;
    default:
      return 'sign_in_failed';
  }
};

/** Google issues the address itself: consumer Gmail domains. Any other domain needs a matching `hd` claim. */
export const GOOGLE_CONSUMER_DOMAINS: readonly string[] = ['gmail.com', 'googlemail.com'];

/**
 * Whether Google is authoritative for a verified email: the ID token's `hd` (Workspace hosted domain) equals the
 * email's domain, or the address is a Gmail address. A consumer Google account created on a company address has
 * email_verified=true but no `hd`; it proves control of the inbox at sign-up time only, not ownership of the domain.
 */
export function googleIsAuthoritativeFor(email: string, hostedDomain: string | undefined): boolean {
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (GOOGLE_CONSUMER_DOMAINS.includes(domain)) return true;
  return Boolean(hostedDomain) && hostedDomain?.trim().toLowerCase() === domain;
}

/**
 * Password sign-in, the second login method next to Google. Passwords are 12 to 128 characters counted after Unicode
 * NFC normalisation (the form that is hashed), with no composition rules, and must not be or contain the local part
 * of the person's email address (containment is checked from four characters, so a short local part does not rule
 * out most passwords).
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PasswordPolicyIssue = z.enum(['too_short', 'too_long', 'contains_email']);
export type PasswordPolicyIssue = z.infer<typeof PasswordPolicyIssue>;

/** The first rule a new password breaks, or null when it is acceptable. Pure: the web checks it before sending. */
export function passwordPolicyIssue(password: string, email: string | null): PasswordPolicyIssue | null {
  const normalised = password.normalize('NFC');
  const length = [...normalised].length; // code points, not UTF-16 units
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'too_long';
  const local = email
    ?.slice(0, Math.max(0, email.lastIndexOf('@')))
    .normalize('NFC')
    .toLowerCase();
  if (local) {
    const lower = normalised.toLowerCase();
    if (lower === local || (local.length >= 4 && lower.includes(local))) return 'contains_email';
  }
  return null;
}

/**
 * Request bodies of the password routes (plain Express JSON, like the Google routes). The password bound here is
 * only a request-size guard; the policy above is applied where a password is set, never at sign-in.
 */
const PasswordInput = z.string().min(1).max(1024);
export const PasswordSignIn = z.object({
  email: z.string().trim().email().max(320),
  password: PasswordInput,
});
export type PasswordSignIn = z.infer<typeof PasswordSignIn>;
export const PasswordSetup = z.object({ token: z.string().min(1).max(200), password: PasswordInput });
export type PasswordSetup = z.infer<typeof PasswordSetup>;

/**
 * What the password routes answer. Every credential failure is `invalid_credentials` (an unknown address, a user
 * without a password, a wrong password, a disabled account or a domain outside the allowlist read the same), so the
 * response never says whether an account exists. `too_many_attempts` comes with Retry-After; `password_rejected`
 * carries the policy issue.
 */
export const PasswordAuthErrorCode = z.enum([
  'invalid_credentials',
  'too_many_attempts',
  'link_invalid',
  'password_rejected',
  'origin_rejected',
  'sign_in_failed',
  'busy', // too many password hashes in flight on the server: 503 with Retry-After
]);
export type PasswordAuthErrorCode = z.infer<typeof PasswordAuthErrorCode>;
export const PasswordAuthResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: PasswordAuthErrorCode, issue: PasswordPolicyIssue.optional() }),
]);
export type PasswordAuthResponse = z.infer<typeof PasswordAuthResponse>;

/** access.account.*: the signed-in person's own password (set, change or remove). */
export const AccountSetPassword = z.object({
  /** Required when the person already has a password. */
  currentPassword: PasswordInput.optional(),
  newPassword: PasswordInput,
});
/** Removing the password needs the current one (the person has one, or there is nothing to remove). */
export const AccountRemovePassword = z.object({ currentPassword: PasswordInput });
export const AccountSignInMethods = z.object({ hasPassword: z.boolean(), hasGoogle: z.boolean() });
export type AccountSignInMethods = z.infer<typeof AccountSignInMethods>;

/**
 * access.members.issuePasswordSetup: a one-time link an owner or admin hands to a member (there is no mailer). The
 * token travels in the URL fragment, so it never reaches a server log; only its SHA-256 is stored.
 */
export const MemberIssuePasswordSetup = z.object({ membershipId: z.string() });
export const PasswordSetupLink = z.object({ url: z.string(), expiresAt: z.string().datetime() });
export type PasswordSetupLink = z.infer<typeof PasswordSetupLink>;
/** How long a password setup link stays valid. */
export const PASSWORD_SETUP_TTL_MS = 72 * 60 * 60 * 1000;
