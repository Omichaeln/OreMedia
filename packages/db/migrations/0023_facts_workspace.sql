ALTER TABLE `approved_facts` MODIFY COLUMN `state` enum('proposed','approved','revoked','superseded') NOT NULL;--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `category` enum('company','product','service','location','contact','differentiator','audience','terminology','claim','faq','offer','price','statistic','legal');--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `scope` varchar(200);--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `origin` enum('user','extracted','inferred','suggested');--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `sources` json;--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `review_due_at` datetime(3);--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `reviewed_by_user_id` varchar(32);--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `reviewed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `superseded_by_fact_id` varchar(32);--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `supersedes_fact_id` varchar(32);--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `revoke_reason` varchar(500);--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `conflicts` json;--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `dedupe_key` char(64);--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `review_flagged_at` datetime(3);--> statement-breakpoint
ALTER TABLE `approved_facts` ADD `expiry_notified_at` datetime(3);--> statement-breakpoint
CREATE INDEX `ix_fact_dedupe` ON `approved_facts` (`tenant_id`,`brand_id`,`dedupe_key`);--> statement-breakpoint
UPDATE `approved_facts` SET `category` = `kind` WHERE `category` IS NULL;--> statement-breakpoint
UPDATE `approved_facts` SET `origin` = IF(`proposed_by_kind` = 'agent', 'suggested', 'user') WHERE `origin` IS NULL;--> statement-breakpoint
UPDATE `approved_facts` SET `sources` = `evidence` WHERE `sources` IS NULL;
