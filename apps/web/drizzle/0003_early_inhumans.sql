CREATE TABLE "abuse_report" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"reporter_id" text,
	"community_id" uuid NOT NULL,
	"message_id" uuid,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_verification" (
	"session_id" text PRIMARY KEY NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_admin" (
	"user_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" text PRIMARY KEY DEFAULT 'instance' NOT NULL,
	"registration_open" boolean DEFAULT true NOT NULL,
	"invite_mode" text DEFAULT 'members' NOT NULL,
	"owned_communities" integer DEFAULT 25 NOT NULL,
	"channels_per_community" integer DEFAULT 200 NOT NULL,
	"roles_per_community" integer DEFAULT 100 NOT NULL,
	"active_invites_per_community" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "instance_settings_singleton" CHECK ("instance_settings"."id" = 'instance')
);
--> statement-breakpoint
CREATE TABLE "user_suspension" (
	"user_id" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "abuse_report" ADD CONSTRAINT "abuse_report_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_report" ADD CONSTRAINT "abuse_report_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_verification" ADD CONSTRAINT "admin_verification_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_admin" ADD CONSTRAINT "instance_admin_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_audit_log" ADD CONSTRAINT "instance_audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_suspension" ADD CONSTRAINT "user_suspension_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_report_status_idx" ON "abuse_report" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "instance_audit_log_created_idx" ON "instance_audit_log" USING btree ("created_at");--> statement-breakpoint
-- Keep the 2FA requirement atomic with concurrent administrator grants.
CREATE FUNCTION protect_instance_admin_2fa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.two_factor_enabled IS TRUE AND NEW.two_factor_enabled IS DISTINCT FROM TRUE
     AND EXISTS (SELECT 1 FROM instance_admin WHERE user_id = NEW.id) THEN
    RAISE EXCEPTION 'Two-factor authentication is mandatory for instance administrators';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER protect_instance_admin_2fa BEFORE UPDATE OF two_factor_enabled ON "user"
FOR EACH ROW EXECUTE FUNCTION protect_instance_admin_2fa();
