CREATE TABLE `destination_report_rows` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`destination_id` varchar(32) NOT NULL,
	`report_key` varchar(60) NOT NULL,
	`date` varchar(10) NOT NULL,
	`dimensions` json NOT NULL,
	`dimension_key` varchar(200) NOT NULL,
	`metrics` json NOT NULL,
	`fetched_at` datetime(3) NOT NULL,
	`source` varchar(40) NOT NULL DEFAULT 'provider',
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `destination_report_rows_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_destination_report_row` UNIQUE(`tenant_id`,`destination_id`,`report_key`,`date`,`dimension_key`),
	CONSTRAINT `uq_destination_report_row_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `destination_report_rows` ADD CONSTRAINT `fk_destination_report_row_brand` FOREIGN KEY (`tenant_id`,`brand_id`) REFERENCES `brands`(`tenant_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_destination_report_window` ON `destination_report_rows` (`tenant_id`,`brand_id`,`destination_id`,`report_key`,`date`);