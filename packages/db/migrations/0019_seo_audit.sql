CREATE TABLE `seo_audit_pages` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`run_id` varchar(32) NOT NULL,
	`url` varchar(2000) NOT NULL,
	`url_hash` char(64) NOT NULL,
	`depth` int NOT NULL,
	`status` int,
	`bytes` int NOT NULL DEFAULT 0,
	`severity` enum('ok','critical','major','minor') NOT NULL DEFAULT 'ok',
	`checks` json NOT NULL DEFAULT ('[]'),
	`title` varchar(300),
	`meta_description` varchar(500),
	`links` json NOT NULL DEFAULT ('[]'),
	`fetched_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `seo_audit_pages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_seo_audit_page` UNIQUE(`tenant_id`,`run_id`,`url_hash`),
	CONSTRAINT `uq_seo_audit_page_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `seo_audit_runs` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`destination_id` varchar(32) NOT NULL,
	`origin` varchar(200) NOT NULL,
	`trigger` enum('scheduled','on_demand') NOT NULL,
	`requested_by_id` varchar(32),
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`outcome` enum('running','completed','failed') NOT NULL DEFAULT 'running',
	`reason` varchar(200),
	`pages_crawled` int NOT NULL DEFAULT 0,
	`limits_hit` json NOT NULL DEFAULT ('[]'),
	`robots_disallow` json NOT NULL DEFAULT ('[]'),
	`summary` json NOT NULL DEFAULT ('{"critical":0,"major":0,"minor":0,"byCheck":{}}'),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `seo_audit_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_seo_audit_run_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `seo_audit_pages` ADD CONSTRAINT `fk_seo_audit_page_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seo_audit_pages` ADD CONSTRAINT `fk_seo_audit_page_run` FOREIGN KEY (`tenant_id`,`brand_id`,`run_id`) REFERENCES `seo_audit_runs`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seo_audit_runs` ADD CONSTRAINT `fk_seo_audit_run_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seo_audit_runs` ADD CONSTRAINT `fk_seo_audit_run_destination` FOREIGN KEY (`tenant_id`,`brand_id`,`destination_id`) REFERENCES `brand_destinations`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_seo_audit_page_severity` ON `seo_audit_pages` (`tenant_id`,`brand_id`,`run_id`,`severity`,`id`);--> statement-breakpoint
CREATE INDEX `ix_seo_audit_run_destination` ON `seo_audit_runs` (`tenant_id`,`brand_id`,`destination_id`,`started_at`);