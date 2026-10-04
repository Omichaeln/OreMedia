import type { z } from 'zod';
import {
  AccountRemovePassword,
  AccountSetPassword,
  ApiClientCreate,
  ApiClientRotate,
  BrandGrantRemove,
  BrandGrantSet,
  ExternalLinkCreate,
  ExternalLinkRevoke,
  MemberDisable,
  MemberEnable,
  MemberInvite,
  MemberIssuePasswordSetup,
  MemberSetRole,
  PASSWORD_SETUP_TTL_MS,
  PasswordSetup,
  PasswordSignIn,
  ServicePrincipalCreate,
  ServicePrincipalList,
  ServicePrincipalRevoke,
  SupportSessionEscalate,
  SupportSessionOpen,
  TenantCreate,
  VerifiedExternalIdentity,
  googleIsAuthoritativeFor,
  passwordPolicyIssue,
  type AccountSignInMethods,
  type MemberStatusResult,
  type PasswordSetupLink,
  type SignInRefusalReason,
  type TenantKind,
} from '@oremedia/contracts/access';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, runAsPlatform, runInTenant, withTransaction, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { DEFAULT_ROLE_GRANTS } from '@oremedia/domain/role-grants';
import { audit, outbox } from '@oremedia/module-operations';
import {
  ApiClientRepository,
  BrandGrantRepository,
  ExternalReviewerLinkRepository,
  MembershipRepository,
  PasswordSetupTokenRepository,
  ServicePrincipalRepository,
  SupportSessionRepository,
  UserDirectory,
} from './repositories';
import { RECENT_SIGN_IN_MS, SESSION_ABSOLUTE_MS, hashToken, newOpaqueToken } from './authenticator';
import { hashPassword, needsRehash, verifyPassword } from './password';
import { policy } from './policy';

const directory = new UserDirectory();
const membershipsRepo = new MembershipRepository();
const grantsRepo = new BrandGrantRepository();
const principalsRepo = new ServicePrincipalRepository();
const apiClientsRepo = new ApiClientRepository();
const linksRepo = new ExternalReviewerLinkRepository();
const supportSessionsRepo = new SupportSessionRepository();
const passwordSetupRepo = new PasswordSetupTokenRepository();

/** auth_events.provider for the password sign-in method (Google identities use their provider name). */
const PASSWORD_PROVIDER = 'password';

const tenantResource = (actor: ResolvedActor) => ({
  type: 'tenant',
  tenantId: actor.tenantId,
  id: actor.tenantId,
});

/** Brand existence is owned by the brand module; the composition root registers its checker here (no table sharing). */
type BrandChecker = {
  assertExist(brandIds: string[], tx?: Tx): Promise<void>;
  assertValidGrantBrands(brandIds: string[], tx?: Tx): Promise<void>;
};
let brandChecker: BrandChecker | null = null;
export const registerBrandChecker = (c: BrandChecker): void => {
  brandChecker = c;
};
const brands = (): BrandChecker => {
  if (!brandChecker)
    throw new Error('brand checker not registered (composition root must call registerBrandChecker)');
  return brandChecker;
};

/** Where a sign-in or sign-out request came from, as the audit trail records it (salted hashes, never raw). */
export interface AuthOrigin {
  correlationId: string;
  ipHash: string | null;
  userAgentHash: string | null;
}

export type SignInResult =
  | { ok: true; userId: string; sessionId: string; token: string; expiresAt: Date }
  | { ok: false; reason: SignInRefusalReason };

/** Raised inside the sign-in transaction so the whole attempt rolls back; mapped to identity_conflict. */
class IdentityConflict extends Error {
  constructor(readonly userId: string) {
    super('identity_conflict');
  }
}

const isDuplicateKeyError = (err: unknown): boolean =>
  (err as { code?: string } | undefined)?.code === 'ER_DUP_ENTRY' ||
  (err as { cause?: { code?: string } } | undefined)?.cause?.code === 'ER_DUP_ENTRY';

type Resolution =
  | { refused: SignInRefusalReason; userId: string | null }
  | { refused: null; userId: string; sessionId: string; token: string; expiresAt: Date };

const authEvent = (
  origin: AuthOrigin,
  values: {
    action:
      | 'auth.sign_in'
      | 'auth.identity_link'
      | 'auth.sign_out'
      | 'auth.password_set'
      | 'auth.password_remove'
      | 'auth.password_setup';
    provider: string;
    reason?: SignInRefusalReason | null;
    userId?: string | null;
    sessionId?: string | null;
  },
) => ({
  id: newId('authEvent'),
  action: values.action,
  provider: values.provider,
  decision: values.reason ? ('denied' as const) : ('allowed' as const),
  reason: values.reason ?? null,
  userId: values.userId ?? null,
  sessionId: values.sessionId ?? null,
  correlationId: origin.correlationId,
  ipHash: origin.ipHash,
  userAgentHash: origin.userAgentHash,
});

type UserActor = Extract<ResolvedActor, { kind: 'user' }>;

/**
 * Membership, brand-grant and API-key changes outlive the request that makes them, so only a person of the company
 * makes them: never an agent, and never a support session (an escalated one is time-boxed; what it grants is not).
 */
function requirePerson(actor: ResolvedActor, message: string): UserActor {
  if (actor.kind !== 'user') throw new PolicyDeniedError('agent_never', message);
  return actor;
}

/**
 * The brand scope a member hands out never exceeds their own: every brand (`allBrands`, a grant on `'all'`) only from
 * an owner or a member who sees every brand; a named brand only from someone who sees it (NOT_FOUND otherwise, as
 * brand.get answers for a brand the caller cannot see).
 */
function assertBrandScopeWithin(
  actor: UserActor,
  scope: { allBrands?: boolean; brandIds?: readonly string[] },
): void {
  if (actor.role === 'owner' || actor.allBrands) return;
  if (scope.allBrands)
    throw new PolicyDeniedError(
      'all_brands_required',
      'Only an owner or a member with access to every brand can grant every brand',
    );
  const visible = new Set(actor.brandGrants.map((g) => g.brandId));
  const hidden = scope.brandIds?.find((b) => !visible.has(b));
  if (hidden) throw new NotFoundError('Brand', hidden);
}

/** The brands a service principal's grants reach, in the shape assertBrandScopeWithin takes. */
const grantsBrandScope = (grants: ReadonlyArray<{ brandIds: 'all' | string[] }>) => ({
  allBrands: grants.some((g) => g.brandIds === 'all'),
  brandIds: [...new Set(grants.flatMap((g) => (g.brandIds === 'all' ? [] : g.brandIds)))],
});

/** Brand-level roles that manage members: only an owner grants them, as only an owner makes an owner or admin. */
const MEMBER_MANAGING_ROLES: readonly string[] = DEFAULT_ROLE_GRANTS['membership.manage'];

type MembershipRow = Awaited<ReturnType<UserDirectory['allMembershipsOfUser']>>[number];
type UserRow = NonNullable<Awaited<ReturnType<UserDirectory['findById']>>>;

const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** Every membership of a user, and the invitations a sign-in as `email` accepts (only those sent to that address). */
async function invitationsFor(userId: string, email: string, tx: Tx) {
  const memberships = await directory.allMembershipsOfUser(userId, tx);
  const invitations = memberships.filter(
    (m) => m.status === 'invited' && m.invitedEmail?.toLowerCase() === email,
  );
  return { memberships, invitations };
}

/**
 * inviteMember creates a disabled placeholder user for an unknown email; the first sign-in claims it only while it
 * has never been used: no linked identity and nothing but invitations.
 */
const isClaimablePlaceholder = (
  user: UserRow,
  memberships: MembershipRow[],
  invitations: MembershipRow[],
  linked: boolean,
): boolean =>
  !linked &&
  user.status === 'disabled' &&
  invitations.length > 0 &&
  memberships.every((m) => m.status === 'invited');

