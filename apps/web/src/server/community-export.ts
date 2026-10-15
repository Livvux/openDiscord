// Moving a community between instances. The export holds settings and messages, never accounts:
// authors become plain names, mentions become text. Only the owner can export (it contains every
// member's messages) and the export is audited. Importing creates a new community owned by the
// importer; imported messages keep their original author name and time, marked as imported.
import { asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { attachment, auditLog, category, channel, channelOverride, community, member, mention, message, role, user } from "@/db/schema";
import { requireMember } from "./access";
import { uuidv7 } from "./uuidv7";
import { AppError, forbidden } from "./errors";
import { assertActiveUser, getInstanceSettings } from "./instance-policy";
import { enforceCap } from "./limits";
import { ALL_PERMISSIONS, CHANNEL_PERMISSIONS } from "./permissions";
import { channelName, channelTopic, communityName, MESSAGE_MAX_LENGTH, parse, roleName, uuid } from "./validation";

export const EXPORT_FORMAT = "opendiscord.community-export";
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_MESSAGES = 100_000;

const key = z.string().min(1).max(64);
const exportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  community: z.object({ name: communityName }),
  roles: z.array(z.object({ key, name: roleName, permissions: z.number().int(), position: z.number().int(), isDefault: z.boolean() })).max(100),
  categories: z.array(z.object({ key, name: z.string().trim().min(1).max(32), position: z.number().int() })).max(50),
  channels: z.array(z.object({
    key,
    name: channelName,
    topic: channelTopic.nullable(),
    kind: z.enum(["text", "voice"]),
    position: z.number().int(),
    categoryKey: key.nullable(),
    overrides: z.array(z.object({ roleKey: key, allow: z.number().int(), deny: z.number().int() })).max(100),
  })).min(1).max(200),
  messages: z.array(z.object({
    key,
    channelKey: key,
    author: z.string().trim().min(1).max(64),
    content: z.string().max(MESSAGE_MAX_LENGTH),
    createdAt: z.iso.datetime({ offset: true }),
    editedAt: z.iso.datetime({ offset: true }).nullable(),
    pinned: z.boolean(),
    replyToKey: key.nullable(),
    threadKey: key.nullable(),
    attachments: z.number().int().min(0).max(100),
  })).max(MAX_IMPORT_MESSAGES),
});

export type CommunityExport = z.infer<typeof exportSchema> & { exportedAt: string };

/** Everything needed to rebuild the community elsewhere. Owner only; audited. */
export async function exportCommunity(userId: string, rawCommunityId: unknown): Promise<CommunityExport> {
  const communityId = parse(uuid, rawCommunityId);
  const { community: c, authority } = await requireMember(db, communityId, userId);
  if (!authority.isOwner) throw forbidden("Only the owner can export a community.");
  const [roles, categories, channels] = await Promise.all([
    db.select().from(role).where(eq(role.communityId, communityId)).orderBy(asc(role.position)),
    db.select().from(category).where(eq(category.communityId, communityId)).orderBy(asc(category.position)),
    db.select().from(channel).where(eq(channel.communityId, communityId)).orderBy(asc(channel.position), asc(channel.id)),
  ]);
  const channelIds = channels.map((ch) => ch.id);
  const [overrides, messages] = channelIds.length
    ? await Promise.all([
        db.select().from(channelOverride).where(inArray(channelOverride.channelId, channelIds)),
        db
          .select({ m: message, authorName: user.name })
          .from(message)
          .innerJoin(user, eq(user.id, message.authorId))
          .where(inArray(message.channelId, channelIds))
          .orderBy(asc(message.id))
          .limit(MAX_IMPORT_MESSAGES),
      ])
    : [[], []];
  const messageIds = messages.map((r) => r.m.id);
  const [mentions, attachments] = messageIds.length
    ? await Promise.all([
        db.select({ messageId: mention.messageId, id: user.id, name: user.name }).from(mention).innerJoin(user, eq(user.id, mention.userId)).where(inArray(mention.messageId, messageIds)),
        db.select({ messageId: attachment.messageId, n: count() }).from(attachment).where(inArray(attachment.messageId, messageIds)).groupBy(attachment.messageId),
      ])
    : [[], []];
  // Account ids mean nothing on another instance: mentions become plain names.
  const names = new Map(mentions.map((m) => [`${m.messageId}:${m.id}`, m.name]));
  const asText = (id: string, content: string) => content.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, uid: string) => `@${names.get(`${id}:${uid}`) ?? "member"}`);
  await db.insert(auditLog).values({ communityId, actorId: userId, action: "community.export" });
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    community: { name: c.name },
    roles: roles.map((r) => ({ key: r.id, name: r.name, permissions: r.permissions, position: r.position, isDefault: r.isDefault })),
    categories: categories.map((cat) => ({ key: cat.id, name: cat.name, position: cat.position })),
    channels: channels.map((ch) => ({
      key: ch.id, name: ch.name, topic: ch.topic, kind: ch.kind, position: ch.position, categoryKey: ch.categoryId,
      overrides: overrides.filter((o) => o.channelId === ch.id).map((o) => ({ roleKey: o.roleId, allow: o.allow, deny: o.deny })),
    })),
    messages: messages.map(({ m, authorName }) => ({
      key: m.id, channelKey: m.channelId, author: m.importedAuthor ?? authorName, content: asText(m.id, m.content),
      createdAt: m.createdAt.toISOString(), editedAt: m.editedAt?.toISOString() ?? null, pinned: m.pinnedAt !== null,
      replyToKey: m.replyToId, threadKey: m.threadId,
      attachments: attachments.find((a) => a.messageId === m.id)?.n ?? 0,
    })),
  };
}

