DROP TABLE "admin_verification" CASCADE;--> statement-breakpoint
DROP TRIGGER IF EXISTS protect_instance_admin_2fa ON "user";
--> statement-breakpoint
DROP FUNCTION IF EXISTS protect_instance_admin_2fa();
