ALTER TABLE "channel_override" DROP CONSTRAINT "channel_override_bits";--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_override" ADD CONSTRAINT "channel_override_bits" CHECK ("channel_override"."allow" & "channel_override"."deny" = 0 and ("channel_override"."allow" | "channel_override"."deny") & ~7440 = 0);--> statement-breakpoint
-- Existing members can join and speak in voice channels: Connect (1 << 11) and Speak (1 << 12) go to every default role.
UPDATE "role" SET "permissions" = "permissions" | 6144 WHERE "is_default";
