CREATE TABLE `brand_destinations` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`kind` varchar(40) NOT NULL,
	`external_id` varchar(200) NOT NULL,
	`display_name` varchar(200) NOT NULL,
	`owner_user_id` varchar(32) NOT NULL,
	`credential_ref_id` varchar(32),
	`granted_scopes` json NOT NULL DEFAULT ('[]'),
	`health` enum('unknown','healthy','degraded','unreachable') NOT NULL DEFAULT 'unknown',
	`health_checked_at` datetime(3),
	`capability_version` int NOT NULL,
	`status` enum('active','disconnected') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `brand_destinations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_destination_remote` UNIQUE(`tenant_id`,`kind`,`external_id`),
	CONSTRAINT `uq_destination_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `source_use_policies` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`destination_kind` varchar(40) NOT NULL,
	`data_type` varchar(80) NOT NULL,
	`allowed_uses` json NOT NULL,
	`retention_days` int,
	`version` int NOT NULL DEFAULT 1,
	`reviewed_at` datetime(3) NOT NULL,
	`review_due_at` datetime(3) NOT NULL,
	`reviewed_by_id` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `source_use_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_source_use_policy` UNIQUE(`tenant_id`,`brand_id`,`destination_kind`,`data_type`),
	CONSTRAINT `uq_source_use_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `brand_destinations` ADD CONSTRAINT `fk_destination_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `source_use_policies` ADD CONSTRAINT `fk_source_use_policy_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;