ALTER TABLE "voice_call" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_call" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "voice_call" ADD CONSTRAINT "voice_call_conversation_id_dm_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."dm_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_call_active_conversation_idx" ON "voice_call" USING btree ("conversation_id") WHERE "voice_call"."status" = 'active';--> statement-breakpoint
ALTER TABLE "voice_call" ADD CONSTRAINT "voice_call_context" CHECK (num_nonnulls("voice_call"."channel_id", "voice_call"."conversation_id") = 1);