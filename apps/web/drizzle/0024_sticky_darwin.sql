CREATE TABLE "ban_appeal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"community_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"ban_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolution_note" text,
	"resolved_by" text,
	CONSTRAINT "ban_appeal_content_length" CHECK (char_length("ban_appeal"."content") between 1 and 2000),
	CONSTRAINT "ban_appeal_resolution" CHECK (("ban_appeal"."resolved_at" is null and "ban_appeal"."resolution" is null) or ("ban_appeal"."resolved_at" is not null and "ban_appeal"."resolution" in ('uphold', 'unban')))
);
--> statement-breakpoint
ALTER TABLE "ban" ADD COLUMN "id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "rules" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "rules_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "rules_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "rules_accepted_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ban_appeal" ADD CONSTRAINT "ban_appeal_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ban_appeal" ADD CONSTRAINT "ban_appeal_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ban_appeal" ADD CONSTRAINT "ban_appeal_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ban_appeal_issuance_idx" ON "ban_appeal" USING btree ("ban_id");--> statement-breakpoint
CREATE INDEX "ban_appeal_community_idx" ON "ban_appeal" USING btree ("community_id","created_at");--> statement-breakpoint
CREATE INDEX "ban_appeal_resolved_idx" ON "ban_appeal" USING btree ("resolved_at");--> statement-breakpoint
ALTER TABLE "ban" ADD CONSTRAINT "ban_id_unique" UNIQUE("id");