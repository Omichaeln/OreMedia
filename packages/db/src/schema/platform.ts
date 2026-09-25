import { json, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, ts, updatedAt } from './_columns';

export const providerReviewStatuses = mysqlTable('provider_review_statuses', {
  providerKey: varchar('provider_key', { length: 40 }).primaryKey(),
  status: mysqlEnum('status', ['unknown', 'under_review', 'approved', 'rejected', 'action_required'])
    .notNull()
    .default('unknown'),
  source: varchar('source', { length: 32 }).notNull().default('gmail'),
  lastMessageId: varchar('last_message_id', { length: 200 }),
  lastSubject: varchar('last_subject', { length: 500 }),
  lastSender: varchar('last_sender', { length: 320 }),
  lastReceivedAt: ts('last_received_at'),
  lastCheckedAt: ts('last_checked_at').notNull(),
  evidence: json('evidence').$type<{
    providerGroup: 'meta' | 'linkedin';
    matchedTerms: string[];
    snippet?: string;
  }>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
