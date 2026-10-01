CREATE TABLE `plan_items` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`brief_id` varchar(32) NOT NULL,
	`date` varchar(10) NOT NULL,
	`channel_key` varchar(60) NOT NULL,
	`channel_connection_id` varchar(32),
	`theme` varchar(300) NOT NULL,
	`format_key` varchar(60) NOT NULL,
	`fact_ids` json NOT NULL,
	`state` enum('proposed','dropped','materialised') NOT NULL DEFAULT 'proposed',
	`content_package_id` varchar(32),
	`created_by_kind` enum('user','agent') NOT NULL,
	`created_by_id` varchar(32) NOT NULL,
	`agent_run_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `plan_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_plan_item_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `plan_items` ADD CONSTRAINT `fk_plan_item_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_plan_item_brief` ON `plan_items` (`tenant_id`,`brand_id`,`brief_id`,`date`);