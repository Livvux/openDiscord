// Community data. Ids are UUIDv7 (Postgres 18 built-in), so they sort by creation time
// and double as pagination cursors.
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  customType,
  boolean,
  check,
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

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const community = pgTable("community", {
  id: id(),
  name: text("name").notNull(),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspensionReason: text("suspension_reason"),
  /** Set while invites are paused (by a manager, or automatically by raid protection). */
  invitesPausedAt: timestamp("invites_paused_at", { withTimezone: true }),
  /** Accounts younger than this can't join; 0 = no minimum. */
  minAccountAgeHours: integer("min_account_age_hours").notNull().default(0),
  /** More joins than this within 10 minutes pauses invites; 0 = off. */
  raidJoinLimit: integer("raid_join_limit").notNull().default(30),
  /** AutoMod: messages containing these words (case-insensitive, whole words) are refused. */
  automodWords: text("automod_words").array().notNull().default(sql`'{}'::text[]`),
  /** AutoMod: refuse messages with links, except from people who can manage messages. */
  automodBlockLinks: boolean("automod_block_links").notNull().default(false),
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
    /** "muted": no desktop notifications or unread dot for this community; mention badges stay. */
    notifications: text("notifications", { enum: ["mentions", "muted"] }).notNull().default("mentions"),
  },
  (t) => [
    primaryKey({ columns: [t.communityId, t.userId] }),
    index("member_user_idx").on(t.userId),
    index("member_joined_idx").on(t.communityId, t.joinedAt),
  ],
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

/** A named group of channels in the sidebar. Deleting it keeps its channels (uncategorised). */
export const category = pgTable(
  "category",
  {
    id: id(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => community.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("category_community_idx").on(t.communityId)],
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
    /** Voice channels have no messages; their room lives in LiveKit. */
    kind: text("kind", { enum: ["text", "voice"] }).notNull().default("text"),
    categoryId: uuid("category_id").references(() => category.id, { onDelete: "set null" }),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("channel_community_idx").on(t.communityId), index("channel_category_idx").on(t.categoryId)],
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
  (t) => [
    primaryKey({ columns: [t.channelId, t.roleId] }),
    index("channel_override_role_idx").on(t.roleId),
    // Only channel permission bits (view 1024, send 256, manage messages 16, connect 2048, speak 4096,
    // video 8192), never both allowed and denied.
    check("channel_override_bits", sql`${t.allow} & ${t.deny} = 0 and (${t.allow} | ${t.deny}) & ~15632 = 0`),
  ],
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
    /** The message this one replies to (same channel); unlinked when that message is deleted. */
    replyToId: uuid("reply_to_id").references((): AnyPgColumn => message.id, { onDelete: "set null" }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    /** Full-text index; the "simple" configuration works for every language (no stemming). */
    search: tsvector("search").generatedAlwaysAs((): SQL => sql`to_tsvector('simple', ${message.content})`),
  },
  (t) => [
    index("message_channel_idx").on(t.channelId, t.id),
    index("message_author_idx").on(t.authorId, t.createdAt),
    index("message_pinned_idx").on(t.channelId, t.pinnedAt).where(sql`${t.pinnedAt} is not null`),
    // Deleting a message unlinks its replies; this keeps that FK action cheap.
    index("message_reply_idx").on(t.replyToId).where(sql`${t.replyToId} is not null`),
    index("message_search_idx").using("gin", t.search),
  ],
);

/** One emoji reaction by one person on one message. */
export const reaction = pgTable(
  "reaction",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

/** A member mentioned in a message (`<@userId>` in the content). */
export const mention = pgTable(
  "mention",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] }), index("mention_user_idx").on(t.userId, t.messageId)],
);

/** The newest message a person has read in a channel; everything after it is unread. */
export const channelReadState = pgTable(
  "channel_read_state",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    lastReadId: uuid("last_read_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] })],
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

/** One person blocking another: hides the blocked person's messages and silences their mentions. */
export const userBlock = pgTable(
  "user_block",
  {
    blockerId: text("blocker_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    blockedId: text("blocked_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index("user_block_blocked_idx").on(t.blockedId)],
);

/** Opt-in online status: shown only when `visible`, "online" means seen in the last 90 seconds. */
export const userPresence = pgTable("user_presence", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  visible: boolean("visible").notNull().default(false),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});
