CREATE TABLE "user_block" (
	"blocker_id" text NOT NULL,
	"blocked_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_block_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "invites_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "min_account_age_hours" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "raid_join_limit" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_block" ADD CONSTRAINT "user_block_blocker_id_user_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_block" ADD CONSTRAINT "user_block_blocked_id_user_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_block_blocked_idx" ON "user_block" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "member_joined_idx" ON "member" USING btree ("community_id","joined_at");