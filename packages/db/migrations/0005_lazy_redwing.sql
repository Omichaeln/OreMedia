CREATE TABLE `provider_review_statuses` (
	`provider_key` varchar(40) NOT NULL,
	`status` enum('unknown','under_review','approved','rejected','action_required') NOT NULL DEFAULT 'unknown',
	`source` varchar(32) NOT NULL DEFAULT 'gmail',
	`last_message_id` varchar(200),
	`last_subject` varchar(500),
	`last_sender` varchar(320),
	`last_received_at` datetime(3),
	`last_checked_at` datetime(3) NOT NULL,
	`evidence` json,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `provider_review_statuses_provider_key` PRIMARY KEY(`provider_key`)
);
