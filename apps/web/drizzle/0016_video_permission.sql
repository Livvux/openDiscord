ALTER TABLE "channel_override" DROP CONSTRAINT "channel_override_bits";--> statement-breakpoint
ALTER TABLE "channel_override" ADD CONSTRAINT "channel_override_bits" CHECK ("channel_override"."allow" & "channel_override"."deny" = 0 and ("channel_override"."allow" | "channel_override"."deny") & ~15632 = 0);--> statement-breakpoint
-- Existing members may use camera and screen sharing in voice channels: Video (1 << 13) goes to every default role.
UPDATE "role" SET "permissions" = "permissions" | 8192 WHERE "is_default";
