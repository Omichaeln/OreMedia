CREATE TABLE `brand_guideline_authors` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`author_kind` enum('user','service_principal') NOT NULL,
	`author_id` varchar(32) NOT NULL,
	`package_hash` char(64),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `brand_guideline_authors_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `brand_guideline_authors` ADD CONSTRAINT `fk_guideline_author_version` FOREIGN KEY (`tenant_id`,`brand_id`,`id`) REFERENCES `brand_versions`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;