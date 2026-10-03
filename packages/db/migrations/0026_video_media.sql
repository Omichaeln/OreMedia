ALTER TABLE `render_jobs` MODIFY COLUMN `state` enum('pending','rendering','ready','failed','cancelled') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `asset_versions` ADD `media_info` json;--> statement-breakpoint
ALTER TABLE `upload_intents` ADD `rejection_detail` varchar(300);--> statement-breakpoint
ALTER TABLE `render_jobs` ADD `progress` json;--> statement-breakpoint
ALTER TABLE `rendered_exports` ADD `duration_ms` int;--> statement-breakpoint
ALTER TABLE `rendered_exports` ADD `fps` int;--> statement-breakpoint
ALTER TABLE `rendered_exports` ADD `poster_storage_key` varchar(300);--> statement-breakpoint
ALTER TABLE `rendered_exports` ADD `captions_storage_key` varchar(300);