ALTER TABLE `response_drafts` MODIFY COLUMN `state` enum('draft','sent','discarded','queued','sending','failed','outcome_unknown') NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE `messages` ADD `parent_remote_message_id` varchar(200);--> statement-breakpoint
ALTER TABLE `response_drafts` ADD `reply_to_message_id` varchar(32);--> statement-breakpoint
ALTER TABLE `response_drafts` ADD `sent_at` datetime(3);--> statement-breakpoint
ALTER TABLE `response_drafts` ADD `outbound_message_id` varchar(32);--> statement-breakpoint
ALTER TABLE `response_drafts` ADD `failure_code` varchar(100);--> statement-breakpoint
ALTER TABLE `response_drafts` ADD `failure_detail` varchar(500);