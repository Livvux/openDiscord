ALTER TABLE "community" ADD COLUMN "discoverable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "community" ADD COLUMN "description" text DEFAULT '' NOT NULL;