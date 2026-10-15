CREATE TABLE "public_channel" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"generation" uuid DEFAULT uuidv7() NOT NULL,
	"community_title" text NOT NULL,
	"channel_title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unpublished_at" timestamp with time zone,
	CONSTRAINT "public_channel_generation_unique" UNIQUE("generation"),
	CONSTRAINT "public_channel_title_length" CHECK (char_length("public_channel"."community_title") between 1 and 80 and char_length("public_channel"."channel_title") between 1 and 32)
);
--> statement-breakpoint
CREATE TABLE "public_post" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "public_channel" ADD CONSTRAINT "public_channel_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_post" ADD CONSTRAINT "public_post_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_post" ADD CONSTRAINT "public_post_channel_id_public_channel_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."public_channel"("channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "public_post_channel_idx" ON "public_post" USING btree ("channel_id","message_id");