import { z } from 'zod';
import {
  AccountRemovePassword,
  AccountSetPassword,
  ApiClientCreate,
  ApiClientRotate,
  BrandGrantSet,
  MemberInvite,
  MemberIssuePasswordSetup,
  MemberSetRole,
  ServicePrincipalCreate,
  ServicePrincipalRevoke,
  SupportSessionEscalate,
} from '@oremedia/contracts/access';
import { PolicyDeniedError, RateLimitedError } from '@oremedia/contracts/errors';
import { withTransaction } from '@oremedia/db';
import { PasswordHashingBusyError, accessService } from '@oremedia/module-access';
import { idempotent } from '@oremedia/module-operations';
import {
  authedMutation,
  authedProcedure,
  passwordAttempts,
  router,
  tenantMutation,
  tenantQuery,
  type MutationCtx,
} from '../trpc';
import type { RequestContext } from '../context';
import { webOriginFromEnv } from '../web-origin';

const mutationCtx = (ctx: MutationCtx, ttlHours?: number) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
  ttlHours,
});

/** The signed-in person's own session (account procedures); API keys and support sessions have no password. */
function userSession(principal: NonNullable<RequestContext['principal']>) {
  if (principal.kind !== 'user')
    throw new PolicyDeniedError('user_session_required', 'Only a signed-in person has a password');
  return { userId: principal.userId, sessionId: principal.sessionId };
}
const originOf = (ctx: RequestContext) => ({
  correlationId: ctx.correlationId,
  ipHash: ctx.ipHash,
  userAgentHash: ctx.userAgentHash,
});

/**
 * A password check on the person's own account: counted as an attempt before it runs (concurrent guesses cannot all
 * pass under the lockout), cleared on success. A busy hasher answers RATE_LIMITED with a short retry-after.
 */
async function withPasswordAttempt<T>(
  ctx: RequestContext & { principal: NonNullable<RequestContext['principal']> },
  run: (principal: { userId: string; sessionId: string }) => Promise<T>,
): Promise<T> {
  const principal = userSession(ctx.principal);
  const account = `user:${principal.userId}`;
  await passwordAttempts.consume(account);
  try {
    const result = await run(principal);
    await passwordAttempts.clear(account);
    return result;
  } catch (err) {
    if (err instanceof PasswordHashingBusyError) throw new RateLimitedError(err.retryAfterMs);
    throw err;
  }
}

/** Spec 7.5 access router. */
export const accessRouter = router({
  me: tenantQuery.query(({ ctx }) => accessService.me(ctx.tenant.actor)),

  /** The signed-in person, for the app header (D-03 sign-in); user sessions only. */
  session: authedProcedure.query(({ ctx }) => {
    if (ctx.principal.kind !== 'user')
      throw new PolicyDeniedError('user_session_required', 'Only a user session has a signed-in person');
    return accessService.sessionUser(ctx.principal.userId, ctx.correlationId);
  }),

  listCompanies: authedProcedure.query(({ ctx }) => {
    if (ctx.principal.kind !== 'user')
      throw new PolicyDeniedError('user_session_required', 'Only a user session has a portfolio');
    return accessService.listCompanies(ctx.principal.userId, ctx.correlationId);
  }),

  switchCompany: authedMutation.input(z.object({ tenantId: z.string() })).mutation(async ({ ctx, input }) => {
    if (ctx.principal.kind !== 'user') throw new PolicyDeniedError('user_session_required');
    await accessService.switchCompany(
      ctx.principal.sessionId,
      ctx.principal.userId,
      input.tenantId,
      ctx.correlationId,
    );
    return { tenantId: input.tenantId };
  }),

  members: router({
    list: tenantQuery.query(({ ctx }) => accessService.listMembers(ctx.tenant.actor)),
    invite: tenantMutation
      .input(MemberInvite)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => accessService.inviteMember(ctx.tenant.actor, input, tx)),
      ),
    setRole: tenantMutation.input(MemberSetRole).mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), async (tx) => {
        await accessService.setRole(ctx.tenant.actor, input, tx);
        return { ok: true };
      }),
    ),
    /**
     * A one-time password setup link for a member, shown once to the owner or admin. Deliberately not idempotent: a
     * replayed response would have to be stored with the live token in it. A retry issues a new link, which expires
     * the previous one.
     */
    issuePasswordSetup: tenantMutation
      .input(MemberIssuePasswordSetup)
      .mutation(({ ctx, input }) =>
        withTransaction((tx) =>
          accessService.issuePasswordSetup(ctx.tenant.actor, input, webOriginFromEnv(), tx),
        ),
      ),
  }),

  /** The signed-in person's own sign-in methods: a password next to Google (no tenant: they are the person's). */
  account: router({
    signInMethods: authedProcedure.query(({ ctx }) =>
      accessService.accountSignInMethods(userSession(ctx.principal).userId, ctx.correlationId),
    ),
    /** Guessing the current password through here is locked out like sign-in (per person, in the same store). */
    setPassword: authedMutation
      .input(AccountSetPassword)
      .mutation(({ ctx, input }) =>
        withPasswordAttempt(ctx, (principal) => accessService.setPassword(principal, input, originOf(ctx))),
      ),
    removePassword: authedMutation
      .input(AccountRemovePassword)
      .mutation(({ ctx, input }) =>
        withPasswordAttempt(ctx, (principal) =>
          accessService.removePassword(principal, input, originOf(ctx)),
        ),
      ),
  }),

  brandGrants: router({
    set: tenantMutation
      .input(BrandGrantSet)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => accessService.setBrandGrant(ctx.tenant.actor, input, tx)),
      ),
  }),

  servicePrincipals: router({
    create: tenantMutation
      .input(ServicePrincipalCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          accessService.createServicePrincipal(ctx.tenant.actor, input, tx),
        ),
      ),
    revoke: tenantMutation.input(ServicePrincipalRevoke).mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), async (tx) => {
        await accessService.revokeServicePrincipal(ctx.tenant.actor, input, tx);
        return { ok: true };
      }),
    ),
  }),

  apiClients: router({
    create: tenantMutation
      .input(ApiClientCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => accessService.createApiClient(ctx.tenant.actor, input, tx)),
      ),
    rotate: tenantMutation
      .input(ApiClientRotate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => accessService.rotateApiClient(ctx.tenant.actor, input, tx)),
      ),
  }),

  /** Spec 5.7: a second operator, inside their own support session on the tenant, escalates another's session. */
  supportSessions: router({
    escalate: tenantMutation
      .input(SupportSessionEscalate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          accessService.escalateSupportSession(ctx.tenant.actor, input, tx),
        ),
      ),
  }),
});
