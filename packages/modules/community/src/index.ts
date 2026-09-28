// Community (spec 16.10 unified inbox, first slice): the comment inbox. A brand's team reads the comments ingested
// on its published posts (measurement, spec 16.5) threaded by parent and answers them; the answer is posted on the
// platform by communityReplyWorkflowV1 (the runtime below, started by the outbox route on task queue `core`).
export { communityService, POST_EXCERPT_LENGTH, type ThreadItemDto } from './service';
export {
  createCommunityReplyRuntime,
  confirmIngestedOwnReply,
  outboundAuthorHash,
  type CommunityReplyRuntimeOptions,
} from './runtime';
export {
  registerCommunityOutboxRoutes,
  communityReplyWorkflowId,
  COMMUNITY_REPLY_WORKFLOW_TYPE,
} from './outbox-routes';
export { InboxConversationRepository, InboxMessageRepository, ResponseDraftRepository } from './repositories';
