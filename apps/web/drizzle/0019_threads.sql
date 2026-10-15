ALTER TABLE "message" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_id_message_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_thread_idx" ON "message" USING btree ("thread_id","id") WHERE "message"."thread_id" is not null;