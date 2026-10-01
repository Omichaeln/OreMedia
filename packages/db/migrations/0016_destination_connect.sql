CREATE TABLE `pending_destination_grants` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`kind` varchar(40) NOT NULL,
	`actor_kind` varchar(24) NOT NULL,
	`actor_id` varchar(32) NOT NULL,
	`destination_id` varchar(32) NOT NULL,
	`granted_scopes` json NOT NULL,
	`token_expires_at` datetime(3),
	`targets` json NOT NULL,
	`kms_key_id` varchar(200) NOT NULL,
	`wrapped_data_key` varbinary(512) NOT NULL,
	`ciphertext` varbinary(8192) NOT NULL,
	`iv` varbinary(12) NOT NULL,
	`auth_tag` varbinary(16) NOT NULL,
	`aad` varchar(200) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `pending_destination_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_pending_destination_grant_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `source_use_policies` MODIFY COLUMN `version` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `brand_destinations` ADD `token_expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `pending_destination_grants` ADD CONSTRAINT `fk_pending_destination_grant_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_pending_destination_grant_expiry` ON `pending_destination_grants` (`tenant_id`,`expires_at`);