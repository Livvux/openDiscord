CREATE TABLE "friendship" (
	"first_id" text NOT NULL,
	"second_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendship_first_id_second_id_pk" PRIMARY KEY("first_id","second_id"),
	CONSTRAINT "friendship_ordered" CHECK ("friendship"."first_id" collate "C" < "friendship"."second_id" collate "C")
);
--> statement-breakpoint
CREATE TABLE "user_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"custom_status" text DEFAULT '' NOT NULL,
	CONSTRAINT "user_profile_length" CHECK (char_length("user_profile"."bio") <= 190 and char_length("user_profile"."custom_status") <= 80)
);
--> statement-breakpoint
ALTER TABLE "user_presence" ADD COLUMN "status" text DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_first_id_user_id_fk" FOREIGN KEY ("first_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_second_id_user_id_fk" FOREIGN KEY ("second_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friendship_second_idx" ON "friendship" USING btree ("second_id");