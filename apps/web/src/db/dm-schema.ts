import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const created = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

/** A 1:1 conversation (first/second, a request until accepted) or a group whose people are in `dm_member`. */
export const dmConversation = pgTable("dm_conversation", {
  id: id(),
  firstId: text("first_id").references(() => user.id, { onDelete: "cascade" }),
  secondId: text("second_id").references(() => user.id, { onDelete: "cascade" }),
  /** The requester of a 1:1 conversation, or a group's creator; a deleted creator leaves the group intact. */
  requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
  status: text("status", { enum: ["pending", "accepted", "rejected"] }).notNull().default("pending"),
  kind: text("kind", { enum: ["direct", "group"] }).notNull().default("direct"),
  /** Group name: plaintext metadata the server can read (docs/PRIVATE-MESSAGES.md). */
  name: text("name"),
  createdAt: created(),
}, (t) => [
  uniqueIndex("dm_pair_idx").on(t.firstId, t.secondId), index("dm_second_idx").on(t.secondId),
  check("dm_conversation_kind_valid", sql`(${t.kind} = 'direct' and ${t.firstId} is not null and ${t.secondId} is not null and ${t.name} is null) or (${t.kind} = 'group' and ${t.firstId} is null and ${t.secondId} is null and ${t.status} = 'accepted')`),
]);

/**
 * Group membership. Former members keep their row (left_at) so their earlier messages keep a known sender.
 * Trigger dm_member_cleanup (migration 0037, not in drizzle snapshots) deletes a group without active members.
 */
export const dmMember = pgTable("dm_member", {
  conversationId: uuid("conversation_id").notNull().references(() => dmConversation.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  leftAt: timestamp("left_at", { withTimezone: true }),
  /** Set when the owner removed this person (not when they left): only the owner may add them again. */
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.conversationId, t.userId] }), index("dm_member_user_idx").on(t.userId)]);

export const dmDevice = pgTable("dm_device", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  secretHash: text("secret_hash").notNull(),
  keys: jsonb("keys").$type<Record<string, unknown>>(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: created(),
}, (t) => [index("dm_device_user_idx").on(t.userId)]);

export const dmIdentity = pgTable("dm_identity", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  keys: jsonb("keys").$type<Record<string, unknown>>().notNull(),
});

export const dmKey = pgTable("dm_key", {
  deviceId: uuid("device_id").notNull().references(() => dmDevice.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  fallback: boolean("fallback").notNull().default(false),
  used: boolean("used").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.deviceId, t.keyId, t.fallback] })]);

export const dmSignature = pgTable("dm_signature", {
  signerId: text("signer_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  targetId: text("target_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  signatures: jsonb("signatures").$type<Record<string, string>>().notNull(),
}, (t) => [primaryKey({ columns: [t.signerId, t.targetId, t.keyId] })]);

export const dmMailbox = pgTable("dm_mailbox", {
  // A sequence is allocated inside the global crypto transaction lock; commits cannot overtake cursors.
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  deviceId: uuid("device_id").notNull().references(() => dmDevice.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  event: jsonb("event").$type<Record<string, unknown>>().notNull(),
  createdAt: created(),
}, (t) => [index("dm_mailbox_cursor_idx").on(t.deviceId, t.id)]);

export const dmCryptoReceipt = pgTable("dm_crypto_receipt", {
  deviceId: uuid("device_id").notNull().references(() => dmDevice.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  digest: text("digest").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.deviceId, t.requestId] })]);

export const dmMessage = pgTable("dm_message", {
  id: id(),
  conversationId: uuid("conversation_id").notNull().references(() => dmConversation.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => dmDevice.id, { onDelete: "cascade" }),
  transactionId: uuid("transaction_id").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  kind: text("kind", { enum: ["message", "edit", "reaction", "delete"] }).notNull().default("message"),
  targetId: uuid("target_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: created(),
}, (t) => [index("dm_message_page_idx").on(t.conversationId, t.id), index("dm_message_target_idx").on(t.conversationId, t.targetId), uniqueIndex("dm_message_transaction_idx").on(t.deviceId, t.transactionId),
  check("dm_message_operation_valid", sql`(${t.kind} = 'message' and ${t.targetId} is null) or (${t.kind} in ('edit', 'reaction', 'delete') and ${t.targetId} is not null)`),
]);

/** Per person and conversation: the newest message they have seen. Unread counts are derived from it. */
export const dmReadState = pgTable("dm_read_state", {
  conversationId: uuid("conversation_id").notNull().references(() => dmConversation.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  lastReadId: uuid("last_read_id").notNull(),
}, (t) => [primaryKey({ columns: [t.conversationId, t.userId] })]);

export const dmBackup = pgTable("dm_backup", {
  id: uuid("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  ciphertext: text("ciphertext").notNull(),
  createdAt: created(),
}, (t) => [index("dm_backup_user_idx").on(t.userId)]);

/** Content is disclosed only when a recipient explicitly includes an excerpt in a report. */
export const dmReport = pgTable("dm_report", {
  id: id(),
  messageId: uuid("message_id").notNull().references(() => dmMessage.id, { onDelete: "cascade" }),
  reporterId: text("reporter_id").references(() => user.id, { onDelete: "set null" }),
  reason: text("reason").notNull(),
  excerpt: text("excerpt"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: created(),
}, (t) => [uniqueIndex("dm_report_person_message_idx").on(t.reporterId, t.messageId), index("dm_report_queue_idx").on(t.resolvedAt, t.createdAt)]);
