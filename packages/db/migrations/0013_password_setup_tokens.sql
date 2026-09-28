CREATE TABLE `password_setup_tokens` (
	`id` varchar(32) NOT NULL,
	`tenant_id` varchar(32) NOT NULL,
	`user_id` varchar(32) NOT NULL,
	`created_by_user_id` varchar(32) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `password_setup_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_password_setup_token` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `password_origin` enum('self','setup_link');--> statement-breakpoint
ALTER TABLE `password_setup_tokens` ADD CONSTRAINT `fk_password_setup_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `password_setup_tokens` ADD CONSTRAINT `fk_password_setup_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_password_setup_user` ON `password_setup_tokens` (`tenant_id`,`user_id`);