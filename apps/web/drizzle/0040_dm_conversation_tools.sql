ALTER TABLE "dm_message" ADD COLUMN "kind" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_message" ADD COLUMN "target_id" uuid;--> statement-breakpoint
ALTER TABLE "dm_message" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "dm_message_target_idx" ON "dm_message" USING btree ("conversation_id","target_id");--> statement-breakpoint
ALTER TABLE "dm_message" ADD CONSTRAINT "dm_message_operation_valid" CHECK (("dm_message"."kind" = 'message' and "dm_message"."target_id" is null) or ("dm_message"."kind" in ('edit', 'reaction', 'delete') and "dm_message"."target_id" is not null));