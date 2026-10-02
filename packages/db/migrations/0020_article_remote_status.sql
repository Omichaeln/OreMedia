ALTER TABLE `channel_variants` MODIFY COLUMN `text` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `publication_remote_changes` MODIFY COLUMN `text` mediumtext;--> statement-breakpoint
ALTER TABLE `publications` ADD `remote_status` enum('draft','live','reverted');--> statement-breakpoint
ALTER TABLE `publications` ADD `remote_verification` enum('unverified','verified','failed');--> statement-breakpoint
ALTER TABLE `publications` ADD `remote_verified_at` datetime(3);