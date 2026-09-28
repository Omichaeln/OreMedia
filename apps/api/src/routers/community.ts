import { CommentReply, ConversationList, ConversationMessagesList } from '@oremedia/contracts/community';
import { communityService } from '@oremedia/module-community';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/**
 * Comment inbox: a brand's comment conversations (newest activity first), one conversation threaded by parent, and
 * a person's reply to an inbound comment (inbox.respond), posted on the platform by communityReplyWorkflowV1.
 */
export const communityRouter = router({
  conversations: router({
    list: tenantQuery
      .input(ConversationList)
      .query(({ ctx, input }) => communityService.conversations.list(ctx.tenant.actor, input)),
  }),
  messages: router({
    list: tenantQuery
      .input(ConversationMessagesList)
      .query(({ ctx, input }) => communityService.messages.list(ctx.tenant.actor, input)),
  }),
  reply: tenantMutation
    .input(CommentReply)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => communityService.reply(ctx.tenant.actor, input, tx)),
    ),
});
