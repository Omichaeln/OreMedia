import { and, eq, gt, isNull, or, type SQL } from 'drizzle-orm';
import { PlatformRepository, TenantScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import {
  apiClients,
  authEvents,
  brandGrants,
  externalIdentities,
  externalReviewerLinks,
  memberships,
  servicePrincipals,
  sessions,
  supportSessions,
  tenants,
  users,
} from '@oremedia/db/schema/access';
import { SESSION_IDLE_MS, SESSION_TOUCH_MS } from './authenticator';

/** Global tables (users, tenants, sessions) are read through explicit, narrow finders; they are never tenant-scoped. */
export class UserDirectory extends PlatformRepository {
  async findByEmail(email: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }
  async findById(id: string, tx?: Tx) {
    const rows = await this.conn(tx).select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }
  async create(values: typeof users.$inferInsert, tx?: Tx) {
    await this.conn(tx)
      .insert(users)
      .values({ ...values, email: values.email.toLowerCase() });
  }
  async tenantById(id: string, tx?: Tx) {
    const rows = await this.conn(tx).select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return rows[0] ?? null;
  }
  async tenantBySlug(slug: string, tx?: Tx) {
    const rows = await this.conn(tx).select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    return rows[0] ?? null;
  }
  async createTenant(values: typeof tenants.$inferInsert, tx?: Tx) {
    await this.conn(tx).insert(tenants).values(values);
  }
  /** Bootstrap only: the owner membership of a tenant being created, before any tenant context exists. */
  async createMembership(values: typeof memberships.$inferInsert, tx?: Tx) {
    await this.conn(tx).insert(memberships).values(values);
  }
  /** Memberships for one user across tenants: the portfolio projection (spec 5.1). */
  async membershipsForUser(userId: string, tx?: Tx) {
    return this.conn(tx)
      .select({ membership: memberships, tenant: tenants })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(eq(memberships.userId, userId), eq(memberships.status, 'active'), eq(tenants.status, 'active')),
      );
  }
  /**
   * A live session: not revoked, before its absolute expiry, and used within the idle window (last seen, or created
   * when never seen since).
   */
  async sessionByTokenHash(tokenHash: string, tx?: Tx) {
    const now = new Date();
    const idleCutoff = new Date(now.getTime() - SESSION_IDLE_MS);
    const rows = await this.conn(tx)
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          or(
            gt(sessions.lastSeenAt, idleCutoff),
            and(isNull(sessions.lastSeenAt), gt(sessions.createdAt, idleCutoff)),
          ),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  /** Idle-timeout bookkeeping: moves lastSeenAt forward, at most once per SESSION_TOUCH_MS per session. */
  async touchSession(id: string, lastSeenAt: Date | null, tx?: Tx) {
    const now = new Date();
    if (lastSeenAt && now.getTime() - lastSeenAt.getTime() < SESSION_TOUCH_MS) return;
    await this.conn(tx).update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id));
  }
  async createSession(values: typeof sessions.$inferInsert, tx?: Tx) {
    await this.conn(tx).insert(sessions).values(values);
  }
  async revokeSessionsForUser(userId: string, tx?: Tx) {
    await this.conn(tx)
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }
  /**
   * Spec 17.5 user identity after a tenant deletion: a user left with no membership in any tenant keeps a
   * pseudonymous row (audit events refer to the id) with the personal fields replaced, and every session revoked.
   * A user who still belongs to another tenant is untouched. Returns whether the user was anonymised.
   */
  async anonymiseIfUnaffiliated(userId: string, tx?: Tx): Promise<boolean> {
    const remaining = await this.conn(tx)
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1);
    if (remaining.length) return false;
    await this.conn(tx)
      .update(users)
      .set({
        email: `deleted+${userId.toLowerCase()}@deleted.invalid`,
        name: 'Deleted user',
        status: 'deleted',
        passwordHash: null,
        mfaEnrolled: false,
      })
      .where(eq(users.id, userId));
    await this.revokeSessionsForUser(userId, tx);
    // The provider link carries the email at link time; an anonymised user can never be signed in again.
    await this.conn(tx).delete(externalIdentities).where(eq(externalIdentities.userId, userId));
    return true;
  }
  /** Spec 17.5 tenant deletion: the tenant row stays as a tombstone (audit rows name it) without its name. */
  async closeTenant(tenantId: string, tx?: Tx) {
    await this.conn(tx)
      .update(tenants)
      .set({
        name: 'Deleted tenant',
        slug: `deleted-${tenantId.toLowerCase()}`.slice(0, 80),
        status: 'closing',
        policy: null,
      })
      .where(eq(tenants.id, tenantId));
  }
  async revokeSession(id: string, tx?: Tx) {
    await this.conn(tx).update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
  }
  async setSelectedTenant(sessionId: string, tenantId: string, tx?: Tx) {
    await this.conn(tx)
      .update(sessions)
      .set({ selectedTenantId: tenantId, lastSeenAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }
  async apiClientByKeyHash(keyHash: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(apiClients)
      .where(and(eq(apiClients.keyHash, keyHash), eq(apiClients.status, 'active')))
      .limit(1);
    return rows[0] ?? null;
  }
  async reviewerLinkByTokenHash(tokenHash: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(externalReviewerLinks)
      .where(eq(externalReviewerLinks.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }
  async supportSessionById(id: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(supportSessions)
      .where(eq(supportSessions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
  async openSupportSession(values: typeof supportSessions.$inferInsert, tx?: Tx) {
    await this.conn(tx).insert(supportSessions).values(values);
  }
  async closeSupportSession(id: string, tx?: Tx) {
    await this.conn(tx)
      .update(supportSessions)
      .set({ closedAt: new Date() })
      .where(eq(supportSessions.id, id));
  }
  /** Membership + grants for a (user, tenant) pair, read by the resolver before tenant context exists. */
  async membershipFor(userId: string, tenantId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .limit(1);
    const m = rows[0];
    if (!m) return null;
    const grants = await this.conn(tx)
      .select()
      .from(brandGrants)
      .where(and(eq(brandGrants.tenantId, tenantId), eq(brandGrants.membershipId, m.id)));
    return { membership: m, grants };
  }
  /** D-03: the user an external identity (provider + subject) is linked to. */
  async identityFor(provider: string, subject: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(externalIdentities)
      .where(and(eq(externalIdentities.provider, provider), eq(externalIdentities.subject, subject)))
      .limit(1);
    return rows[0] ?? null;
  }
  /**
   * The identity a user already has at a provider, as a locking read (the latest committed row, not the
   * transaction's snapshot), so a concurrent first sign-in that committed a link is seen after lockUser waits.
   */
  async identityOfUser(provider: string, userId: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(externalIdentities)
      .where(and(eq(externalIdentities.provider, provider), eq(externalIdentities.userId, userId)))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }
  /** Serialises sign-ins that resolve to one user (SELECT … FOR UPDATE on the users row); returns the fresh row. */
  async lockUser(userId: string, tx: Tx) {
    const rows = await this.conn(tx).select().from(users).where(eq(users.id, userId)).limit(1).for('update');
    return rows[0] ?? null;
  }
  async linkIdentity(values: typeof externalIdentities.$inferInsert, tx?: Tx) {
    await this.conn(tx)
      .insert(externalIdentities)
      .values({ ...values, emailAtLink: values.emailAtLink.toLowerCase() });
  }
  /** Every membership of one user across tenants, whatever its status (sign-in reads invitations here). */
  async allMembershipsOfUser(userId: string, tx?: Tx) {
    return this.conn(tx).select().from(memberships).where(eq(memberships.userId, userId));
  }
  /** Claims an invitation placeholder (created disabled by inviteMember) on its first verified sign-in. */
  async activateUser(userId: string, name: string, tx?: Tx) {
    await this.conn(tx)
      .update(users)
      .set({ status: 'active', name: name.slice(0, 200) })
      .where(and(eq(users.id, userId), eq(users.status, 'disabled')));
  }
  /** Insert-only: pre-tenant authentication outcomes (auth_events has no update or delete method). */
  async recordAuthEvent(values: typeof authEvents.$inferInsert, tx?: Tx) {
    await this.conn(tx).insert(authEvents).values(values);
  }
  async servicePrincipalFor(id: string, tenantId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(servicePrincipals)
      .where(and(eq(servicePrincipals.tenantId, tenantId), eq(servicePrincipals.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }
}

export class MembershipRepository extends TenantScopedRepository<typeof memberships> {
  constructor() {
    super(memberships);
  }
  async list(tx?: Tx) {
    return this.conn(tx).select().from(memberships).where(this.scope());
  }
  async findByUser(userId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(memberships)
      .where(this.scope(eq(memberships.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }
  async findByInvitedEmail(email: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(memberships)
      .where(this.scope(eq(memberships.invitedEmail, email.toLowerCase())))
      .limit(1);
    return rows[0] ?? null;
  }
  async create(values: Omit<typeof memberships.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof memberships.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async countActive(tx?: Tx) {
    const rows = await this.conn(tx)
      .select({ id: memberships.id })
      .from(memberships)
      .where(this.scope(or(eq(memberships.status, 'active'), eq(memberships.status, 'invited')) as SQL));
    return rows.length;
  }
}

export class BrandGrantRepository extends TenantScopedRepository<typeof brandGrants> {
  constructor() {
    super(brandGrants);
  }
  async forMembership(membershipId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(brandGrants)
      .where(this.scope(eq(brandGrants.membershipId, membershipId)));
  }
  async set(values: Omit<typeof brandGrants.$inferInsert, 'tenantId'>, tx?: Tx) {
    const { tenantId } = requireTenant();
    const existing = await this.conn(tx)
      .select()
      .from(brandGrants)
      .where(
        this.scope(
          and(eq(brandGrants.membershipId, values.membershipId), eq(brandGrants.brandId, values.brandId)),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await this.conn(tx)
        .update(brandGrants)
        .set({ roles: values.roles })
        .where(this.scope(eq(brandGrants.id, existing[0].id)));
      return existing[0].id;
    }
    await this.conn(tx)
      .insert(brandGrants)
      .values({ ...values, tenantId });
    return values.id;
  }
  async remove(membershipId: string, brandId: string, tx?: Tx) {
    await this.conn(tx)
      .delete(brandGrants)
      .where(this.scope(and(eq(brandGrants.membershipId, membershipId), eq(brandGrants.brandId, brandId))));
  }
}

export class ServicePrincipalRepository extends TenantScopedRepository<typeof servicePrincipals> {
  constructor() {
    super(servicePrincipals);
  }
  async list(tx?: Tx) {
    return this.conn(tx).select().from(servicePrincipals).where(this.scope());
  }
  async create(values: Omit<typeof servicePrincipals.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof servicePrincipals.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
}

export class ApiClientRepository extends TenantScopedRepository<typeof apiClients> {
  constructor() {
    super(apiClients);
  }
  async create(values: Omit<typeof apiClients.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof apiClients.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async listForPrincipal(servicePrincipalId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(apiClients)
      .where(this.scope(eq(apiClients.servicePrincipalId, servicePrincipalId)));
  }
}

export class ExternalReviewerLinkRepository extends TenantScopedRepository<typeof externalReviewerLinks> {
  constructor() {
    super(externalReviewerLinks);
  }
  async create(values: Omit<typeof externalReviewerLinks.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof externalReviewerLinks.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async listForRequest(reviewRequestId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(externalReviewerLinks)
      .where(this.scope(eq(externalReviewerLinks.reviewRequestId, reviewRequestId)));
  }
}

/** Spec 5.7: a tenant's support sessions, as the tenant (and an operator inside it) sees them. */
export class SupportSessionRepository extends TenantScopedRepository<typeof supportSessions> {
  constructor() {
    super(supportSessions);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof supportSessions.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
}
