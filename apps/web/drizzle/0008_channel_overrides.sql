CREATE TABLE "channel_override" (
	"channel_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"allow" integer DEFAULT 0 NOT NULL,
	"deny" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "channel_override_channel_id_role_id_pk" PRIMARY KEY("channel_id","role_id"),
	CONSTRAINT "channel_override_bits" CHECK ("channel_override"."allow" & "channel_override"."deny" = 0 and ("channel_override"."allow" | "channel_override"."deny") & ~1296 = 0)
);
--> statement-breakpoint
ALTER TABLE "channel_override" ADD CONSTRAINT "channel_override_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_override" ADD CONSTRAINT "channel_override_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_override_role_idx" ON "channel_override" USING btree ("role_id");--> statement-breakpoint
-- Existing members keep seeing every channel: the new ViewChannels bit (1 << 10) goes to every default role.
UPDATE "role" SET "permissions" = "permissions" | 1024 WHERE "is_default";
