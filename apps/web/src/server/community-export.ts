// Moving a community between instances. The export holds settings and messages, never accounts:
// authors become plain names, mentions become text. Only the owner can export (it contains every
// member's messages) and the export is audited. Importing creates a new community owned by the
// importer; imported messages keep their original author name and time, marked as imported.
import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { attachment, auditLog, category, channel, channelOverride, community, communityAsset, member, mention, message, role, session, user } from "@/db/schema";
import { assetRefSchema, assetText, assetTokens, MAX_MESSAGE_ASSETS, MAX_MESSAGE_STICKERS, remapAssetTokens, MAX_COMMUNITY_EMOJI, MAX_COMMUNITY_STICKERS, MAX_COMMUNITY_ASSET_BYTES, type AssetRef } from "@/lib/community-assets";
import { requireMember } from "./access";
import { uuidv7 } from "./uuidv7";
import { AppError, forbidden } from "./errors";
import { assertActiveUser, getInstanceSettings } from "./instance-policy";
import { enforceCap } from "./limits";
import { ALL_PERMISSIONS, CHANNEL_PERMISSIONS } from "./permissions";
import { channelName, channelTopic, communityName, MESSAGE_MAX_LENGTH, parse, roleName, uuid } from "./validation";

export const EXPORT_FORMAT = "opendiscord.community-export";
export const EXPORT_VERSION = 2;
export const MAX_IMPORT_MESSAGES = 100_000;

const key = z.string().min(1).max(64);
export const communityExportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.union([z.literal(1), z.literal(EXPORT_VERSION)]),
  assets: z.array(assetRefSchema).max(MAX_COMMUNITY_EMOJI + MAX_COMMUNITY_STICKERS).default([]),
  community: z.object({ name: communityName, rules: z.string().trim().max(4000).default(""), rulesRequired: z.boolean().default(false) })
    .refine((c) => !c.rulesRequired || c.rules.length > 0, "Required community rules cannot be empty."),
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

export type CommunityExport = z.infer<typeof communityExportSchema> & {
  exportedAt: string;
  /** More than MAX_IMPORT_MESSAGES messages existed; only the newest are included. */
  truncated: boolean;
};

/** Everything needed to rebuild the community elsewhere. Owner only; audited. */
export async function exportCommunity(userId: string, rawCommunityId: unknown, includeMessages = true): Promise<CommunityExport> {
  const communityId = parse(uuid, rawCommunityId);
  const { community: c, authority } = await requireMember(db, communityId, userId);
  if (!authority.isOwner) throw forbidden("Only the owner can export a community.");
  const [roles, categories, channels, assets] = await Promise.all([
    db.select().from(role).where(eq(role.communityId, communityId)).orderBy(asc(role.position)),
    db.select().from(category).where(eq(category.communityId, communityId)).orderBy(asc(category.position)),
    db.select().from(channel).where(eq(channel.communityId, communityId)).orderBy(asc(channel.position), asc(channel.id)),
    db.select({ id: communityAsset.id, name: communityAsset.name, kind: communityAsset.kind }).from(communityAsset).where(eq(communityAsset.communityId, communityId)),
  ]);
  const channelIds = channels.map((ch) => ch.id);
  const [overrides, messages] = channelIds.length
    ? await Promise.all([
        db.select().from(channelOverride).where(inArray(channelOverride.channelId, channelIds)),
        includeMessages ? db
          .select({ m: message, authorName: user.name })
          .from(message)
          .innerJoin(user, eq(user.id, message.authorId))
          .where(inArray(message.channelId, channelIds))
          .orderBy(desc(message.id))
          .limit(MAX_IMPORT_MESSAGES + 1) : Promise.resolve([]),
      ])
    : [[], []];
  // Over the cap: keep the newest messages and say so.
  const truncated = messages.length > MAX_IMPORT_MESSAGES;
  messages.splice(MAX_IMPORT_MESSAGES);
  messages.reverse();
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
    truncated,
    assets,
    community: { name: c.name, rules: c.rules, rulesRequired: c.rulesRequired },
    roles: roles.map((r) => ({ key: r.id, name: r.name, permissions: r.permissions, position: r.position, isDefault: r.isDefault })),
    categories: categories.map((cat) => ({ key: cat.id, name: cat.name, position: cat.position })),
    channels: channels.map((ch) => ({
      key: ch.id, name: ch.name, topic: ch.topic, kind: ch.kind, position: ch.position, categoryKey: ch.categoryId,
      overrides: overrides.filter((o) => o.channelId === ch.id).map((o) => ({ roleKey: o.roleId, allow: o.allow, deny: o.deny })),
    })),
    messages: messages.map(({ m, authorName }) => ({
      key: m.id, channelKey: m.channelId, author: m.importedAuthor ?? authorName, content: assetText(asText(m.id, m.content)),
      createdAt: m.createdAt.toISOString(), editedAt: m.editedAt?.toISOString() ?? null, pinned: m.pinnedAt !== null,
      replyToKey: m.replyToId, threadKey: m.threadId,
      attachments: attachments.find((a) => a.messageId === m.id)?.n ?? 0,
    })),
  };
}

