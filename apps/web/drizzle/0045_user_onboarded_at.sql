ALTER TABLE "user" ADD COLUMN "onboarded_at" timestamp;--> statement-breakpoint
-- Existing accounts already know their way around; only new sign-ups see the onboarding.
UPDATE "user" SET "onboarded_at" = now();