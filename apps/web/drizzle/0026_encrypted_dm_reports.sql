CREATE TABLE "dm_report" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"reporter_id" text,
	"reason" text NOT NULL,
	"excerpt" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dm_report" ADD CONSTRAINT "dm_report_message_id_dm_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."dm_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_report" ADD CONSTRAINT "dm_report_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dm_report_person_message_idx" ON "dm_report" USING btree ("reporter_id","message_id");--> statement-breakpoint
CREATE INDEX "dm_report_queue_idx" ON "dm_report" USING btree ("resolved_at","created_at");