export interface ArchiveStaging {
  sessionId: string;
  /** Created and collected by this server-side import, never read as DB IDs from the archive. */
  attachments: readonly { id: string; messageKey: string }[];
  assets?: readonly { id: string; assetKey: string }[];
}

const CHUNK = 1000;
/** Imported times are clamped: ids derive from them, and far-future ids would sort after every live message. */
const EARLIEST = Date.parse("2015-01-01T00:00:00Z");
const clampTime = (iso: string) => Math.min(Math.max(Date.parse(iso), EARLIEST), Date.now());
/** One import at a time per process: imports are large single transactions. */
let importing = false;

/** Rebuilds an exported community as a new community owned by the importer. */
export async function importCommunity(userId: string, rawExport: unknown, staging?: ArchiveStaging): Promise<string> {
  const data = parse(communityExportSchema, rawExport);
  await assertActiveUser(userId);
  if (new Set(data.messages.map((m) => m.key)).size !== data.messages.length) throw new AppError("invalid", "The export contains duplicate messages.");
  if (importing) throw new AppError("rate_limited", "Another import is running. Try again in a minute.");
  importing = true;
  try {
    return await runImport(userId, data, staging);
  } finally {
    importing = false;
  }
}

async function runImport(userId: string, data: z.infer<typeof communityExportSchema>, staging?: ArchiveStaging): Promise<string> {
  const library = data.version === 2 ? data.assets : [];
  if (new Set(library.map((a) => a.id)).size !== library.length || new Set(library.map((a) => a.name)).size !== library.length
    || library.filter((a) => a.kind === "emoji").length > MAX_COMMUNITY_EMOJI || library.filter((a) => a.kind === "sticker").length > MAX_COMMUNITY_STICKERS) throw new AppError("invalid", "Invalid community image library.");
  if (staging) {
    const files = staging.assets ?? [];
    const ids = [...staging.attachments.map((f) => f.id), ...files.map((f) => f.id)];
    if (new Set(ids).size !== ids.length || files.length !== library.length || new Set(files.map((f) => f.assetKey)).size !== files.length || files.some((f) => !library.some((a) => a.id === f.assetKey))) throw new AppError("invalid", "Invalid staged library references.");
  }
  const channelKeys = new Set(data.channels.map((ch) => ch.key));
  if (data.messages.some((m) => !channelKeys.has(m.channelKey))) throw new AppError("invalid", "The export refers to a channel it doesn't contain.");
  if (staging) {
    const counts = new Map<string, number>();
    const ids = new Set<string>();
    const keys = new Set(data.messages.map((m) => m.key));
    for (const file of staging.attachments) {
      if (ids.has(file.id) || !keys.has(file.messageKey)) throw new AppError("invalid", "Invalid staged attachment references.");
      ids.add(file.id);
      counts.set(file.messageKey, (counts.get(file.messageKey) ?? 0) + 1);
    }
    if (data.messages.some((m) => m.attachments !== (counts.get(m.key) ?? 0))) throw new AppError("invalid", "The archive has missing or extra attachments.");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local transaction_timeout = '30s'`);
    await tx.execute(sql`set local statement_timeout = '15s'`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    const [actor] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
    if (!actor) throw forbidden("The importing account no longer exists.");
    if (staging) {
      const [activeSession] = await tx.select({ id: session.id }).from(session)
        .where(and(eq(session.id, staging.sessionId), eq(session.userId, userId), gt(session.expiresAt, new Date()))).for("update");
      if (!activeSession) throw new AppError("unauthorized", "Sign in again before importing.");
    }
    await assertActiveUser(userId, tx);
    const CAPS = await getInstanceSettings(tx);
    const [{ owned }] = await tx.select({ owned: count() }).from(community).where(eq(community.ownerId, userId));
    enforceCap(owned, CAPS.ownedCommunities, `You can own at most ${CAPS.ownedCommunities} communities.`);
    enforceCap(data.channels.length - 1, CAPS.channelsPerCommunity, `A community can have at most ${CAPS.channelsPerCommunity} channels.`);
    enforceCap(data.roles.length - 1, CAPS.rolesPerCommunity, `A community can have at most ${CAPS.rolesPerCommunity} roles.`);
    const [c] = await tx.insert(community).values({ name: data.community.name, ownerId: userId,
      rules: data.community.rules, rulesRequired: data.community.rulesRequired, rulesVersion: data.community.rules ? 1 : 0,
    }).returning({ id: community.id, rulesVersion: community.rulesVersion });
    await tx.insert(member).values({ communityId: c.id, userId, rulesAcceptedVersion: c.rulesVersion });

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
      // One override per role (a file could list a role twice): merge, allow wins.
      const merged = new Map<string, { allow: number; deny: number }>();
      for (const o of ch.overrides) {
        const roleId = roleIds.get(o.roleKey);
        if (!roleId) continue;
        const prev = merged.get(roleId) ?? { allow: 0, deny: 0 };
        merged.set(roleId, { allow: prev.allow | (o.allow & CHANNEL_PERMISSIONS), deny: prev.deny | (o.deny & CHANNEL_PERMISSIONS) });
      }
      const overrides = [...merged].map(([roleId, o]) => ({ roleId, allow: o.allow, deny: o.deny & ~o.allow })).filter((o) => o.allow !== 0 || o.deny !== 0);
      if (overrides.length) await tx.insert(channelOverride).values(overrides.map((o) => ({ ...o, channelId: created.id })));
    }

    const importedAssets = new Map<string, AssetRef>();
    if (staging?.assets?.length) {
      let storedBytes = 0;
      for (const source of library) {
        const file = staging.assets.find((f) => f.assetKey === source.id)!;
        const fresh = { id: uuidv7(), name: source.name, kind: source.kind };
        await tx.insert(communityAsset).values({ ...fresh, communityId: c.id });
        const linked = await tx.execute<{ size: number }>(sql`
          update attachment set asset_id = ${fresh.id}::uuid, linked_at = now()
          where id = ${file.id}::uuid and uploader_id = ${userId}
            and message_id is null and channel_id is null and asset_id is null and linked_at is null
          returning size
        `);
        if (linked.rows.length !== 1) throw new AppError("conflict", "Staged library files are no longer available.");
        storedBytes += linked.rows[0].size;
        if (storedBytes > MAX_COMMUNITY_ASSET_BYTES) throw new AppError("invalid", "The community image library exceeds 64 MiB.");
        importedAssets.set(source.id, fresh);
      }
    }
    // Ids are UUIDv7 from the original times, so the order (and paging) is the original chronology and
    // replies and threads can point at messages of the same batch.
    const sorted = [...data.messages].sort((a, b) => clampTime(a.createdAt) - clampTime(b.createdAt));
    const messageIds = new Map(sorted.map((m) => [m.key, uuidv7(clampTime(m.createdAt))]));
    const rows = sorted.map((m) => {
      const references = assetTokens(m.content);
      if (references.length > MAX_MESSAGE_ASSETS || references.filter((a) => a.kind === "sticker").length > MAX_MESSAGE_STICKERS) throw new AppError("invalid", "An imported message exceeds the community image limit.");
      const note = !staging && m.attachments > 0 ? `\n_(${m.attachments} attachment${m.attachments === 1 ? "" : "s"} not imported)_` : "";
      const ref = (k: string | null) => (k ? (messageIds.get(k) ?? null) : null);
      return {
        id: messageIds.get(m.key)!,
        channelId: channelIds.get(m.channelKey)!,
        authorId: userId,
        importedAuthor: m.author,
        content: (remapAssetTokens(m.content, importedAssets) + note).slice(0, MESSAGE_MAX_LENGTH) || "_(empty message)_",
        createdAt: new Date(clampTime(m.createdAt)),
        editedAt: m.editedAt ? new Date(clampTime(m.editedAt)) : null,
        pinnedAt: m.pinned ? new Date(clampTime(m.createdAt)) : null,
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
    if (staging) {
      const sourceMessages = new Map(data.messages.map((m) => [m.key, m]));
      for (let i = 0; i < staging.attachments.length; i += CHUNK) {
        const files = staging.attachments.slice(i, i + CHUNK);
        const links = files.map((file) => {
          const source = sourceMessages.get(file.messageKey);
          const targetMessage = messageIds.get(file.messageKey);
          const targetChannel = source && channelIds.get(source.channelKey);
          if (!targetMessage || !targetChannel) throw new AppError("invalid", "Invalid staged attachment references.");
          return sql`(${file.id}::uuid, ${targetMessage}::uuid, ${targetChannel}::uuid)`;
        });
        const linked = await tx.execute<{ id: string }>(sql`
          update attachment a set message_id = v.message_id, channel_id = v.channel_id, linked_at = now()
          from (values ${sql.join(links, sql`, `)}) as v(id, message_id, channel_id)
          where a.id = v.id and a.uploader_id = ${userId}
            and a.message_id is null and a.asset_id is null and a.linked_at is null and a.channel_id is null
          returning a.id
        `);
        if (linked.rows.length !== files.length) throw new AppError("conflict", "Staged files are no longer available. Import the archive again.");
      }
    }
    await tx.insert(auditLog).values({ communityId: c.id, actorId: userId, action: "community.import", reason: `${sorted.length} messages` });
    return c.id;
  });
}
