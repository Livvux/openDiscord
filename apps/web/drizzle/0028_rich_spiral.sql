CREATE TABLE "community_asset" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"community_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_asset_name_valid" CHECK ("community_asset"."name" ~ '^[a-z0-9_]{2,32}$'),
	CONSTRAINT "community_asset_kind_valid" CHECK ("community_asset"."kind" in ('emoji', 'sticker'))
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "community_asset" ADD CONSTRAINT "community_asset_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_asset_name_idx" ON "community_asset" USING btree ("community_id","name");--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_asset_id_community_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."community_asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_asset_idx" ON "attachment" USING btree ("asset_id");--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_asset_link_valid" CHECK ("attachment"."asset_id" is null or ("attachment"."message_id" is null and "attachment"."channel_id" is null and "attachment"."linked_at" is not null));