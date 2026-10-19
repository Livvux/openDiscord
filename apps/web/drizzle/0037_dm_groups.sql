CREATE TABLE "dm_member" (
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "dm_member_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "dm_conversation" DROP CONSTRAINT "dm_conversation_requested_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "dm_conversation" ALTER COLUMN "first_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_conversation" ALTER COLUMN "second_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_conversation" ALTER COLUMN "requested_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_conversation" ADD COLUMN "kind" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_conversation" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "dm_member" ADD CONSTRAINT "dm_member_conversation_id_dm_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."dm_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_member" ADD CONSTRAINT "dm_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dm_member_user_idx" ON "dm_member" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "dm_conversation" ADD CONSTRAINT "dm_conversation_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversation" ADD CONSTRAINT "dm_conversation_kind_valid" CHECK (("dm_conversation"."kind" = 'direct' and "dm_conversation"."first_id" is not null and "dm_conversation"."second_id" is not null and "dm_conversation"."name" is null) or ("dm_conversation"."kind" = 'group' and "dm_conversation"."first_id" is null and "dm_conversation"."second_id" is null and "dm_conversation"."status" = 'accepted'));--> statement-breakpoint
-- A group without active members is gone, ciphertext included (also when the last member's account is deleted).
CREATE FUNCTION "dm_group_cleanup"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "dm_conversation" c WHERE c."id" = OLD."conversation_id" AND c."kind" = 'group'
    AND NOT EXISTS (SELECT 1 FROM "dm_member" m WHERE m."conversation_id" = c."id" AND m."left_at" IS NULL);
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "dm_member_cleanup" AFTER DELETE OR UPDATE OF "left_at" ON "dm_member" FOR EACH ROW EXECUTE FUNCTION "dm_group_cleanup"();
