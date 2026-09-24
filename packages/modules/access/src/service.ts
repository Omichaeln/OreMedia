import type { z } from 'zod';
import {
  ApiClientCreate,
  ApiClientRotate,
  BrandGrantSet,
  ExternalLinkCreate,
  ExternalLinkRevoke,
  MemberInvite,
  MemberSetRole,
  ServicePrincipalCreate,
  ServicePrincipalRevoke,
  SupportSessionEscalate,
  SupportSessionOpen,
  TenantCreate,
  VerifiedExternalIdentity,
  googleIsAuthoritativeFor,
  type SignInRefusalReason,
} from '@oremedia/contracts/access';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, runAsPlatform, runInTenant, withTransaction, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { audit, outbox } from '@oremedia/module-operations';
import {
  ApiClientRepository,
  BrandGrantRepository,
  ExternalReviewerLinkRepository,
  MembershipRepository,
  ServicePrincipalRepository,
  SupportSessionRepository,
  UserDirectory,
} from './repositories';
import { SESSION_ABSOLUTE_MS, newOpaqueToken } from './authenticator';
import { policy } from './policy';

const directory = new UserDirectory();
const membershipsRepo = new MembershipRepository();
const grantsRepo = new BrandGrantRepository();
const principalsRepo = new ServicePrincipalRepository();
const apiClientsRepo = new ApiClientRepository();
const linksRepo = new ExternalReviewerLinkRepository();
const supportSessionsRepo = new SupportSessionRepository();

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
    action: 'auth.sign_in' | 'auth.identity_link' | 'auth.sign_out';
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

export const accessService = {
  /** Bootstrap: creates a tenant and its owner membership. Called by sign-up, outside any tenant context. */
  async createTenantWithOwner(
    input: z.infer<typeof TenantCreate>,
    ownerUserId: string,
    correlationId: string,
    outer?: Tx,
  ): Promise<{ tenantId: string; membershipId: string }> {
    const parsed = TenantCreate.parse(input);
    const tenantId = newId('tenant');
    const membershipId = newId('membership');
    await runAsPlatform('tenant-bootstrap', correlationId, () =>
      withTransaction(outer, async (tx) => {
        await directory.createTenant({ id: tenantId, name: parsed.name, slug: parsed.slug }, tx);
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
    opts: {
      allowedDomains: readonly string[] | null;
      /** The session this browser held before: ended in the same transaction that creates the new one. */
      replaces?: { userId: string; sessionId: string } | null;
    },
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
          const memberships = await directory.allMembershipsOfUser(user.id, tx);
          const invitations = memberships.filter(
            (m) => m.status === 'invited' && m.invitedEmail?.toLowerCase() === email,
          );
          // inviteMember creates a disabled placeholder for an unknown email; it is claimed only while it has never
          // been used: no linked identity and nothing but invitations.
          const claimPlaceholder =
            !alreadyLinked &&
            user.status === 'disabled' &&
            invitations.length > 0 &&
            memberships.every((m) => m.status === 'invited');
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
          for (const m of invitations)
            await runInTenant(
              {
                tenantId: m.tenantId,
                actor: { kind: 'user', id: user.id },
                brandIds: new Set<string>(),
                correlationId: origin.correlationId,
              },
              async () => {
                await membershipsRepo.update(m.id, m.version, { status: 'active' }, tx);
                await audit.record(
                  { kind: 'user', id: user.id },
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

          // Rotation: the session this browser held ends with the sign-in, atomically (never an orphan either way).
          if (opts.replaces) {
            await directory.revokeSession(opts.replaces.sessionId, tx);
            await directory.recordAuthEvent(
              authEvent(origin, {
                action: 'auth.sign_out',
                provider: 'session',
                userId: opts.replaces.userId,
                sessionId: opts.replaces.sessionId,
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
              userId: user.id,
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
            authEvent(origin, { action: 'auth.sign_in', provider, userId: user.id, sessionId }),
            tx,
          );
          return { refused: null, userId: user.id, sessionId, token, expiresAt };
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

  async inviteMember(actor: ResolvedActor, input: z.infer<typeof MemberInvite>, tx: Tx) {
    const parsed = MemberInvite.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    if (parsed.role === 'owner' && actor.kind === 'user' && actor.role !== 'owner')
      throw new PolicyDeniedError('owner_required', 'Only an owner can invite another owner');
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
    const m = await membershipsRepo.getById(parsed.membershipId, tx);
    if ((m.role === 'owner' || parsed.role === 'owner') && actor.kind === 'user' && actor.role !== 'owner')
      throw new PolicyDeniedError('owner_required');
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

  async createServicePrincipal(actor: ResolvedActor, input: z.infer<typeof ServicePrincipalCreate>, tx: Tx) {
    const parsed = ServicePrincipalCreate.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    if (actor.kind !== 'user')
      throw new PolicyDeniedError('agent_never', 'Only a person can create a service principal');
    const grantBrandIds = [
      ...new Set(parsed.grants.flatMap((g) => (g.brandIds === 'all' ? [] : g.brandIds))),
    ];
    await brands().assertValidGrantBrands(grantBrandIds, tx);
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
    const sp = await principalsRepo.getById(parsed.servicePrincipalId, tx);
    if (sp.status !== 'active')
      throw new ValidationFailedError([{ path: 'servicePrincipalId', issue: 'revoked' }]);
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
    const old = await apiClientsRepo.getById(parsed.apiClientId, tx);
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
