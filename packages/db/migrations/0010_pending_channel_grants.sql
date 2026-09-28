CREATE TABLE `pending_channel_grants` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`pending_id` varchar(32) NOT NULL,
	`provider_key` varchar(40) NOT NULL,
	`actor_kind` varchar(24) NOT NULL,
	`actor_id` varchar(32) NOT NULL,
	`position` int NOT NULL,
	`remote_account_id` varchar(200) NOT NULL,
	`display_name` varchar(200) NOT NULL,
	`channel_connection_id` varchar(32) NOT NULL,
	`granted_scopes` json NOT NULL,
	`token_expires_at` datetime(3),
	`kms_key_id` varchar(200) NOT NULL,
	`wrapped_data_key` varbinary(512) NOT NULL,
	`ciphertext` varbinary(8192) NOT NULL,
	`iv` varbinary(12) NOT NULL,
	`auth_tag` varbinary(16) NOT NULL,
	`aad` varchar(200) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `pending_channel_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_pending_grant_option` UNIQUE(`tenant_id`,`pending_id`,`remote_account_id`)
);
--> statement-breakpoint
ALTER TABLE `pending_channel_grants` ADD CONSTRAINT `fk_pending_grant_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_pending_grant_expiry` ON `pending_channel_grants` (`tenant_id`,`expires_at`);