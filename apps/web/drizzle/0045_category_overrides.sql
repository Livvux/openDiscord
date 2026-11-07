CREATE TABLE "category_override" (
	"category_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"allow" integer DEFAULT 0 NOT NULL,
	"deny" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "category_override_category_id_role_id_pk" PRIMARY KEY("category_id","role_id"),
	CONSTRAINT "category_override_bits" CHECK ("category_override"."allow" & "category_override"."deny" = 0 and ("category_override"."allow" | "category_override"."deny") & ~15632 = 0)
);
--> statement-breakpoint
ALTER TABLE "category_override" ADD CONSTRAINT "category_override_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_override" ADD CONSTRAINT "category_override_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_override_role_idx" ON "category_override" USING btree ("role_id");