/**
 * A password chosen through a setup link (by whoever held the link: possibly the admin who issued it) is confined to
 * the issuing company. Once the person is an active member of a second company it is cleared, and every session of
 * theirs ends (one might have been opened with it); they sign in with Google, or set their own password.
 * Only live companies count: a demo workspace is the person's own sandbox, provisioned by the system with nobody
 * else's data in it, so opening one must not sign them out or remove their password. A second live company still
 * clears it, whatever demo workspaces the person also has.
 */
async function confineSetupLinkPassword(userId: string, origin: AuthOrigin, tx: Tx): Promise<void> {
  const active = await directory.activeCompaniesOfUser(userId, tx);
  const companies = new Set(active.filter((c) => c.kind === 'live').map((c) => c.tenantId));
  if (companies.size < 2 || !(await directory.clearSetupLinkPassword(userId, tx))) return;
  await directory.revokeSessionsForUser(userId, tx);
  await directory.recordAuthEvent(
    authEvent(origin, { action: 'auth.password_remove', provider: PASSWORD_PROVIDER, userId }),
    tx,
  );
}

/**
 * What every successful sign-in does once a method (Google, a password, a password setup link) has resolved the
 * person, inside that method's transaction: accept the invitations sent to their address, end the session this
 * browser held (rotation: never an orphan either way), mint a new opaque session and record auth.sign_in.
 */
async function completeSignIn(
  userId: string,
  invitations: MembershipRow[],
  provider: string,
  replaces: { userId: string; sessionId: string } | null | undefined,
  origin: AuthOrigin,
  tx: Tx,
): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  for (const m of invitations)
    await runInTenant(
      {
        tenantId: m.tenantId,
        actor: { kind: 'user', id: userId },
        brandIds: new Set<string>(),
        correlationId: origin.correlationId,
      },
      async () => {
        await membershipsRepo.update(m.id, m.version, { status: 'active' }, tx);
        await audit.record(
          { kind: 'user', id: userId },
          'membership.accept',
          { type: 'membership', id: m.id },
          'allowed',
          tx,
          { fromState: 'invited', toState: 'active' },
        );
        await outbox.add(
          'membership.changed',
          { type: 'membership', id: m.id, version: m.version + 1 },
          { membershipId: m.id, change: 'accepted' },
          tx,
        );
      },
    );
  if (invitations.length) await confineSetupLinkPassword(userId, origin, tx);
  if (replaces) {
    await directory.revokeSession(replaces.sessionId, tx);
    await directory.recordAuthEvent(
      authEvent(origin, {
        action: 'auth.sign_out',
        provider: 'session',
        userId: replaces.userId,
        sessionId: replaces.sessionId,
      }),
      tx,
    );
  }
  const now = new Date();
  const { token, hash } = newOpaqueToken('ses');
  const sessionId = newId('session');
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  await directory.createSession(
    {
      id: sessionId,
      userId,
      tokenHash: hash,
      selectedTenantId: null,
      expiresAt,
      ipHash: origin.ipHash,
      userAgentHash: origin.userAgentHash,
      lastSeenAt: now,
    },
    tx,
  );
  await directory.recordAuthEvent(
    authEvent(origin, { action: 'auth.sign_in', provider, userId, sessionId }),
    tx,
  );
  return { sessionId, token, expiresAt };
}

/** Options every sign-in method takes: the Workspace/email domain allowlist and the session the browser held. */
export interface SignInOptions {
  allowedDomains: readonly string[] | null;
  /** The session this browser held before: ended in the same transaction that creates the new one. */
  replaces?: { userId: string; sessionId: string } | null;
}

/**
 * The membership a disable or enable names, after the rules both share: membership.manage, a person (never an agent or
 * a support session), never your own membership, and an owner or admin only by an owner.
 */
async function loadManageableMember(
  actor: ResolvedActor,
  membershipId: string,
  verb: 'disable' | 'enable',
  tx: Tx,
) {
  await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
  if (actor.kind !== 'user') throw new PolicyDeniedError('agent_never', `Only a person can ${verb} a member`);
  const m = await membershipsRepo.getById(membershipId, tx);
  if (m.userId === actor.id)
    throw new PolicyDeniedError(`self_${verb}`, `You cannot ${verb} your own membership`);
  if (DEFAULT_ROLE_GRANTS['membership.manage'].includes(m.role) && actor.role !== 'owner')
    throw new PolicyDeniedError('owner_required', `Only an owner can ${verb} an owner or admin`);
  return m;
}

/**
 * Never leaves the company without an active owner: refuses a change that takes owner status from `membershipId` (a
 * demotion or a disable) when no other active owner remains. The active owners are row-locked first (same
 * transaction as the change), so two such changes on the last two owners cannot both commit.
 */
async function assertAnotherActiveOwner(membershipId: string, tx: Tx) {
  const owners = await membershipsRepo.lockActiveOwners(tx);
  if (!owners.some((o) => o.id !== membershipId))
    throw new PolicyDeniedError('last_owner', 'The company must keep at least one active owner');
}

/** The audit event and outbox message of a membership status change, and what the procedure answers. */
async function recordMemberStatus(
  actor: ResolvedActor,
  membershipId: string,
  expectedVersion: number,
  fromState: 'active' | 'disabled',
  toState: 'active' | 'disabled',
  tx: Tx,
): Promise<MemberStatusResult> {
  await audit.record(
    { kind: actor.kind, id: actor.id },
    toState === 'disabled' ? 'membership.disable' : 'membership.enable',
    { type: 'membership', id: membershipId },
    'allowed',
    tx,
    { fromState, toState },
  );
  await outbox.add(
    'membership.changed',
    { type: 'membership', id: membershipId, version: expectedVersion + 1 },
    { membershipId, change: toState === 'disabled' ? 'disabled' : 'enabled' },
    tx,
  );
  return { membershipId, status: toState, version: expectedVersion + 1 };
}

