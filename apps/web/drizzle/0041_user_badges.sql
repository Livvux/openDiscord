CREATE TABLE "user_badge" (
	"user_id" text NOT NULL,
	"badge" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_badge_user_id_badge_pk" PRIMARY KEY("user_id","badge")
);
--> statement-breakpoint
ALTER TABLE "user_badge" ADD CONSTRAINT "user_badge_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;