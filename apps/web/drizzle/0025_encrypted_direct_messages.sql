CREATE TABLE "dm_backup" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dm_conversation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"first_id" text NOT NULL,
	"second_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dm_crypto_receipt" (
	"device_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"digest" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_crypto_receipt_device_id_request_id_pk" PRIMARY KEY("device_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "dm_device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"keys" jsonb,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dm_identity" (
	"user_id" text PRIMARY KEY NOT NULL,
	"keys" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dm_key" (
	"device_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"fallback" boolean DEFAULT false NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	CONSTRAINT "dm_key_device_id_key_id_pk" PRIMARY KEY("device_id","key_id")
);
--> statement-breakpoint
CREATE TABLE "dm_mailbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dm_mailbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"device_id" uuid NOT NULL,
	"sender_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dm_message" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dm_signature" (
	"signer_id" text NOT NULL,
	"target_id" text NOT NULL,
	"key_id" text NOT NULL,
	"signatures" jsonb NOT NULL,
	CONSTRAINT "dm_signature_signer_id_target_id_key_id_pk" PRIMARY KEY("signer_id","target_id","key_id")
);
--> statement-breakpoint
ALTER TABLE "dm_backup" ADD CONSTRAINT "dm_backup_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversation" ADD CONSTRAINT "dm_conversation_first_id_user_id_fk" FOREIGN KEY ("first_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversation" ADD CONSTRAINT "dm_conversation_second_id_user_id_fk" FOREIGN KEY ("second_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_conversation" ADD CONSTRAINT "dm_conversation_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_crypto_receipt" ADD CONSTRAINT "dm_crypto_receipt_device_id_dm_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."dm_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_device" ADD CONSTRAINT "dm_device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_identity" ADD CONSTRAINT "dm_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_key" ADD CONSTRAINT "dm_key_device_id_dm_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."dm_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_mailbox" ADD CONSTRAINT "dm_mailbox_device_id_dm_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."dm_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_mailbox" ADD CONSTRAINT "dm_mailbox_sender_id_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_message" ADD CONSTRAINT "dm_message_conversation_id_dm_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."dm_conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_message" ADD CONSTRAINT "dm_message_sender_id_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_message" ADD CONSTRAINT "dm_message_device_id_dm_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."dm_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_signature" ADD CONSTRAINT "dm_signature_signer_id_user_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_signature" ADD CONSTRAINT "dm_signature_target_id_user_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dm_backup_user_idx" ON "dm_backup" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dm_pair_idx" ON "dm_conversation" USING btree ("first_id","second_id");--> statement-breakpoint
CREATE INDEX "dm_second_idx" ON "dm_conversation" USING btree ("second_id");--> statement-breakpoint
CREATE INDEX "dm_device_user_idx" ON "dm_device" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dm_mailbox_cursor_idx" ON "dm_mailbox" USING btree ("device_id","id");--> statement-breakpoint
CREATE INDEX "dm_message_page_idx" ON "dm_message" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "dm_message_transaction_idx" ON "dm_message" USING btree ("device_id","transaction_id");