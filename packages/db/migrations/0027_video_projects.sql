ALTER TABLE `creative_documents` ADD `kind` enum('graphic','video') DEFAULT 'graphic' NOT NULL;--> statement-breakpoint
ALTER TABLE `rendered_exports` ADD `dedupe_key` char(64);--> statement-breakpoint
CREATE INDEX `ix_export_dedupe` ON `rendered_exports` (`tenant_id`,`brand_id`,`dedupe_key`);