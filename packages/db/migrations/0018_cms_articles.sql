ALTER TABLE `channel_variants` MODIFY COLUMN `channel_connection_id` varchar(32);--> statement-breakpoint
ALTER TABLE `publication_remote_changes` MODIFY COLUMN `kind` enum('edit','delete','unpublish') NOT NULL;--> statement-breakpoint
ALTER TABLE `publications` MODIFY COLUMN `channel_connection_id` varchar(32);--> statement-breakpoint
ALTER TABLE `remote_evidence` MODIFY COLUMN `kind` enum('accepted_response','status_poll','reconciliation','human_confirmation','metrics_readback','remote_edit','remote_deletion','remote_readback','rendered_validation','remote_unpublish') NOT NULL;--> statement-breakpoint
ALTER TABLE `channel_variants` ADD `destination_id` varchar(32);--> statement-breakpoint
ALTER TABLE `publications` ADD `destination_id` varchar(32);--> statement-breakpoint
ALTER TABLE `channel_variants` ADD CONSTRAINT `uq_variant_destination` UNIQUE(`tenant_id`,`content_revision_id`,`destination_id`);--> statement-breakpoint
ALTER TABLE `channel_variants` ADD CONSTRAINT `ck_variant_target` CHECK ((`channel_variants`.`channel_connection_id` is null) <> (`channel_variants`.`destination_id` is null));--> statement-breakpoint
ALTER TABLE `publications` ADD CONSTRAINT `ck_publication_target` CHECK ((`publications`.`channel_connection_id` is null) <> (`publications`.`destination_id` is null));--> statement-breakpoint
ALTER TABLE `channel_variants` ADD CONSTRAINT `fk_variant_destination` FOREIGN KEY (`tenant_id`,`brand_id`,`destination_id`) REFERENCES `brand_destinations`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publications` ADD CONSTRAINT `fk_publication_destination` FOREIGN KEY (`tenant_id`,`brand_id`,`destination_id`) REFERENCES `brand_destinations`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_publication_destination` ON `publications` (`tenant_id`,`destination_id`);