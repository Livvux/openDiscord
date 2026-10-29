CREATE TABLE "message_send" (
	"user_id" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"message_id" uuid,
	CONSTRAINT "message_send_user_id_transaction_id_pk" PRIMARY KEY("user_id","transaction_id")
);
--> statement-breakpoint
ALTER TABLE "message_send" ADD CONSTRAINT "message_send_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_send" ADD CONSTRAINT "message_send_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_send" ADD CONSTRAINT "message_send_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_send_channel_idx" ON "message_send" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "message_send_message_idx" ON "message_send" USING btree ("message_id");