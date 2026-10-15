CREATE TABLE "application_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"hits" bigint[] NOT NULL,
	"window_start" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stream_lease" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stream_lease" ADD CONSTRAINT "stream_lease_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_rate_limit_window_idx" ON "application_rate_limit" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "stream_lease_user_scope_idx" ON "stream_lease" USING btree ("user_id","scope");--> statement-breakpoint
CREATE INDEX "stream_lease_expiry_idx" ON "stream_lease" USING btree ("expires_at");