CREATE TABLE "dm_read_state" (
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_read_id" uuid NOT NULL,
	CONSTRAINT "dm_read_state_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "dm_read_state" ADD CONSTRAINT "dm_read_state_conversation_id_dm_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."dm_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_read_state" ADD CONSTRAINT "dm_read_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Existing history counts as read: unread starts with messages that arrive after this release.
INSERT INTO "dm_read_state" ("conversation_id", "user_id", "last_read_id")
SELECT c."id", p."user_id", m."last_id"
FROM "dm_conversation" c
CROSS JOIN LATERAL (VALUES (c."first_id"), (c."second_id")) AS p("user_id")
JOIN LATERAL (SELECT max("id"::text)::uuid AS "last_id" FROM "dm_message" WHERE "conversation_id" = c."id") m ON m."last_id" IS NOT NULL
ON CONFLICT DO NOTHING;
