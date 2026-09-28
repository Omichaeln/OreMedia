import { sql } from 'drizzle-orm';
import { conversations, messages, responseDrafts } from '@oremedia/db/schema/community';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/**
 * One comment conversation with an inbound comment and a response draft per tenant, so a foreign caller has every
 * comment inbox id to try (spec 19.3 community.*). The conversation references no real connection (there is no
 * foreign key to it). Written with sql``, naming only the columns every head has: the migration roll-forward suites
 * seed databases at earlier heads, before messages.parent_remote_message_id and the reply columns of drafts (0012).
 */
export const COMMUNITY_SEED: SeedExtension = async (db, { tenantId, brandIds }) => {
  const brandId = brandIds[0];
  const communityConversationId = newId('conversation');
  const communityMessageId = newId('message');
  const responseDraftId = newId('responseDraft');
  const now = new Date();
  await db.execute(
    sql`insert into ${conversations} (id, tenant_id, brand_id, channel_connection_id, remote_thread_id, state, last_message_at, created_at, updated_at, version) values (${communityConversationId}, ${tenantId}, ${brandId}, ${newId('channelConnection')}, ${`post_${communityConversationId.slice(-8)}`}, 'open', ${now}, ${now}, ${now}, 0)`,
  );
  await db.execute(
    sql`insert into ${messages} (id, tenant_id, brand_id, conversation_id, remote_message_id, direction, author_hash, author_handle, text, remote_created_at, created_at) values (${communityMessageId}, ${tenantId}, ${brandId}, ${communityConversationId}, ${`c_${communityMessageId.slice(-8)}`}, 'inbound', ${'a'.repeat(64)}, '@seeded', 'Seeded comment', ${now}, ${now})`,
  );
  await db.execute(
    sql`insert into ${responseDrafts} (id, tenant_id, brand_id, conversation_id, author_kind, author_id, text, fact_refs, state, created_at, updated_at, version) values (${responseDraftId}, ${tenantId}, ${brandId}, ${communityConversationId}, 'user', 'usr_seeded', 'Seeded reply', '[]', 'draft', ${now}, ${now}, 0)`,
  );
  return { communityConversationId, communityMessageId, responseDraftId };
};
