CREATE TABLE `publication_remote_changes` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`publication_id` varchar(32) NOT NULL,
	`kind` enum('edit','delete') NOT NULL,
	`state` enum('requested','succeeded','failed') NOT NULL,
	`text` text,
	`text_hash` char(64),
	`reason` varchar(500),
	`requested_by_kind` enum('user','service_principal') NOT NULL,
	`requested_by_id` varchar(32) NOT NULL,
	`requested_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`error_code` varchar(80),
	`error_detail` varchar(2000),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `publication_remote_changes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_remote_change_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `publications` MODIFY COLUMN `state` enum('scheduled','dispatching','processing','published','failed','outcome_unknown','retry_eligible','cancelled','held','removed') NOT NULL;--> statement-breakpoint
ALTER TABLE `remote_evidence` MODIFY COLUMN `kind` enum('accepted_response','status_poll','reconciliation','human_confirmation','metrics_readback','remote_edit','remote_deletion') NOT NULL;--> statement-breakpoint
ALTER TABLE `publication_remote_changes` ADD CONSTRAINT `fk_remote_change_publication` FOREIGN KEY (`tenant_id`,`brand_id`,`publication_id`) REFERENCES `publications`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_remote_change_publication` ON `publication_remote_changes` (`tenant_id`,`publication_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `ix_remote_change_open` ON `publication_remote_changes` (`state`,`requested_at`);