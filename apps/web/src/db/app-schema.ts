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
import { dmMessage } from "./dm-schema";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () => uuid("id").primaryKey().default(sql`uuidv7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const community = pgTable("community", {
  id: id(),
  name: text("name").notNull(),
  rules: text("rules").notNull().default(""),
  rulesVersion: integer("rules_version").notNull().default(0),
  rulesRequired: boolean("rules_required").notNull().default(false),
  /** Owner opt-in: listed in Discover and joinable without an invite. */
  discoverable: boolean("discoverable").notNull().default(false),
  description: text("description").notNull().default(""),
  /** Square server picture and wide banner; replaced pictures lose this link and the media sweeper deletes them. */
  iconId: uuid("icon_id").references((): AnyPgColumn => attachment.id, { onDelete: "set null" }),
  bannerId: uuid("banner_id").references((): AnyPgColumn => attachment.id, { onDelete: "set null" }),
  /** Set by an instance administrator: shows the verified badge. */
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
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
    rulesAcceptedVersion: integer("rules_accepted_version").notNull().default(0),
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
    /** Thread messages point at their root (a top-level message in the same channel); deleting the root deletes the thread. */
    threadId: uuid("thread_id").references((): AnyPgColumn => message.id, { onDelete: "cascade" }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    /** Imported from another instance: the original author's display name (the importer owns the row). */
    importedAuthor: text("imported_author"),
    /** Full-text index; the "simple" configuration works for every language (no stemming). */
    search: tsvector("search").generatedAlwaysAs((): SQL => sql`to_tsvector('simple', ${message.content})`),
  },
  (t) => [
    index("message_channel_idx").on(t.channelId, t.id),
    index("message_author_idx").on(t.authorId, t.createdAt),
    index("message_pinned_idx").on(t.channelId, t.pinnedAt).where(sql`${t.pinnedAt} is not null`),
    // Deleting a message unlinks its replies; this keeps that FK action cheap.
    index("message_reply_idx").on(t.replyToId).where(sql`${t.replyToId} is not null`),
    index("message_thread_idx").on(t.threadId, t.id).where(sql`${t.threadId} is not null`),
    index("message_search_idx").using("gin", t.search),
  ],
);

/** Send receipts survive message deletion so an ambiguous retry cannot resurrect it. */
export const messageSend = pgTable("message_send", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  transactionId: uuid("transaction_id").notNull(),
  channelId: uuid("channel_id").notNull().references(() => channel.id, { onDelete: "cascade" }),
  requestHash: text("request_hash").notNull(),
  messageId: uuid("message_id").references(() => message.id, { onDelete: "set null" }),
}, (t) => [
  primaryKey({ columns: [t.userId, t.transactionId] }),
  index("message_send_channel_idx").on(t.channelId),
  index("message_send_message_idx").on(t.messageId),
]);

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
    id: uuid("id").notNull().default(sql`uuidv7()`).unique(),
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

/** Appeals are private to their author and ban-capable community moderators. A ban ID
 * identifies an issuance; removing/reissuing a ban never attaches an old appeal to the new ban. */
export const banAppeal = pgTable("ban_appeal", {
  id: id(),
  communityId: uuid("community_id").notNull().references(() => community.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  banId: uuid("ban_id").notNull(),
  content: text("content").notNull(),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolution: text("resolution", { enum: ["uphold", "unban"] }),
  resolutionNote: text("resolution_note"),
  resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("ban_appeal_issuance_idx").on(t.banId),
  index("ban_appeal_community_idx").on(t.communityId, t.createdAt),
  index("ban_appeal_resolved_idx").on(t.resolvedAt),
  check("ban_appeal_content_length", sql`char_length(${t.content}) between 1 and 2000`),
  check("ban_appeal_resolution", sql`(${t.resolvedAt} is null and ${t.resolution} is null) or (${t.resolvedAt} is not null and ${t.resolution} in ('uphold', 'unban'))`),
]);

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

export const communityAsset = pgTable("community_asset", {
  id: id(),
  communityId: uuid("community_id").notNull().references(() => community.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["emoji", "sticker"] }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("community_asset_name_idx").on(t.communityId, t.name),
  check("community_asset_name_valid", sql`${t.name} ~ '^[a-z0-9_]{2,32}$'`),
  check("community_asset_kind_valid", sql`${t.kind} in ('emoji', 'sticker')`),
]);

/**
 * Image stored in object storage (R2/S3). Uploaded first, then linked to a message or library asset.
 * Deleting the message, channel, community or author unlinks it; unlinked objects are swept
 * from storage (src/server/media.ts), and only linked attachments are ever served.
 */
export const attachment = pgTable(
  "attachment",
  {
    id: id(),
    messageId: uuid("message_id").references(() => message.id, { onDelete: "set null" }),
    channelId: uuid("channel_id").references(() => channel.id, { onDelete: "set null" }),
    assetId: uuid("asset_id").references(() => communityAsset.id, { onDelete: "set null" }),
    uploaderId: text("uploader_id").references(() => user.id, { onDelete: "set null" }),
    /** The account whose profile picture this is; cleared on replace/removal/account deletion, then swept. */
    avatarUserId: text("avatar_user_id").references(() => user.id, { onDelete: "set null" }),
    /** End-to-end encrypted DM file: opaque ciphertext only; name, type and key live inside the Megolm payload. */
    dmMessageId: uuid("dm_message_id").references(() => dmMessage.id, { onDelete: "set null" }),
    /** Set once when sent; a removed message's images can never be re-attached. */
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    key: text("key").notNull().unique(),
    contentType: text("content_type").notNull(),
    /** Set for non-image files (always served as downloads); null for re-encoded images. */
    filename: text("filename"),
    size: integer("size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("attachment_asset_idx").on(t.assetId),
    uniqueIndex("attachment_avatar_idx").on(t.avatarUserId),
    check("attachment_avatar_link_valid", sql`${t.avatarUserId} is null or (${t.messageId} is null and ${t.channelId} is null and ${t.assetId} is null and ${t.linkedAt} is not null)`),
    check("attachment_asset_link_valid", sql`${t.assetId} is null or (${t.messageId} is null and ${t.channelId} is null and ${t.linkedAt} is not null)`),
    index("attachment_message_idx").on(t.messageId),
    index("attachment_dm_message_idx").on(t.dmMessageId),
    index("attachment_unlinked_idx").on(t.createdAt).where(sql`${t.messageId} is null and ${t.assetId} is null`),
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
  /** Shown while visible; "invisible" is `visible = false`. */
  status: text("status", { enum: ["online", "idle", "dnd"] }).notNull().default("online"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

/** A friend request (pending) or friendship (accepted). One row per pair, ordered ids; decline/cancel/remove delete it. */
export const friendship = pgTable(
  "friendship",
  {
    firstId: text("first_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    secondId: text("second_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").notNull().references(() => user.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "accepted"] }).notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.firstId, t.secondId] }),
    index("friendship_second_idx").on(t.secondId),
    // Byte order, matching the JavaScript comparison that builds the pair (the database collation may differ).
    check("friendship_ordered", sql`${t.firstId} collate "C" < ${t.secondId} collate "C"`),
  ],
);

/** Optional profile text, visible to people who can already see the account (shared community, friend, DM). */
export const userProfile = pgTable(
  "user_profile",
  {
    userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
    bio: text("bio").notNull().default(""),
    customStatus: text("custom_status").notNull().default(""),
  },
  (t) => [check("user_profile_length", sql`char_length(${t.bio}) <= 190 and char_length(${t.customStatus}) <= 80`)],
);

/**
 * A bot (a member with roles, using the public API with its token) or an incoming webhook (posts
 * into one channel). Each has its own user row for authorship; tokens are stored as SHA-256 hashes.
 * Revoked integrations keep their row so old messages still show as from a bot.
 */
export const integration = pgTable(
  "integration",
  {
    id: id(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => community.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["bot", "webhook"] }).notNull(),
    name: text("name").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Webhooks only: the channel they post into. */
    channelId: uuid("channel_id").references(() => channel.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("integration_community_idx").on(t.communityId), index("integration_user_idx").on(t.userId)],
);

/** A browser's Web Push subscription (one per device). Payloads are encrypted for that browser (RFC 8291). */
export const pushSubscription = pgTable(
  "push_subscription",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("push_subscription_user_idx").on(t.userId)],
);

/** Exists only for a newly created, explicitly public text channel. Unpublish is terminal. */
export const publicChannel = pgTable("public_channel", {
  channelId: uuid("channel_id").primaryKey().references(() => channel.id, { onDelete: "cascade" }),
  generation: uuid("generation").notNull().default(sql`uuidv7()`).unique(),
  communityTitle: text("community_title").notNull(),
  channelTitle: text("channel_title").notNull(),
  createdAt: createdAt(),
  unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
}, (t) => [check("public_channel_title_length", sql`char_length(${t.communityTitle}) between 1 and 80 and char_length(${t.channelTitle}) between 1 and 32`)]);

/** Explicitly public send-time snapshot; never join a private display name when reading it. */
export const publicPost = pgTable("public_post", {
  messageId: uuid("message_id").primaryKey().references(() => message.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => publicChannel.channelId, { onDelete: "cascade" }),
  authorName: text("author_name").notNull(),
  content: text("content").notNull(),
  createdAt: createdAt(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
}, (t) => [index("public_post_channel_idx").on(t.channelId, t.messageId)]);
