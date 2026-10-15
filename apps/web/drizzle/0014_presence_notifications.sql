CREATE TABLE "user_presence" (
	"user_id" text PRIMARY KEY NOT NULL,
	"visible" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "notifications" text DEFAULT 'mentions' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;