export const accessService = {
  /**
   * Bootstrap: creates a tenant and its owner membership. Called by sign-up, outside any tenant context. `kind` is
   * fixed here for the tenant's lifetime (`live` unless a system path provisions a demo workspace); it is not part
   * of TenantCreate, so no request can choose it.
   */
  async createTenantWithOwner(
    input: z.infer<typeof TenantCreate>,
    ownerUserId: string,
    correlationId: string,
    outer?: Tx,
    kind: TenantKind = 'live',
  ): Promise<{ tenantId: string; membershipId: string }> {
    const parsed = TenantCreate.parse(input);
    const tenantId = newId('tenant');
    const membershipId = newId('membership');
    await runAsPlatform('tenant-bootstrap', correlationId, () =>
      withTransaction(outer, async (tx) => {
        await directory.createTenant({ id: tenantId, name: parsed.name, slug: parsed.slug, kind }, tx);
        await directory.createMembership(
          {
            id: membershipId,
            tenantId,
            userId: ownerUserId,
            role: 'owner',
            status: 'active',
            allBrands: true,
          },
          tx,
        );
        // An existing user becoming owner of a second live company: a setup-link password does not follow them.
        await confineSetupLinkPassword(ownerUserId, { correlationId, ipHash: null, userAgentHash: null }, tx);
      }),
    );
    return { tenantId, membershipId };
  },

  /**
   * D-03 sign-in. `input` is an identity the OIDC adapter has already verified (signature, issuer, audience, expiry,
   * nonce). Resolution, in order: email must be verified and (when configured) the Workspace domain allowed; then
   * the linked identity (provider, subject) → its user; else the active user with that email → linked; else an
   * unclaimed invitation for that email → the placeholder user is activated and linked; else refused (there is no
   * self-sign-up). Pending invitations for the verified email are accepted on every successful sign-in. A new
   * opaque session is minted every time. Every outcome, allowed or refused, is written to auth_events.
   */
  async signInWithExternalIdentity(
    input: VerifiedExternalIdentity,
    opts: SignInOptions,
    origin: AuthOrigin,
  ): Promise<SignInResult> {
    const identity = VerifiedExternalIdentity.parse(input);
    const { provider, subject } = identity;
    const refuse = async (
      reason: SignInRefusalReason,
      userId: string | null = null,
    ): Promise<SignInResult> => {
      await accessService.recordSignInRefusal(provider, reason, origin, userId);
      return { ok: false, reason };
    };
    const email = identity.email?.trim().toLowerCase();
    if (!identity.emailVerified || !email) return refuse('email_not_verified');
    if (opts.allowedDomains?.length) {
      const hd = identity.hostedDomain?.trim().toLowerCase();
      if (!hd || !opts.allowedDomains.includes(hd)) return refuse('domain_not_allowed');
    }
    let resolution: Resolution;
    try {
      resolution = await runAsPlatform('sign-in', origin.correlationId, () =>
        withTransaction(async (tx): Promise<Resolution> => {
          const linked = await directory.identityFor(provider, subject, tx);
          // A first link by email (existing user, invitation, bootstrap owner) needs Google to be authoritative for
          // the address; a consumer account created on a company address must not take over that person's user.
          if (!linked && !googleIsAuthoritativeFor(email, identity.hostedDomain))
            return { refused: 'email_not_authoritative', userId: null };
          const found = linked
            ? await directory.findById(linked.userId, tx)
            : await directory.findByEmail(email, tx);
          // users.email uses utf8mb4_0900_ai_ci (case- and accent-insensitive): only the exact address links.
          const candidate = found && (linked || found.email.toLowerCase() === email) ? found : null;
          if (!candidate) return { refused: linked ? 'account_disabled' : 'not_invited', userId: null };
          // Concurrent first sign-ins resolving to one user are serialised here; the checks below read fresh rows.
          const user = await directory.lockUser(candidate.id, tx);
          if (!user) return { refused: 'account_disabled', userId: null };
          let alreadyLinked = Boolean(linked);
          if (!linked) {
            // A person already linked to another subject is not re-linked by email: a reassigned Workspace address
            // must not inherit the previous holder's account.
            const existing = await directory.identityOfUser(provider, user.id, tx);
            if (existing && existing.subject !== subject)
              return { refused: 'identity_conflict', userId: user.id };
            alreadyLinked = Boolean(existing); // the same subject, linked by a concurrent sign-in
          }
          const { memberships, invitations } = await invitationsFor(user.id, email, tx);
          const claimPlaceholder = isClaimablePlaceholder(user, memberships, invitations, alreadyLinked);
          if (user.status !== 'active' && !claimPlaceholder)
            return { refused: 'account_disabled', userId: user.id };

          if (claimPlaceholder) await directory.activateUser(user.id, identity.name ?? user.name, tx);
          if (!alreadyLinked) {
            try {
              await directory.linkIdentity(
                { id: newId('externalIdentity'), provider, subject, userId: user.id, emailAtLink: email },
                tx,
              );
            } catch (err) {
              // uq_external_identity_user: another subject won a race the lock did not cover. Roll back everything.
              if (isDuplicateKeyError(err)) throw new IdentityConflict(user.id);
              throw err;
            }
            await directory.recordAuthEvent(
              authEvent(origin, { action: 'auth.identity_link', provider, userId: user.id }),
              tx,
            );
          }
          const session = await completeSignIn(user.id, invitations, provider, opts.replaces, origin, tx);
          return { refused: null, userId: user.id, ...session };
        }),
      );
    } catch (err) {
      if (err instanceof IdentityConflict) return refuse('identity_conflict', err.userId);
      throw err;
    }
    if (resolution.refused) return refuse(resolution.refused, resolution.userId);
    const { userId, sessionId, token, expiresAt } = resolution;
    return { ok: true, userId, sessionId, token, expiresAt };
  },

  /**
   * Password sign-in, the second login method. The address resolves to an active user whose stored scrypt hash
   * matches; every other case (unknown address, no password, wrong password, disabled user, a domain outside the
   * allowlist) is refused with a reason recorded only in auth_events, and the caller answers them all alike. One
   * scrypt runs whether or not the account exists, so timing does not reveal it either. On success the hash is
   * upgraded when it was made with weaker parameters, and the shared post-sign-in steps run (invitations, rotation,
   * session). The per-account lockout is the caller's (apps/api keeps it in the rate limiter's store).
   */
  async signInWithPassword(
    input: PasswordSignIn,
    opts: SignInOptions,
    origin: AuthOrigin,
  ): Promise<SignInResult> {
    const parsed = PasswordSignIn.parse(input);
    const email = parsed.email.toLowerCase();
    const refuse = async (reason: SignInRefusalReason, userId: string | null): Promise<SignInResult> => {
      await accessService.recordSignInRefusal(PASSWORD_PROVIDER, reason, origin, userId);
      return { ok: false, reason };
    };
    const found = await runAsPlatform('sign-in', origin.correlationId, () => directory.findByEmail(email));
    // users.email uses an accent-insensitive collation: only the exact address is this person.
    const user = found && found.email.toLowerCase() === email ? found : null;
    const stored = user?.passwordHash ?? null;
    if (!(await verifyPassword(parsed.password, stored)) || !user || !stored)
      return refuse('invalid_credentials', user?.id ?? null);
    if (user.status !== 'active') return refuse('account_disabled', user.id);
    if (opts.allowedDomains?.length && !opts.allowedDomains.includes(emailDomain(email)))
      return refuse('domain_not_allowed', user.id);
    // Hashed before the transaction so the users row is not locked for the length of a scrypt.
    const upgraded = needsRehash(stored) ? await hashPassword(parsed.password) : null;
    const resolution = await runAsPlatform('sign-in', origin.correlationId, () =>
      withTransaction(async (tx): Promise<Resolution> => {
        const locked = await directory.lockUser(user.id, tx);
        if (!locked || locked.status !== 'active') return { refused: 'account_disabled', userId: user.id };
        // The password changed (or was removed) since it was checked: the credentials presented are stale.
        if (locked.passwordHash !== stored) return { refused: 'invalid_credentials', userId: user.id };
        if (upgraded) await directory.upgradePasswordHash(user.id, stored, upgraded, tx);
        // A password from a setup link never brings the person into another company: it may have been chosen by
        // the admin who issued the link. Invitations wait for Google, or for a password the person set themselves.
        const invitations =
          locked.passwordOrigin === 'setup_link'
            ? []
            : (await invitationsFor(user.id, email, tx)).invitations;
        const session = await completeSignIn(
          user.id,
          invitations,
          PASSWORD_PROVIDER,
          opts.replaces,
          origin,
          tx,
        );
        return { refused: null, userId: user.id, ...session };
      }),
    );
    if (resolution.refused) return refuse(resolution.refused, resolution.userId);
    const { userId, sessionId, token, expiresAt } = resolution;
    return { ok: true, userId, sessionId, token, expiresAt };
  },

  /**
   * Redeems a one-time password setup link (issuePasswordSetup): sets the password, marks the link used and signs the
   * person in. It is also the reset path: an owner or admin issues a new link. The link applies only while the person
   * still belongs to the issuing company alone, as a member that is not disabled, and while the issuer may still
   * manage members there (a link for an owner or admin only from an owner; never the issuer's own). The password is recorded as
   * chosen through a link (`setup_link`) until the person changes it themselves. An invitation placeholder is claimed exactly as a
   * first Google sign-in claims it, and the invitations sent to the address are accepted. Every other session of the
   * person ends: whoever held the old credentials is signed out. A password that breaks the policy is refused before
   * the link is used (VALIDATION_FAILED, path `password`), so the person can try again with the same link.
   */
  async redeemPasswordSetup(
    input: PasswordSetup,
    opts: SignInOptions,
    origin: AuthOrigin,
  ): Promise<SignInResult> {
    const parsed = PasswordSetup.parse(input);
    const tokenHash = hashToken(parsed.token);
    const refuse = async (reason: SignInRefusalReason, userId: string | null): Promise<SignInResult> => {
      await accessService.recordSignInRefusal(PASSWORD_PROVIDER, reason, origin, userId);
      return { ok: false, reason };
    };
    const now = new Date();
    const pending = await runAsPlatform('password-setup', origin.correlationId, async () => {
      const link = await directory.passwordSetupByTokenHash(tokenHash);
      return link ? { link, user: await directory.findById(link.userId) } : null;
    });
    if (!pending?.user || pending.link.usedAt || pending.link.expiresAt <= now)
      return refuse('link_invalid', pending?.user?.id ?? null);
    const { link, user } = pending;
    const issue = passwordPolicyIssue(parsed.password, user.email);
    if (issue) throw new ValidationFailedError([{ path: 'password', issue }]);
    const email = user.email.toLowerCase();
    if (opts.allowedDomains?.length && !opts.allowedDomains.includes(emailDomain(email)))
      return refuse('domain_not_allowed', user.id);
    const passwordHash = await hashPassword(parsed.password);

    const resolution = await runAsPlatform('password-setup', origin.correlationId, () =>
      withTransaction(async (tx): Promise<Resolution> => {
        const refused = (reason: SignInRefusalReason): Resolution => ({ refused: reason, userId: user.id });
        // Locking read: a second redemption of the same link waits here and then finds it used.
        const current = await directory.passwordSetupByTokenHash(tokenHash, tx, true);
        if (!current || current.id !== link.id) return refused('link_invalid');
        const locked = await directory.lockUser(user.id, tx);
        if (!locked || locked.email.toLowerCase() !== email) return refused('link_invalid');
        const { memberships, invitations } = await invitationsFor(locked.id, email, tx);
        const here = memberships.find((m) => m.tenantId === current.tenantId);
        // An admin of one company must never set the password of someone who can also reach another company.
        if (!here || here.status === 'disabled' || memberships.some((m) => m.tenantId !== current.tenantId))
          return refused('link_invalid');
        const issuer = await directory.membershipFor(current.createdByUserId, current.tenantId, tx);
        const issuerRole = issuer?.membership.status === 'active' ? issuer.membership.role : null;
        if (
          !issuerRole ||
          !DEFAULT_ROLE_GRANTS['membership.manage'].includes(issuerRole) ||
          (DEFAULT_ROLE_GRANTS['membership.manage'].includes(here.role) && issuerRole !== 'owner') ||
          current.createdByUserId === locked.id
        )
          return refused('link_invalid');
        const linked = (await directory.identitiesOfUser(locked.id, tx)).length > 0;
        const claim = isClaimablePlaceholder(locked, memberships, invitations, linked);
        if (locked.status !== 'active' && !claim) return refused('account_disabled');
        if (!(await directory.consumePasswordSetup(current.id, now, tx))) return refused('link_invalid');

        if (claim) await directory.activateUser(locked.id, locked.name, tx);
        await directory.setPasswordHash(locked.id, { hash: passwordHash, origin: 'setup_link' }, tx);
        await directory.revokeSessionsForUser(locked.id, tx);
        await directory.recordAuthEvent(
          authEvent(origin, {
            action: 'auth.password_setup',
            provider: PASSWORD_PROVIDER,
            userId: locked.id,
          }),
          tx,
        );
        await runInTenant(
          {
            tenantId: current.tenantId,
            actor: { kind: 'user', id: locked.id },
            brandIds: new Set<string>(),
            correlationId: origin.correlationId,
          },
          () =>
            audit.record(
              { kind: 'user', id: locked.id },
              'membership.password_setup_redeem',
              { type: 'membership', id: here.id },
              'allowed',
              tx,
            ),
        );
        const session = await completeSignIn(
          locked.id,
          invitations,
          PASSWORD_PROVIDER,
          opts.replaces,
          origin,
          tx,
        );
        return { refused: null, userId: locked.id, ...session };
      }),
    );
    if (resolution.refused) return refuse(resolution.refused, resolution.userId);
    const { userId, sessionId, token, expiresAt } = resolution;
    return { ok: true, userId, sessionId, token, expiresAt };
  },

  /** The sign-in methods of the signed-in person (Settings → Account): a password, a linked Google identity. */
  async accountSignInMethods(userId: string, correlationId: string): Promise<AccountSignInMethods> {
    return runAsPlatform('account', correlationId, async () => {
      const user = await directory.findById(userId);
      if (!user) throw new NotFoundError('User', userId);
      const identities = await directory.identitiesOfUser(userId);
      return {
        hasPassword: Boolean(user.passwordHash),
        hasGoogle: identities.some((i) => i.provider === 'google'),
      };
    });
  },

  /**
   * Sets or changes the signed-in person's own password. Changing one needs the current password (VALIDATION_FAILED
   * `currentPassword`: `required` or `incorrect`); setting a first one needs a session created within the last 15
   * minutes (`session`: `recent_sign_in_required`); the new one must meet the policy (`newPassword`). Every other
   * session of the person ends; the one that made the change stays. Recorded in auth_events (no tenant: a person's
   * password is not a company's).
   */
  async setPassword(
    principal: { userId: string; sessionId: string },
    input: z.infer<typeof AccountSetPassword>,
    origin: AuthOrigin,
  ): Promise<{ ok: true }> {
    const parsed = AccountSetPassword.parse(input);
    const user = await runAsPlatform('account', origin.correlationId, () =>
      directory.findById(principal.userId),
    );
    if (!user || user.status !== 'active') throw new NotFoundError('User', principal.userId);
    if (!user.passwordHash) {
      const session = await runAsPlatform('account', origin.correlationId, () =>
        directory.sessionById(principal.sessionId),
      );
      if (!session || session.createdAt.getTime() < Date.now() - RECENT_SIGN_IN_MS)
        throw new ValidationFailedError(
          [{ path: 'session', issue: 'recent_sign_in_required' }],
          'Sign in again to set a password',
        );
    } else {
      if (!parsed.currentPassword)
        throw new ValidationFailedError([{ path: 'currentPassword', issue: 'required' }]);
      if (!(await verifyPassword(parsed.currentPassword, user.passwordHash)))
        throw new ValidationFailedError([{ path: 'currentPassword', issue: 'incorrect' }]);
    }
    const issue = passwordPolicyIssue(parsed.newPassword, user.email);
    if (issue) throw new ValidationFailedError([{ path: 'newPassword', issue }]);
    const passwordHash = await hashPassword(parsed.newPassword);
    await runAsPlatform('account', origin.correlationId, () =>
      withTransaction(async (tx) => {
        const locked = await directory.lockUser(user.id, tx);
        // Changed by another request since it was verified: this one must not overwrite it.
        if (!locked || locked.passwordHash !== user.passwordHash)
          throw new ConflictError('User', user.id, user.version);
        // Knowing a setup-link password proves only that the caller held the link (possibly the admin who issued
        // it), so a change keeps it confined to the issuing company. A first password is the person's own only from
        // a session not opened with a password: one opened with a setup-link password that was then removed must
        // not launder it into a password of their own.
        const confined =
          locked.passwordOrigin === 'setup_link' ||
          (!locked.passwordHash &&
            (await directory.signInProviderOfSession(user.id, principal.sessionId, tx)) ===
              PASSWORD_PROVIDER);
        await directory.setPasswordHash(
          user.id,
          { hash: passwordHash, origin: confined ? 'setup_link' : 'self' },
          tx,
        );
        await directory.revokeOtherSessionsForUser(user.id, principal.sessionId, tx);
        await directory.recordAuthEvent(
          authEvent(origin, {
            action: 'auth.password_set',
            provider: PASSWORD_PROVIDER,
            userId: user.id,
            sessionId: principal.sessionId,
          }),
          tx,
        );
      }),
    );
    return { ok: true };
  },

  /**
   * Removes the signed-in person's password, leaving Google as their sign-in method. It needs the current password
   * (VALIDATION_FAILED `currentPassword`: `incorrect`), and is refused when no external identity is linked
   * (`password`: `only_sign_in_method`): nobody can lock themselves out.
   */
  async removePassword(
    principal: { userId: string; sessionId: string },
    input: z.infer<typeof AccountRemovePassword>,
    origin: AuthOrigin,
  ): Promise<{ ok: true }> {
    const parsed = AccountRemovePassword.parse(input);
    const user = await runAsPlatform('account', origin.correlationId, () =>
      directory.findById(principal.userId),
    );
    if (!user || user.status !== 'active') throw new NotFoundError('User', principal.userId);
    // One scrypt whether or not there is a password, like sign-in.
    if (!(await verifyPassword(parsed.currentPassword, user.passwordHash)))
      throw new ValidationFailedError([{ path: 'currentPassword', issue: 'incorrect' }]);
    await runAsPlatform('account', origin.correlationId, () =>
      withTransaction(async (tx) => {
        const locked = await directory.lockUser(user.id, tx);
        if (!locked || locked.passwordHash !== user.passwordHash)
          throw new ConflictError('User', user.id, user.version);
        if ((await directory.identitiesOfUser(locked.id, tx)).length === 0)
          throw new ValidationFailedError([{ path: 'password', issue: 'only_sign_in_method' }]);
        await directory.setPasswordHash(locked.id, null, tx);
        // Sessions opened with the password end with it (it may be why it is being removed); this one stays.
        await directory.revokeOtherSessionsForUser(locked.id, principal.sessionId, tx);
        await directory.recordAuthEvent(
          authEvent(origin, {
            action: 'auth.password_remove',
            provider: PASSWORD_PROVIDER,
            userId: locked.id,
            sessionId: principal.sessionId,
          }),
          tx,
        );
      }),
    );
    return { ok: true };
  },

  /** A refused sign-in, on its own connection (nothing else of the attempt is written). */
  async recordSignInRefusal(
    provider: string,
    reason: SignInRefusalReason,
    origin: AuthOrigin,
    userId: string | null = null,
  ): Promise<void> {
    await runAsPlatform('sign-in', origin.correlationId, () =>
      directory.recordAuthEvent(authEvent(origin, { action: 'auth.sign_in', provider, reason, userId })),
    );
  },

  /** Revokes the caller's own browser session (the token stops authenticating on the next request). */
  async signOut(principal: { userId: string; sessionId: string }, origin: AuthOrigin): Promise<void> {
    await runAsPlatform('sign-out', origin.correlationId, () =>
      withTransaction(async (tx) => {
        await directory.revokeSession(principal.sessionId, tx);
        await directory.recordAuthEvent(
          authEvent(origin, {
            action: 'auth.sign_out',
            provider: 'session',
            userId: principal.userId,
            sessionId: principal.sessionId,
          }),
          tx,
        );
      }),
    );
  },

  /**
   * Sign-out inside a support session (spec 5.7): the support session is closed (its `sup_` bearer stops working on
   * the next request), audited in the tenant's own trail, and recorded in auth_events. The operator's underlying
   * user session is left alone; it is theirs, not the tenant's.
   */
  async endSupportSession(
    principal: { operatorId: string; supportSessionId: string; tenantId: string },
    origin: AuthOrigin,
  ): Promise<void> {
    await runAsPlatform('sign-out', origin.correlationId, () =>
      withTransaction(async (tx) => {
        await directory.closeSupportSession(principal.supportSessionId, tx);
        await directory.recordAuthEvent(
          authEvent(origin, {
            action: 'auth.sign_out',
            provider: 'support_session',
            userId: principal.operatorId,
            sessionId: principal.supportSessionId,
          }),
          tx,
        );
        await runInTenant(
          {
            tenantId: principal.tenantId,
            actor: { kind: 'platform_operator', id: principal.operatorId },
            brandIds: 'all',
            correlationId: origin.correlationId,
            supportSessionId: principal.supportSessionId,
          },
          () =>
            audit.record(
              { kind: 'platform_operator', id: principal.operatorId },
              'support.close',
              { type: 'support_session', id: principal.supportSessionId },
              'allowed',
              tx,
              { toState: 'closed' },
            ),
        );
      }),
    );
  },

  /**
   * Operator bootstrap (apps/api/src/bootstrap-owner.ts, run once per new company from the api service shell): an
   * active user for the owner's email, then the existing createTenantWithOwner path, in one transaction. The owner
   * then signs in with Google, which links their Google identity to this user by verified email when Google is
   * authoritative for the address (Workspace `hd` or Gmail). Refuses a disabled or deleted user.
   */
  async bootstrapOwner(
    input: { email: string; name: string; tenant: z.infer<typeof TenantCreate> },
    correlationId: string,
  ): Promise<{ userId: string; tenantId: string; membershipId: string; userCreated: boolean }> {
    const email = MemberInvite.shape.email.parse(input.email.trim()).toLowerCase();
    const tenant = TenantCreate.parse(input.tenant);
    // One transaction: a failed company creation leaves no user behind (and no half-made company).
    const result = await runAsPlatform('tenant-bootstrap', correlationId, () =>
      withTransaction(async (tx) => {
        if (await directory.tenantBySlug(tenant.slug, tx))
          throw new ValidationFailedError([{ path: 'slug', issue: 'already_exists' }]);
        const found = await directory.findByEmail(email, tx);
        // Collation is accent-insensitive; only the exact address is the same person.
        const existing = found && found.email.toLowerCase() === email ? found : null;
        if (found && !existing) throw new ValidationFailedError([{ path: 'email', issue: 'ambiguous' }]);
        let userId: string;
        if (existing) {
          if (existing.status !== 'active')
            throw new ValidationFailedError([{ path: 'email', issue: 'user_not_active' }]);
          userId = existing.id;
        } else {
          userId = newId('user');
          await directory.create(
            { id: userId, email, name: input.name.trim().slice(0, 200) || email, status: 'active' },
            tx,
          );
        }
        const created = await accessService.createTenantWithOwner(tenant, userId, correlationId, tx);
        await runInTenant(
          { tenantId: created.tenantId, actor: { kind: 'user', id: userId }, brandIds: 'all', correlationId },
          () =>
            audit.record(
              { kind: 'platform_operator', id: 'bootstrap-cli' },
              'tenant.bootstrap',
              { type: 'membership', id: created.membershipId },
              'allowed',
              tx,
              { toState: 'active' },
            ),
        );
        return { userId, ...created, userCreated: !existing };
      }),
    );
    const { userId, tenantId, membershipId, userCreated } = result;
    return { userId, tenantId, membershipId, userCreated };
  },

  async me(actor: ResolvedActor) {
    const ctx = requireTenant();
    return { actor, tenantId: ctx.tenantId, brandIds: ctx.brandIds === 'all' ? 'all' : [...ctx.brandIds] };
  },

  /** The person behind a user session (name and email for the app header; never another user's). */
  async sessionUser(userId: string, correlationId: string, tx?: Tx) {
    const user = await runAsPlatform('session-user', correlationId, () => directory.findById(userId, tx));
    if (!user) throw new NotFoundError('User', userId);
    return { userId: user.id, name: user.name, email: user.email };
  },

  /** Portfolio: authorised companies as a projection over memberships (spec 5.1). */
  async listCompanies(userId: string, correlationId: string, tx?: Tx) {
    const rows = await runAsPlatform('portfolio', correlationId, () =>
      directory.membershipsForUser(userId, tx),
    );
    return rows.map((r) => ({
      tenantId: r.tenant.id,
      name: r.tenant.name,
      slug: r.tenant.slug,
      kind: r.tenant.kind,
      role: r.membership.role,
      allBrands: r.membership.allBrands,
    }));
  },

  async switchCompany(
    sessionId: string,
    userId: string,
    tenantId: string,
    correlationId: string,
    tx?: Tx,
  ): Promise<void> {
    await runAsPlatform('switch-company', correlationId, async () => {
      const m = await directory.membershipFor(userId, tenantId, tx);
      if (!m || m.membership.status !== 'active')
        throw new PolicyDeniedError('membership_missing', 'You are not a member of this company');
      await directory.setSelectedTenant(sessionId, tenantId, tx);
    });
  },

  /**
   * BSC-3: the names of the company's members among `userIds`, for showing who reviewed or approved something to the
   * people who can see it (never an email; a person who is not an active member of this company is left out, as is
   * one without a name). The caller has already authorised reading the record that names them.
   */
  async memberNames(userIds: readonly string[], tx?: Tx): Promise<Map<string, string>> {
    const wanted = new Set(userIds);
    if (wanted.size === 0) return new Map();
    const rows = (await membershipsRepo.list(tx)).filter(
      (m) => m.status === 'active' && wanted.has(m.userId),
    );
    const people = await runAsPlatform('member-names', requireTenant().correlationId, () =>
      directory.usersByIds(
        rows.map((m) => m.userId),
        tx,
      ),
    );
    return new Map(people.flatMap((u) => (u.name ? [[u.id, u.name] as const] : [])));
  },

  /**
   * The company's members (Settings → Members): each membership with the person's name and email, role, status,
   * whether it covers every brand and the brands granted otherwise. Names and emails are personal data, so this is
   * membership.manage (owners and admins), the same people who invite and change roles.
   */
  async listMembers(actor: ResolvedActor, tx?: Tx) {
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const rows = await membershipsRepo.list(tx);
    const people = await runAsPlatform('members-list', requireTenant().correlationId, () =>
      directory.usersByIds(
        rows.map((m) => m.userId),
        tx,
      ),
    );
    const byId = new Map(people.map((u) => [u.id, u]));
    const items = [];
    for (const m of rows) {
      const user = byId.get(m.userId);
      const grants = m.allBrands ? [] : await grantsRepo.forMembership(m.id, tx);
      items.push({
        membershipId: m.id,
        userId: m.userId,
        // An invitation not yet claimed has only the placeholder name derived from the email.
        name: m.status === 'invited' ? null : (user?.name ?? null),
        email: m.invitedEmail ?? user?.email ?? null,
        role: m.role,
        status: m.status,
        allBrands: m.allBrands,
        brandIds: grants.map((g) => g.brandId),
        createdAt: m.createdAt.toISOString(),
        version: m.version,
      });
    }
    return { items: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
  },

  async inviteMember(actor: ResolvedActor, input: z.infer<typeof MemberInvite>, tx: Tx) {
    const parsed = MemberInvite.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const person = requirePerson(actor, 'Only a person can invite a member');
    if (parsed.role === 'owner' && person.role !== 'owner')
      throw new PolicyDeniedError('owner_required', 'Only an owner can invite another owner');
    assertBrandScopeWithin(person, { allBrands: parsed.allBrands });
    const existingUser = await runAsPlatform('invite', requireTenant().correlationId, () =>
      directory.findByEmail(parsed.email, tx),
    );
    const id = newId('membership');
    if (existingUser) {
      const dup = await membershipsRepo.findByUser(existingUser.id, tx);
      if (dup) throw new ValidationFailedError([{ path: 'email', issue: 'already_member' }]);
      await membershipsRepo.create(
        {
          id,
          userId: existingUser.id,
          role: parsed.role,
          status: 'invited',
          allBrands: parsed.allBrands,
          invitedEmail: parsed.email.toLowerCase(),
        },
        tx,
      );
    } else {
      // Placeholder user row so the membership can exist before first sign-in (status disabled until claimed).
      const userId = newId('user');
      await runAsPlatform('invite', requireTenant().correlationId, () =>
        directory.create(
          {
            id: userId,
            email: parsed.email,
            name: parsed.email.split('@')[0] ?? 'invited',
            status: 'disabled',
          },
          tx,
        ),
      );
      await membershipsRepo.create(
        {
          id,
          userId,
          role: parsed.role,
          status: 'invited',
          allBrands: parsed.allBrands,
          invitedEmail: parsed.email.toLowerCase(),
        },
        tx,
      );
    }
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'membership.invite',
      { type: 'membership', id },
      'allowed',
      tx,
    );
    await outbox.add(
      'membership.changed',
      { type: 'membership', id, version: 0 },
      { membershipId: id, change: 'invited' },
      tx,
    );
    return { membershipId: id };
  },

  async setRole(actor: ResolvedActor, input: z.infer<typeof MemberSetRole>, tx: Tx) {
    const parsed = MemberSetRole.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const person = requirePerson(actor, 'Only a person can change a role');
    const m = await membershipsRepo.getById(parsed.membershipId, tx);
    if ((m.role === 'owner' || parsed.role === 'owner') && person.role !== 'owner')
      throw new PolicyDeniedError('owner_required');
    if (parsed.allBrands && !m.allBrands) assertBrandScopeWithin(person, { allBrands: true });
    // Never the company's last active owner (yourself included).
    if (m.role === 'owner' && parsed.role !== 'owner') await assertAnotherActiveOwner(m.id, tx);
    await membershipsRepo.update(
      m.id,
      parsed.expectedVersion,
      { role: parsed.role, ...(parsed.allBrands !== undefined ? { allBrands: parsed.allBrands } : {}) },
      tx,
    );
    // Privilege change invalidates the member's sessions (spec 18 authentication baseline).
    await runAsPlatform('set-role', requireTenant().correlationId, () =>
      directory.revokeSessionsForUser(m.userId, tx),
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'membership.set_role',
      { type: 'membership', id: m.id },
      'allowed',
      tx,
      { toState: parsed.role },
    );
    await outbox.add(
      'membership.changed',
      { type: 'membership', id: m.id, version: parsed.expectedVersion + 1 },
      { membershipId: m.id, change: 'role' },
      tx,
    );
  },

  /**
   * G03: switches a member's access to this company off. Their sessions end in the same transaction (as a role change
   * does) and every later request of theirs to this company is refused at tenant resolution (membership_inactive);
   * their account and their other companies are untouched. Owners and admins (membership.manage), people only; an
   * owner or admin only by an owner; never yourself, and never the company's last active owner.
   */
  async disableMember(actor: ResolvedActor, input: z.infer<typeof MemberDisable>, tx: Tx) {
    const parsed = MemberDisable.parse(input);
    const m = await loadManageableMember(actor, parsed.membershipId, 'disable', tx);
    if (m.status !== 'active')
      throw new ValidationFailedError([{ path: 'membershipId', issue: `membership_is_${m.status}` }]);
    if (m.role === 'owner') await assertAnotherActiveOwner(m.id, tx);
    await membershipsRepo.update(m.id, parsed.expectedVersion, { status: 'disabled' }, tx);
    await runAsPlatform('disable-member', requireTenant().correlationId, () =>
      directory.revokeSessionsForUser(m.userId, tx),
    );
    return recordMemberStatus(actor, m.id, parsed.expectedVersion, 'active', 'disabled', tx);
  },

  /** G03: gives a disabled member their access back (same rules as disable; the seat entitlement applies). */
  async enableMember(actor: ResolvedActor, input: z.infer<typeof MemberEnable>, tx: Tx) {
    const parsed = MemberEnable.parse(input);
    const m = await loadManageableMember(actor, parsed.membershipId, 'enable', tx);
    if (m.status !== 'disabled')
      throw new ValidationFailedError([{ path: 'membershipId', issue: `membership_is_${m.status}` }]);
    await membershipsRepo.update(m.id, parsed.expectedVersion, { status: 'active' }, tx);
    return recordMemberStatus(actor, m.id, parsed.expectedVersion, 'disabled', 'active', tx);
  },

  /**
   * A one-time link for a member of this company to set a password (there is no mailer; the owner or admin hands it
   * over). Owners and admins (membership.manage), people only; a link for an owner or admin only from an owner, and never for
   * yourself (Settings → Account is the way, behind its own checks). Refused for a
   * person who also belongs to another company: an admin here must never gain a way into that person's other
   * companies (they set a password themselves in Settings). Only the SHA-256 of the token is stored; issuing expires
   * the person's unused links. The URL carries the token in its fragment, so it never reaches a server log.
   */
  async issuePasswordSetup(
    actor: ResolvedActor,
    input: z.infer<typeof MemberIssuePasswordSetup>,
    webOrigin: string | null,
    tx: Tx,
  ): Promise<PasswordSetupLink> {
    const parsed = MemberIssuePasswordSetup.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    if (actor.kind !== 'user')
      throw new PolicyDeniedError('agent_never', 'Only a person can issue a password setup link');
    const m = await membershipsRepo.getById(parsed.membershipId, tx);
    // Your own password is changed in Settings → Account, behind the current password or a recent sign-in; a link
    // for yourself would bypass both (and a stolen session could use it to take the account over).
    if (m.userId === actor.id)
      throw new PolicyDeniedError(
        'self_setup_link',
        'Set your own password in Settings → Account, not with a setup link',
      );
    // A link lets its holder sign in as the member: for anyone who can manage members, only an owner issues one.
    if (DEFAULT_ROLE_GRANTS['membership.manage'].includes(m.role) && actor.role !== 'owner')
      throw new PolicyDeniedError(
        'owner_required',
        'Only an owner can issue a password setup link for an owner or admin',
      );
    if (m.status === 'disabled')
      throw new ValidationFailedError([{ path: 'membershipId', issue: 'membership_disabled' }]);
    const elsewhere = await runAsPlatform('password-setup', requireTenant().correlationId, async () =>
      (await directory.allMembershipsOfUser(m.userId, tx)).some((x) => x.tenantId !== m.tenantId),
    );
    if (elsewhere)
      throw new PolicyDeniedError(
        'member_of_another_company',
        'This person also belongs to another company; they can set a password themselves in Settings',
      );
    const now = new Date();
    await passwordSetupRepo.expireUnusedForUser(m.userId, now, tx);
    const { token, hash } = newOpaqueToken('pst');
    const id = newId('passwordSetupToken');
    const expiresAt = new Date(now.getTime() + PASSWORD_SETUP_TTL_MS);
    await passwordSetupRepo.create(
      { id, userId: m.userId, createdByUserId: actor.id, tokenHash: hash, expiresAt },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'membership.password_setup_issue',
      { type: 'membership', id: m.id },
      'allowed',
      tx,
    );
    return { url: `${webOrigin ?? ''}/set-password#token=${token}`, expiresAt: expiresAt.toISOString() };
  },

  async setBrandGrant(actor: ResolvedActor, input: z.infer<typeof BrandGrantSet>, tx: Tx) {
    const parsed = BrandGrantSet.parse(input);
    await brands().assertExist([parsed.brandId], tx);
    await policy.assert(
      actor,
      'membership.manage',
      { type: 'brand', tenantId: actor.tenantId, brandId: parsed.brandId },
      {},
      tx,
    );
    const person = requirePerson(actor, 'Only a person can grant a brand');
    assertBrandScopeWithin(person, { brandIds: [parsed.brandId] });
    if (parsed.roles.some((r) => MEMBER_MANAGING_ROLES.includes(r)) && person.role !== 'owner')
      throw new PolicyDeniedError(
        'owner_required',
        'Only an owner can grant the owner or admin role on a brand',
      );
    const m = await membershipsRepo.getById(parsed.membershipId, tx);
    const id = await grantsRepo.set(
      { id: newId('brandGrant'), membershipId: m.id, brandId: parsed.brandId, roles: parsed.roles },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'brand_grant.set',
      { type: 'brand_grant', id },
      'allowed',
      tx,
      { brandId: parsed.brandId },
    );
    return { grantId: id };
  },

  /**
   * G03: takes one brand away from a member restricted to some brands (the grant row goes; a member granted every
   * brand is unaffected until their role says otherwise). Same gate as granting it: membership.manage on that brand.
   */
  async removeBrandGrant(actor: ResolvedActor, input: z.infer<typeof BrandGrantRemove>, tx: Tx) {
    const parsed = BrandGrantRemove.parse(input);
    await brands().assertExist([parsed.brandId], tx);
    await policy.assert(
      actor,
      'membership.manage',
      { type: 'brand', tenantId: actor.tenantId, brandId: parsed.brandId },
      {},
      tx,
    );
    const m = await membershipsRepo.getById(parsed.membershipId, tx);
    const removed = await grantsRepo.remove(m.id, parsed.brandId, tx);
    if (removed)
      await audit.record(
        { kind: actor.kind, id: actor.id },
        'brand_grant.remove',
        { type: 'membership', id: m.id },
        'allowed',
        tx,
        { brandId: parsed.brandId },
      );
    return { removed };
  },

  async createServicePrincipal(actor: ResolvedActor, input: z.infer<typeof ServicePrincipalCreate>, tx: Tx) {
    const parsed = ServicePrincipalCreate.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const person = requirePerson(actor, 'Only a person can create a service principal');
    const scope = grantsBrandScope(parsed.grants);
    await brands().assertValidGrantBrands(scope.brandIds, tx);
    assertBrandScopeWithin(person, scope);
    const id = newId('servicePrincipal');
    await principalsRepo.create(
      {
        id,
        kind: parsed.kind,
        name: parsed.name,
        grants: parsed.grants,
        maxAutonomy: parsed.maxAutonomy,
        status: 'active',
        createdByUserId: actor.id,
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'service_principal.create',
      { type: 'service_principal', id },
      'allowed',
      tx,
    );
    return { servicePrincipalId: id };
  },

  /**
   * UX-08: the active agent principals a run on the brand can start under. Gated on agent.start_run for the brand
   * (the same right the start needs), and each principal is reported with the actions its grants cover on that
   * brand, never its whole grant table. The page is cut by the SQL cursor and then filtered to the brand, so it can
   * be shorter than the limit while more remain.
   */
  async listServicePrincipals(actor: ResolvedActor, input: z.infer<typeof ServicePrincipalList>, tx?: Tx) {
    const parsed = ServicePrincipalList.parse(input);
    await brands().assertExist([parsed.brandId], tx);
    await policy.assert(
      actor,
      'agent.start_run',
      { type: 'brand', tenantId: actor.tenantId, brandId: parsed.brandId, id: parsed.brandId },
      {},
      tx,
    );
    const page = await principalsRepo.listPage({ status: 'active', kind: 'agent' }, parsed.page, tx);
    const covers = (g: { brandIds: 'all' | string[] }) =>
      g.brandIds === 'all' || g.brandIds.includes(parsed.brandId);
    return {
      items: page.items.flatMap((sp) => {
        const actions = [...new Set(sp.grants.filter(covers).map((g) => g.action))].sort();
        if (actions.length === 0) return [];
        return [
          {
            id: sp.id,
            name: sp.name,
            kind: sp.kind,
            maxAutonomy: sp.maxAutonomy,
            actions,
            createdAt: sp.createdAt.toISOString(),
          },
        ];
      }),
      nextCursor: page.nextCursor,
    };
  },

  async revokeServicePrincipal(actor: ResolvedActor, input: z.infer<typeof ServicePrincipalRevoke>, tx: Tx) {
    const parsed = ServicePrincipalRevoke.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const sp = await principalsRepo.getById(parsed.servicePrincipalId, tx);
    await principalsRepo.update(sp.id, parsed.expectedVersion, { status: 'revoked' }, tx);
    for (const c of await apiClientsRepo.listForPrincipal(sp.id, tx))
      if (c.status === 'active') await apiClientsRepo.update(c.id, c.version, { status: 'revoked' }, tx);
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'service_principal.revoke',
      { type: 'service_principal', id: sp.id },
      'allowed',
      tx,
    );
  },

  /** Returns the plaintext key exactly once; only the hash and prefix are stored (spec 7.6). */
  async createApiClient(actor: ResolvedActor, input: z.infer<typeof ApiClientCreate>, tx: Tx) {
    const parsed = ApiClientCreate.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const person = requirePerson(actor, 'Only a person can create an API key');
    const sp = await principalsRepo.getById(parsed.servicePrincipalId, tx);
    if (sp.status !== 'active')
      throw new ValidationFailedError([{ path: 'servicePrincipalId', issue: 'revoked' }]);
    // A key acts with the principal's grants: minting one is handing out those brands.
    assertBrandScopeWithin(person, grantsBrandScope(sp.grants));
    const { token, hash, prefixForLookup } = newOpaqueToken('ak');
    const id = newId('apiClient');
    await apiClientsRepo.create(
      {
        id,
        servicePrincipalId: sp.id,
        keyHash: hash,
        keyPrefix: prefixForLookup,
        scopes: parsed.scopes,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
        status: 'active',
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'api_client.create',
      { type: 'api_client', id },
      'allowed',
      tx,
    );
    return { apiClientId: id, key: token, keyPrefix: prefixForLookup };
  },

  async rotateApiClient(actor: ResolvedActor, input: z.infer<typeof ApiClientRotate>, tx: Tx) {
    const parsed = ApiClientRotate.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const person = requirePerson(actor, 'Only a person can rotate an API key');
    const old = await apiClientsRepo.getById(parsed.apiClientId, tx);
    // Only the live key is rotated: rotating a revoked one again would start a second key beside its successor.
    if (old.status !== 'active')
      throw new ValidationFailedError([{ path: 'apiClientId', issue: 'not_active' }]);
    const sp = await principalsRepo.getById(old.servicePrincipalId, tx);
    if (sp.status !== 'active') throw new ValidationFailedError([{ path: 'apiClientId', issue: 'revoked' }]);
    assertBrandScopeWithin(person, grantsBrandScope(sp.grants));
    await apiClientsRepo.update(old.id, old.version, { status: 'revoked' }, tx);
    const { token, hash, prefixForLookup } = newOpaqueToken('ak');
    const id = newId('apiClient');
    await apiClientsRepo.create(
      {
        id,
        servicePrincipalId: old.servicePrincipalId,
        keyHash: hash,
        keyPrefix: prefixForLookup,
        scopes: old.scopes,
        expiresAt: old.expiresAt,
        status: 'active',
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'api_client.rotate',
      { type: 'api_client', id },
      'allowed',
      tx,
    );
    return { apiClientId: id, key: token, keyPrefix: prefixForLookup };
  },

  /** Spec 5.6: single-use-per-session, expiring, revocable token bound to one review request. */
  async createExternalReviewerLink(
    actor: ResolvedActor,
    input: z.infer<typeof ExternalLinkCreate>,
    brandId: string,
    tx: Tx,
  ) {
    const parsed = ExternalLinkCreate.parse(input);
    await policy.assert(
      actor,
      'review.request',
      { type: 'review_request', tenantId: actor.tenantId, brandId, id: parsed.reviewRequestId },
      {},
      tx,
    );
    if (actor.kind !== 'user') throw new PolicyDeniedError('agent_never');
    const { token, hash } = newOpaqueToken('rl');
    const id = newId('externalReviewerLink');
    await linksRepo.create(
      {
        id,
        brandId,
        reviewRequestId: parsed.reviewRequestId,
        tokenHash: hash,
        email: parsed.email.toLowerCase(),
        expiresAt: new Date(parsed.expiresAt),
        createdByUserId: actor.id,
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'external_link.create',
      { type: 'external_reviewer_link', id },
      'allowed',
      tx,
      { brandId },
    );
    return { linkId: id, token };
  },

  async revokeExternalReviewerLink(actor: ResolvedActor, input: z.infer<typeof ExternalLinkRevoke>, tx: Tx) {
    const parsed = ExternalLinkRevoke.parse(input);
    const link = await linksRepo.getById(parsed.linkId, tx);
    await policy.assert(
      actor,
      'review.request',
      { type: 'review_request', tenantId: actor.tenantId, brandId: link.brandId, id: link.reviewRequestId },
      {},
      tx,
    );
    await linksRepo.update(link.id, link.version, { revokedAt: new Date() }, tx);
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'external_link.revoke',
      { type: 'external_reviewer_link', id: link.id },
      'allowed',
      tx,
    );
  },

  /** Spec 5.7: support sessions are opened by platform operators, outside tenant context, and audited on use. */
  async openSupportSession(
    operatorId: string,
    input: z.infer<typeof SupportSessionOpen>,
    correlationId: string,
  ): Promise<{ supportSessionId: string; expiresAt: Date }> {
    const parsed = SupportSessionOpen.parse(input);
    const id = newId('supportSession');
    const expiresAt = new Date(Date.now() + parsed.durationMinutes * 60_000);
    await runAsPlatform('support-session', correlationId, async () => {
      const tenant = await directory.tenantById(parsed.tenantId);
      if (!tenant) throw new NotFoundError('Tenant', parsed.tenantId);
      await directory.openSupportSession({
        id,
        operatorId,
        tenantId: parsed.tenantId,
        reason: parsed.reason,
        ticketRef: parsed.ticketRef,
        consentRecorded: parsed.consentRecorded,
        mode: 'read_only',
        expiresAt,
      });
    });
    // The opening is the first entry of the tenant's own trail for this session (spec 5.7: every request audited).
    await runInTenant(
      {
        tenantId: parsed.tenantId,
        actor: { kind: 'platform_operator', id: operatorId },
        brandIds: 'all',
        correlationId,
        supportSessionId: id,
      },
      () =>
        audit.record(
          { kind: 'platform_operator', id: operatorId },
          'support.open',
          { type: 'support_session', id },
          'allowed',
          undefined,
          { ticketRef: parsed.ticketRef, toState: 'read_only' },
        ),
    );
    return { supportSessionId: id, expiresAt };
  },

  /**
   * Spec 5.7: a support session is read-only unless escalated with a second operator. The caller is that second
   * operator, inside their own live support session on the same tenant; the opener can never escalate their own
   * session. The escalation is time-boxed (the session's expiry only ever moves earlier) and audited either way.
   */
  async escalateSupportSession(
    actor: ResolvedActor,
    input: z.infer<typeof SupportSessionEscalate>,
    tx: Tx,
  ): Promise<{ supportSessionId: string; mode: 'escalated'; expiresAt: Date }> {
    const parsed = SupportSessionEscalate.parse(input);
    const session = await supportSessionsRepo.getById(parsed.supportSessionId, tx); // NOT_FOUND for a foreign id
    const resource = { type: 'support_session', id: session.id };
    const refuse = async (reason: string, message: string): Promise<never> => {
      await audit.record({ kind: actor.kind, id: actor.id }, 'support.escalate', resource, {
        allowed: false,
        reason,
      });
      throw new PolicyDeniedError(reason, message);
    };
    if (actor.kind !== 'platform_operator')
      return refuse('support_operator_required', 'Only a platform operator can escalate a support session');
    if (actor.expired) return refuse('support_session_expired', 'Your support session has expired');
    if (actor.id === session.operatorId)
      return refuse('second_operator_required', 'A second operator must escalate this support session');
    const now = Date.now();
    if (session.closedAt || session.expiresAt.getTime() <= now)
      return refuse('support_session_expired', 'The support session is closed or expired');
    if (session.mode === 'escalated')
      throw new ValidationFailedError([{ path: 'supportSessionId', issue: 'already_escalated' }]);
    const expiresAt = new Date(Math.min(session.expiresAt.getTime(), now + parsed.durationMinutes * 60_000));
    await supportSessionsRepo.update(
      session.id,
      session.version,
      { mode: 'escalated', escalatedByOperatorId: actor.id, expiresAt },
      tx,
    );
    await audit.record({ kind: actor.kind, id: actor.id }, 'support.escalate', resource, 'allowed', tx, {
      fromState: 'read_only',
      toState: 'escalated',
      ticketRef: session.ticketRef,
      reason: parsed.reason.slice(0, 200),
    });
    return { supportSessionId: session.id, mode: 'escalated', expiresAt };
  },
};