const CHUNK = 1000;

/** Rebuilds an exported community as a new community owned by the importer. */
export async function importCommunity(userId: string, rawExport: unknown): Promise<string> {
  const data = parse(exportSchema, rawExport);
  await assertActiveUser(userId);
  const channelKeys = new Set(data.channels.map((ch) => ch.key));
  if (data.messages.some((m) => !channelKeys.has(m.channelKey))) throw new AppError("invalid", "The export refers to a channel it doesn't contain.");
  return db.transaction(async (tx) => {
    const CAPS = await getInstanceSettings(tx);
    const [{ owned }] = await tx.select({ owned: count() }).from(community).where(eq(community.ownerId, userId));
    enforceCap(owned, CAPS.ownedCommunities, `You can own at most ${CAPS.ownedCommunities} communities.`);
    enforceCap(data.channels.length - 1, CAPS.channelsPerCommunity, `A community can have at most ${CAPS.channelsPerCommunity} channels.`);
    enforceCap(data.roles.length - 1, CAPS.rolesPerCommunity, `A community can have at most ${CAPS.rolesPerCommunity} roles.`);
    const [c] = await tx.insert(community).values({ name: data.community.name, ownerId: userId }).returning({ id: community.id });
    await tx.insert(member).values({ communityId: c.id, userId });

    // Roles: exactly one default role; others keep their relative order. Unknown bits are dropped.
    const roleIds = new Map<string, string>();
    const exportedDefault = data.roles.find((r) => r.isDefault);
    const [defaultRole] = await tx.insert(role).values({
      communityId: c.id, name: "everyone", isDefault: true, permissions: (exportedDefault?.permissions ?? 0) & ALL_PERMISSIONS,
    }).returning({ id: role.id });
    if (exportedDefault) roleIds.set(exportedDefault.key, defaultRole.id);
    const others = data.roles.filter((r) => !r.isDefault).sort((a, b) => a.position - b.position);
    for (const [i, r] of others.entries()) {
      const [created] = await tx.insert(role).values({ communityId: c.id, name: r.name, permissions: r.permissions & ALL_PERMISSIONS, position: i + 1 }).returning({ id: role.id });
      roleIds.set(r.key, created.id);
    }

    const categoryIds = new Map<string, string>();
    for (const [i, cat] of [...data.categories].sort((a, b) => a.position - b.position).entries()) {
      const [created] = await tx.insert(category).values({ communityId: c.id, name: cat.name, position: i + 1 }).returning({ id: category.id });
      categoryIds.set(cat.key, created.id);
    }

    const channelIds = new Map<string, string>();
    for (const [i, ch] of [...data.channels].sort((a, b) => a.position - b.position).entries()) {
      const [created] = await tx.insert(channel).values({
        communityId: c.id, name: ch.name, topic: ch.topic || null, kind: ch.kind, position: i + 1,
        categoryId: ch.categoryKey ? (categoryIds.get(ch.categoryKey) ?? null) : null,
      }).returning({ id: channel.id });
      channelIds.set(ch.key, created.id);
      const overrides = ch.overrides
        .map((o) => ({ roleId: roleIds.get(o.roleKey), allow: o.allow & CHANNEL_PERMISSIONS, deny: o.deny & CHANNEL_PERMISSIONS & ~o.allow }))
        .filter((o): o is { roleId: string; allow: number; deny: number } => !!o.roleId && (o.allow !== 0 || o.deny !== 0));
      if (overrides.length) await tx.insert(channelOverride).values(overrides.map((o) => ({ ...o, channelId: created.id })));
    }

    // Ids are UUIDv7 from the original times, so the order (and paging) is the original chronology and
    // replies and threads can point at messages of the same batch.
    const sorted = [...data.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const messageIds = new Map(sorted.map((m) => [m.key, uuidv7(Date.parse(m.createdAt))]));
    const rows = sorted.map((m) => {
      const note = m.attachments > 0 ? `\n_(${m.attachments} attachment${m.attachments === 1 ? "" : "s"} not imported)_` : "";
      const ref = (k: string | null) => (k ? (messageIds.get(k) ?? null) : null);
      return {
        id: messageIds.get(m.key)!,
        channelId: channelIds.get(m.channelKey)!,
        authorId: userId,
        importedAuthor: m.author,
        content: (m.content + note).slice(0, MESSAGE_MAX_LENGTH) || "_(empty message)_",
        createdAt: new Date(m.createdAt),
        editedAt: m.editedAt ? new Date(m.editedAt) : null,
        pinnedAt: m.pinned ? new Date(m.createdAt) : null,
        replyToId: ref(m.replyToKey),
        threadId: ref(m.threadKey),
      };
    });
    // A thread root must be a top-level message of the same channel, like in the app.
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      const root = r.threadId ? byId.get(r.threadId) : null;
      if (r.threadId && (!root || root.threadId || root.channelId !== r.channelId)) r.threadId = null;
      const parent = r.replyToId ? byId.get(r.replyToId) : null;
      if (r.replyToId && (!parent || parent.channelId !== r.channelId)) r.replyToId = null;
    }
    for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(message).values(rows.slice(i, i + CHUNK));
    await tx.insert(auditLog).values({ communityId: c.id, actorId: userId, action: "community.import", reason: `${sorted.length} messages` });
    return c.id;
  });
}
