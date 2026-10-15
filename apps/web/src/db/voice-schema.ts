// Unreleased internal voice-control state. Public native keys only; no media or native private keys.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { channel } from "./app-schema";
import { session, user } from "./auth-schema";
import { dmDevice } from "./dm-schema";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const created = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const voiceCall = pgTable("voice_call", {
  id: id(),
  channelId: uuid("channel_id").notNull().references(() => channel.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull().default(1),
  status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
  createdAt: created(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("voice_call_active_channel_idx").on(t.channelId).where(sql`${t.status} = 'active'`),
  index("voice_call_channel_idx").on(t.channelId),
  check("voice_call_generation_positive", sql`${t.generation} > 0`),
  check("voice_call_status", sql`(${t.status} = 'active' and ${t.closedAt} is null) or (${t.status} = 'closed' and ${t.closedAt} is not null)`),
]);

export const voiceCallMember = pgTable("voice_call_member", {
  id: id(),
  callId: uuid("call_id").notNull().references(() => voiceCall.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  anchorDeviceId: uuid("anchor_device_id").notNull().references(() => dmDevice.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  joinNonce: uuid("join_nonce").notNull(),
  voiceUserId: text("voice_user_id").notNull().unique(),
  voiceDeviceId: uuid("voice_device_id").notNull(),
  enrollmentSecretHash: text("enrollment_secret_hash").notNull(),
  state: text("state", { enum: ["waiting", "active", "left"] }).notNull().default("waiting"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  /** Highest cursor returned by sync; ACK can never delete an event not previously delivered. */
  deliveredCursor: bigint("delivered_cursor", { mode: "number" }).notNull().default(0),
  createdAt: created(),
  leftAt: timestamp("left_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("voice_member_live_anchor_idx").on(t.callId, t.anchorDeviceId).where(sql`${t.state} <> 'left'`),
  uniqueIndex("voice_member_nonce_idx").on(t.callId, t.joinNonce),
  uniqueIndex("voice_member_device_idx").on(t.callId, t.voiceDeviceId),
  index("voice_member_user_idx").on(t.userId),
  index("voice_member_session_idx").on(t.sessionId),
  index("voice_member_anchor_idx").on(t.anchorDeviceId),
  index("voice_member_lease_idx").on(t.callId, t.state, t.leaseExpiresAt),
  check("voice_member_state", sql`(${t.state} in ('waiting', 'active') and ${t.leftAt} is null) or (${t.state} = 'left' and ${t.leftAt} is not null)`),
  check("voice_member_cursor", sql`${t.deliveredCursor} >= 0`),
]);

export const voiceIdentity = pgTable("voice_identity", {
  memberId: uuid("member_id").primaryKey().references(() => voiceCallMember.id, { onDelete: "cascade" }),
  deviceKeys: jsonb("device_keys").$type<Record<string, unknown>>(),
  crossSigningKeys: jsonb("cross_signing_keys").$type<Record<string, unknown>>(),
});
export const voicePrekey = pgTable("voice_prekey", {
  memberId: uuid("member_id").notNull().references(() => voiceCallMember.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  fallback: boolean("fallback").notNull().default(false),
  used: boolean("used").notNull().default(false),
  retired: boolean("retired").notNull().default(false),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
}, (t) => [primaryKey({ columns: [t.memberId, t.keyId, t.fallback] })]);
export const voiceSignature = pgTable("voice_signature", {
  signerMemberId: uuid("signer_member_id").notNull().references(() => voiceCallMember.id, { onDelete: "cascade" }),
  targetMemberId: uuid("target_member_id").notNull().references(() => voiceCallMember.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  signatures: jsonb("signatures").$type<Record<string, string>>().notNull(),
}, (t) => [primaryKey({ columns: [t.signerMemberId, t.targetMemberId, t.keyId] }), index("voice_signature_target_idx").on(t.targetMemberId)]);
export const voiceControlMailbox = pgTable("voice_control_mailbox", {
  // Sequence allocation and sync/ACK happen under the same voice transaction lock.
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  callId: uuid("call_id").notNull().references(() => voiceCall.id, { onDelete: "cascade" }),
  senderMemberId: uuid("sender_member_id").notNull().references(() => voiceCallMember.id, { onDelete: "cascade" }),
  recipientMemberId: uuid("recipient_member_id").notNull().references(() => voiceCallMember.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull(),
  event: jsonb("event").$type<Record<string, unknown>>().notNull(),
  createdAt: created(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("voice_mailbox_recipient_idx").on(t.recipientMemberId, t.id), index("voice_mailbox_call_idx").on(t.callId), index("voice_mailbox_sender_idx").on(t.senderMemberId), index("voice_mailbox_expiry_idx").on(t.expiresAt), check("voice_mailbox_generation_positive", sql`${t.generation} > 0`)]);
export const voiceControlReceipt = pgTable("voice_control_receipt", {
  senderMemberId: uuid("sender_member_id").notNull().references(() => voiceCallMember.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  digest: text("digest").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.senderMemberId, t.requestId] }), index("voice_receipt_expiry_idx").on(t.expiresAt)]);

/** Positive ownership evidence survives all parent cascades. Retired rows are never token grants. */
export const voiceSfuRoom = pgTable("voice_sfu_room", {
  roomName: text("room_name").primaryKey(),
  channelId: uuid("channel_id").notNull(),
  callId: uuid("call_id").notNull(),
  generation: integer("generation").notNull(),
  status: text("status", { enum: ["active", "retired"] }).notNull().default("active"),
  createdAt: created(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  lastAppTokenExpiry: timestamp("last_app_token_expiry", { withTimezone: true }).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  lastOutcome: text("last_outcome", { enum: ["pending", "current", "deleted", "not_found", "failed", "unavailable"] }).notNull().default("pending"),
}, (t) => [
  index("voice_sfu_room_due_idx").on(t.nextAttemptAt, t.roomName),
  index("voice_sfu_room_call_idx").on(t.callId),
  check("voice_sfu_room_canonical", sql`${t.generation} > 0 and ${t.roomName} = 'voice:' || ${t.channelId}::text || ':' || ${t.callId}::text || ':' || ${t.generation}::text`),
  check("voice_sfu_room_status", sql`(${t.status} = 'active' and ${t.retiredAt} is null) or (${t.status} = 'retired' and ${t.retiredAt} is not null)`),
  check("voice_sfu_room_attempts", sql`${t.attempts} >= 0`),
  check("voice_sfu_room_lease", sql`(${t.leaseToken} is null) = (${t.leaseUntil} is null)`),
  check("voice_sfu_room_outcome", sql`${t.lastOutcome} in ('pending', 'current', 'deleted', 'not_found', 'failed', 'unavailable')`),
]);
