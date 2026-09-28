import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** One entry per community.* procedure, every id pointing at the foreign tenant's rows from COMMUNITY_SEED (spec 19.3). */
export const COMMUNITY_INPUTS: Record<string, CrossTenantFixture> = {
  'community.conversations.list': {
    buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }),
  },
  'community.messages.list': { buildInput: (f) => ({ conversationId: f['communityConversationId'] }) },
  'community.reply': {
    buildInput: (f) => ({ messageId: f['communityMessageId'], text: 'Thanks for asking' }),
  },
};
