CREATE TABLE `report_preferences` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`auto_draft` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `report_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_report_preference_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`),
	CONSTRAINT `uq_report_preference_brand` UNIQUE(`tenant_id`,`brand_id`)
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`period_month` varchar(7) NOT NULL,
	`compare_mode` enum('previous_month','last_year') NOT NULL DEFAULT 'previous_month',
	`sections` json NOT NULL,
	`executive_summary` text NOT NULL,
	`recommendations` text NOT NULL,
	`prepared_for` varchar(200) NOT NULL DEFAULT '',
	`prepared_by` varchar(200) NOT NULL DEFAULT '',
	`theme` enum('dark','light') NOT NULL DEFAULT 'dark',
	`state` enum('draft','sent') NOT NULL DEFAULT 'draft',
	`sent_at` datetime(3),
	`sent_to` varchar(320),
	`sent_by_user_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `reports_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_report_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`),
	CONSTRAINT `uq_report_month` UNIQUE(`tenant_id`,`brand_id`,`period_month`)
);
--> statement-breakpoint
ALTER TABLE `report_preferences` ADD CONSTRAINT `fk_report_preference_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reports` ADD CONSTRAINT `fk_report_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_report_updated` ON `reports` (`tenant_id`,`brand_id`,`updated_at`);