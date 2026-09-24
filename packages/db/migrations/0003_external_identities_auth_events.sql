CREATE TABLE `auth_events` (
	`id` varchar(32) NOT NULL,
	`action` varchar(40) NOT NULL,
	`provider` varchar(24) NOT NULL,
	`decision` enum('allowed','denied') NOT NULL,
	`reason` varchar(120),
	`user_id` varchar(32),
	`session_id` varchar(32),
	`correlation_id` varchar(64) NOT NULL,
	`ip_hash` varchar(64),
	`user_agent_hash` varchar(64),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `auth_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `external_identities` (
	`id` varchar(32) NOT NULL,
	`provider` varchar(24) NOT NULL,
	`subject` varchar(255) NOT NULL,
	`user_id` varchar(32) NOT NULL,
	`email_at_link` varchar(320) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `external_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_external_identity` UNIQUE(`provider`,`subject`),
	CONSTRAINT `uq_external_identity_user` UNIQUE(`provider`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `external_identities` ADD CONSTRAINT `fk_external_identity_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_auth_event_user` ON `auth_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_auth_event_time` ON `auth_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `ix_external_identity_user` ON `external_identities` (`user_id`);