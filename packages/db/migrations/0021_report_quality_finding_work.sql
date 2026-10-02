CREATE TABLE `seo_finding_work` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`destination_id` varchar(32) NOT NULL,
	`run_id` varchar(32) NOT NULL,
	`check_key` varchar(40) NOT NULL,
	`severity` enum('critical','major','minor') NOT NULL,
	`page_count` int NOT NULL DEFAULT 0,
	`examples` json NOT NULL DEFAULT ('[]'),
	`work_type` varchar(40) NOT NULL,
	`work_id` varchar(32) NOT NULL,
	`created_by_id` varchar(32) NOT NULL,
	`resolved_at` datetime(3),
	`resolved_run_id` varchar(32),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `seo_finding_work_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_seo_finding_work_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`),
	CONSTRAINT `uq_seo_finding_work_finding` UNIQUE(`tenant_id`,`destination_id`,`run_id`,`check_key`)
);
--> statement-breakpoint
ALTER TABLE `brand_destinations` ADD `reporting_time_zone` varchar(64);--> statement-breakpoint
ALTER TABLE `brand_destinations` ADD `currency_code` varchar(3);--> statement-breakpoint
ALTER TABLE `brand_destinations` ADD `reporting_zone_checked_at` datetime(3);--> statement-breakpoint
ALTER TABLE `destination_report_rows` ADD `time_zone` varchar(64);--> statement-breakpoint
ALTER TABLE `destination_report_rows` ADD `quality` json;--> statement-breakpoint
ALTER TABLE `seo_finding_work` ADD CONSTRAINT `fk_seo_finding_work_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seo_finding_work` ADD CONSTRAINT `fk_seo_finding_work_destination` FOREIGN KEY (`tenant_id`,`brand_id`,`destination_id`) REFERENCES `brand_destinations`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seo_finding_work` ADD CONSTRAINT `fk_seo_finding_work_run` FOREIGN KEY (`tenant_id`,`brand_id`,`run_id`) REFERENCES `seo_audit_runs`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_seo_finding_work_open` ON `seo_finding_work` (`tenant_id`,`brand_id`,`destination_id`,`check_key`,`resolved_at`);