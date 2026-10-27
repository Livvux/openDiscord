ALTER TABLE "community" ADD COLUMN "icon_id" uuid;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "banner_id" uuid;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "community" ADD CONSTRAINT "community_icon_id_attachment_id_fk" FOREIGN KEY ("icon_id") REFERENCES "public"."attachment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community" ADD CONSTRAINT "community_banner_id_attachment_id_fk" FOREIGN KEY ("banner_id") REFERENCES "public"."attachment"("id") ON DELETE set null ON UPDATE no action;