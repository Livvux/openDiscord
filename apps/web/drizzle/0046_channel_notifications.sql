CREATE TABLE "channel_notification" (
	"user_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "channel_notification_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id"),
	CONSTRAINT "channel_notification_level" CHECK ("channel_notification"."level" in ('mentions', 'muted'))
);
--> statement-breakpoint
ALTER TABLE "channel_notification" ADD CONSTRAINT "channel_notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_notification" ADD CONSTRAINT "channel_notification_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_notification_channel_idx" ON "channel_notification" USING btree ("channel_id");