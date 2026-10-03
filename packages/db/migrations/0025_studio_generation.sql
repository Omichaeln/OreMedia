CREATE TABLE `studio_generation_jobs` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`brand_id` varchar(32) NOT NULL,
	`document_id` varchar(32) NOT NULL,
	`base_revision_id` varchar(32) NOT NULL,
	`kind` enum('generate','refine') NOT NULL,
	`state` enum('queued','generating','validating','saving','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`progress` int NOT NULL DEFAULT 0,
	`request` json NOT NULL,
	`inputs_hash` char(64) NOT NULL,
	`attempt` int NOT NULL DEFAULT 1,
	`budget_run_id` varchar(32),
	`budget_reservation_id` varchar(32),
	`cost_reserved_micros` bigint NOT NULL DEFAULT 0,
	`cost_spent_micros` bigint NOT NULL DEFAULT 0,
	`model_output` json,
	`result` json,
	`error_code` varchar(40),
	`error` varchar(500),
	`requested_by_kind` enum('user','agent','system') NOT NULL,
	`requested_by_id` varchar(32) NOT NULL,
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`version` int NOT NULL DEFAULT 0,
	CONSTRAINT `studio_generation_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_generation_job_inputs` UNIQUE(`tenant_id`,`document_id`,`base_revision_id`,`inputs_hash`),
	CONSTRAINT `uq_generation_job_tbi` UNIQUE(`tenant_id`,`brand_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `creative_revisions` ADD `generation_inputs` json;--> statement-breakpoint
ALTER TABLE `studio_generation_jobs` ADD CONSTRAINT `fk_generation_job_document` FOREIGN KEY (`tenant_id`,`brand_id`,`document_id`) REFERENCES `creative_documents`(`tenant_id`,`brand_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_generation_job_document` ON `studio_generation_jobs` (`tenant_id`,`document_id`,`state`);