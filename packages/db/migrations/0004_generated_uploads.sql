CREATE TABLE `generated_uploads` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`provenance` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `generated_uploads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `generated_uploads` ADD CONSTRAINT `fk_generated_upload_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;