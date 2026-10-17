CREATE TABLE "voice_call" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"channel_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "voice_call_generation_positive" CHECK ("voice_call"."generation" > 0),
	CONSTRAINT "voice_call_status" CHECK (("voice_call"."status" = 'active' and "voice_call"."closed_at" is null) or ("voice_call"."status" = 'closed' and "voice_call"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "voice_call_member" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"call_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"anchor_device_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"join_nonce" uuid NOT NULL,
	"voice_user_id" text NOT NULL,
	"voice_device_id" uuid NOT NULL,
	"enrollment_secret_hash" text NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"delivered_cursor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "voice_call_member_voice_user_id_unique" UNIQUE("voice_user_id"),
	CONSTRAINT "voice_member_state" CHECK (("voice_call_member"."state" in ('waiting', 'active') and "voice_call_member"."left_at" is null) or ("voice_call_member"."state" = 'left' and "voice_call_member"."left_at" is not null)),
	CONSTRAINT "voice_member_cursor" CHECK ("voice_call_member"."delivered_cursor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "voice_control_mailbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "voice_control_mailbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"call_id" uuid NOT NULL,
	"sender_member_id" uuid NOT NULL,
	"recipient_member_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_mailbox_generation_positive" CHECK ("voice_control_mailbox"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "voice_control_receipt" (
	"sender_member_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"digest" text NOT NULL,
	"response" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_control_receipt_sender_member_id_request_id_pk" PRIMARY KEY("sender_member_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "voice_identity" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"device_keys" jsonb,
	"cross_signing_keys" jsonb
);
--> statement-breakpoint
CREATE TABLE "voice_prekey" (
	"member_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"fallback" boolean DEFAULT false NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"content" jsonb NOT NULL,
	CONSTRAINT "voice_prekey_member_id_key_id_fallback_pk" PRIMARY KEY("member_id","key_id","fallback")
);
--> statement-breakpoint
CREATE TABLE "voice_signature" (
	"signer_member_id" uuid NOT NULL,
	"target_member_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"signatures" jsonb NOT NULL,
	CONSTRAINT "voice_signature_signer_member_id_target_member_id_key_id_pk" PRIMARY KEY("signer_member_id","target_member_id","key_id")
);
--> statement-breakpoint
ALTER TABLE "voice_call" ADD CONSTRAINT "voice_call_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_member" ADD CONSTRAINT "voice_call_member_call_id_voice_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."voice_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_member" ADD CONSTRAINT "voice_call_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_member" ADD CONSTRAINT "voice_call_member_anchor_device_id_dm_device_id_fk" FOREIGN KEY ("anchor_device_id") REFERENCES "public"."dm_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_call_member" ADD CONSTRAINT "voice_call_member_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_control_mailbox" ADD CONSTRAINT "voice_control_mailbox_call_id_voice_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."voice_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_control_mailbox" ADD CONSTRAINT "voice_control_mailbox_sender_member_id_voice_call_member_id_fk" FOREIGN KEY ("sender_member_id") REFERENCES "public"."voice_call_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_control_mailbox" ADD CONSTRAINT "voice_control_mailbox_recipient_member_id_voice_call_member_id_fk" FOREIGN KEY ("recipient_member_id") REFERENCES "public"."voice_call_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_control_receipt" ADD CONSTRAINT "voice_control_receipt_sender_member_id_voice_call_member_id_fk" FOREIGN KEY ("sender_member_id") REFERENCES "public"."voice_call_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_identity" ADD CONSTRAINT "voice_identity_member_id_voice_call_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."voice_call_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_prekey" ADD CONSTRAINT "voice_prekey_member_id_voice_call_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."voice_call_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_signature" ADD CONSTRAINT "voice_signature_signer_member_id_voice_call_member_id_fk" FOREIGN KEY ("signer_member_id") REFERENCES "public"."voice_call_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_signature" ADD CONSTRAINT "voice_signature_target_member_id_voice_call_member_id_fk" FOREIGN KEY ("target_member_id") REFERENCES "public"."voice_call_member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_call_active_channel_idx" ON "voice_call" USING btree ("channel_id") WHERE "voice_call"."status" = 'active';--> statement-breakpoint
CREATE INDEX "voice_call_channel_idx" ON "voice_call" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_member_live_anchor_idx" ON "voice_call_member" USING btree ("call_id","anchor_device_id") WHERE "voice_call_member"."state" <> 'left';--> statement-breakpoint
CREATE UNIQUE INDEX "voice_member_nonce_idx" ON "voice_call_member" USING btree ("call_id","join_nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_member_device_idx" ON "voice_call_member" USING btree ("call_id","voice_device_id");--> statement-breakpoint
CREATE INDEX "voice_member_user_idx" ON "voice_call_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "voice_member_session_idx" ON "voice_call_member" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "voice_member_anchor_idx" ON "voice_call_member" USING btree ("anchor_device_id");--> statement-breakpoint
CREATE INDEX "voice_member_lease_idx" ON "voice_call_member" USING btree ("call_id","state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "voice_mailbox_recipient_idx" ON "voice_control_mailbox" USING btree ("recipient_member_id","id");--> statement-breakpoint
CREATE INDEX "voice_mailbox_call_idx" ON "voice_control_mailbox" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "voice_mailbox_sender_idx" ON "voice_control_mailbox" USING btree ("sender_member_id");--> statement-breakpoint
CREATE INDEX "voice_mailbox_expiry_idx" ON "voice_control_mailbox" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "voice_receipt_expiry_idx" ON "voice_control_receipt" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "voice_signature_target_idx" ON "voice_signature" USING btree ("target_member_id");