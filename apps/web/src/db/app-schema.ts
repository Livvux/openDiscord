// Community data. Ids are UUIDv7 (Postgres 18 built-in), so they sort by creation time
// and double as pagination cursors.
import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const community = pgTable("community", {
  id: id(),
  name: text("name").notNull(),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspensionReason: text("suspension_reason"),
  // restrict: an owner must delete or hand over the community before deleting their account.
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
});

export const role = pgTable(
  "role",
  {
    id: id(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => community.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Bit set, see src/server/permissions.ts. */
    permissions: integer("permissions").notNull().default(0),
    /** Higher outranks lower. The default role is always 0. */
    position: integer("position").notNull().default(0),
    /** The implicit role every member has ("everyone"). */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("role_community_idx").on(t.communityId),
    uniqueIndex("role_one_default_idx").on(t.communityId).where(sql`${t.isDefault}`),
  ],
);

export const member = pgTable(
  "member",
  {
    communityId: uuid("community_id")
      .notNull()
      .references(() => community.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.communityId, t.userId] }), index("member_user_idx").on(t.userId)],
);

export const memberRole = pgTable(
  "member_role",
  {
    communityId: uuid("community_id").notNull(),
    userId: text("user_id").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.communityId, t.userId, t.roleId] }),
    // Leaving or being kicked removes role assignments.
    foreignKey({ columns: [t.communityId, t.userId], foreignColumns: [member.communityId, member.userId] }).onDelete(
      "cascade",
    ),
    index("member_role_role_idx").on(t.roleId),
  ],
);

export const channel = pgTable(
  "channel",
  {
    id: id(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => community.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    topic: text("topic"),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("channel_community_idx").on(t.communityId)],
);

/** Per-channel allow/deny bits for one role (src/server/permissions.ts `channelAuthority`). */
export const channelOverride = pgTable(
  "channel_override",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "cascade" }),
    allow: integer("allow").notNull().default(0),
    deny: integer("deny").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.roleId] }), index("channel_override_role_idx").on(t.roleId)],
);

export const message = pgTable(
  "message",
  {
    id: id(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    // Account deletion deletes the person's messages (docs/PRIVACY.md).
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: createdAt(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  (t) => [index("message_channel_idx").on(t.channelId, t.id), index("message_author_idx").on(t.authorId, t.createdAt)],
);

export const invite = pgTable(
  "invite",
  {
    code: text("code").primaryKey(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => community.id, { onDelete: "cascade" }),
    creatorId: text("creator_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("invite_community_idx").on(t.communityId)],
);

export const ban = pgTable(
  "ban",
  {
    communityId: uuid("community_id")
      .notNull()
      .references(() => community.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    reason: text("reason"),
    moderatorId: text("moderator_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.communityId, t.userId] })],
);

/** Security- and moderation-relevant actions inside a community. Never stores message content. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => community.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetId: text("target_id"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_community_idx").on(t.communityId, t.id)],
);

/**
 * Image stored in object storage (R2/S3). Uploaded first, then linked to a message on send.
 * Deleting the message, channel, community or author unlinks it; unlinked objects are swept
 * from storage (src/server/media.ts), and only linked attachments are ever served.
 */
export const attachment = pgTable(
  "attachment",
  {
    id: id(),
    messageId: uuid("message_id").references(() => message.id, { onDelete: "set null" }),
    channelId: uuid("channel_id").references(() => channel.id, { onDelete: "set null" }),
    uploaderId: text("uploader_id").references(() => user.id, { onDelete: "set null" }),
    /** Set once when sent; a removed message's images can never be re-attached. */
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    key: text("key").notNull().unique(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("attachment_message_idx").on(t.messageId),
    index("attachment_unlinked_idx").on(t.createdAt).where(sql`${t.messageId} is null`),
    index("attachment_uploader_idx").on(t.uploaderId, t.createdAt),
  ],
);
