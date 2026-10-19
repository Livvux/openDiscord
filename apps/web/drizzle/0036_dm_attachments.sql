ALTER TABLE "attachment" ADD COLUMN "dm_message_id" uuid;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_dm_message_id_dm_message_id_fk" FOREIGN KEY ("dm_message_id") REFERENCES "public"."dm_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_dm_message_idx" ON "attachment" USING btree ("dm_message_id");