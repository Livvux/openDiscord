import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { session, user } from "./auth-schema";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

// RESTRICT prevents account deletion from silently removing an instance administrator.
export const instanceAdmin = pgTable("instance_admin", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
});
export const userSuspension = pgTable("user_suspension", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
});
export const adminVerification = pgTable("admin_verification", {
  sessionId: text("session_id").primaryKey().references(() => session.id, { onDelete: "cascade" }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).defaultNow().notNull(),
});
export const instanceSettings = pgTable("instance_settings", {
  id: text("id").primaryKey().default("instance"),
  registrationOpen: boolean("registration_open").notNull().default(true),
  inviteMode: text("invite_mode", { enum: ["members", "admins", "disabled"] }).notNull().default("members"),
  ownedCommunities: integer("owned_communities").notNull().default(25),
  channelsPerCommunity: integer("channels_per_community").notNull().default(200),
  rolesPerCommunity: integer("roles_per_community").notNull().default(100),
  activeInvitesPerCommunity: integer("active_invites_per_community").notNull().default(100),
}, (t) => [check("instance_settings_singleton", sql`${t.id} = 'instance'`)]);

// Targets deliberately aren't cascading FKs: moderation evidence survives content/account deletion.
// Message bodies are never copied into reports or the audit log.
export const abuseReport = pgTable("abuse_report", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  reporterId: text("reporter_id").references(() => user.id, { onDelete: "set null" }),
  communityId: uuid("community_id").notNull(),
  messageId: uuid("message_id"),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["open", "dismissed", "removed"] }).notNull().default("open"),
  resolution: text("resolution"),
  resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [index("abuse_report_status_idx").on(t.status, t.createdAt)]);
export const instanceAuditLog = pgTable("instance_audit_log", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
}, (t) => [index("instance_audit_log_created_idx").on(t.createdAt)]);
