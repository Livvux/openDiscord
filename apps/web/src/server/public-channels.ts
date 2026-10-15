import { and, count, desc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, channel, community, message, publicChannel, publicPost, user } from "@/db/schema";
import { ASSET_TOKEN_SOURCE } from "@/lib/community-assets";
import { lockCommunity, requireChannel, requireMember, type Db } from "./access";
import { forbidden, invalid } from "./errors";
import { enforceCap } from "./limits";
import { getInstanceSettings } from "./instance-policy";
import { publish } from "./realtime";
import { channelName, parse, uuid } from "./validation";

export const PUBLIC_PAGE_SIZE = 30;
export const publicConsent = uuid.nullish();

// Closed-alpha rejection and suspension apply to public output as well as authenticated access.
function activeUser(id: SQL): SQL {
  return sql`exists (select 1 from "user" public_user
    where public_user.id = ${id}
    and not exists (select 1 from user_suspension where user_id = public_user.id)
    and (exists (select 1 from instance_admin where user_id = public_user.id)
      or (public_user.approval_status <> 'rejected' and (public_user.approval_status <> 'pending'
        or not exists (select 1 from instance_settings where id = 'instance' and closed_alpha)))))`;
}
const visible = () => and(isNull(publicChannel.unpublishedAt), isNull(community.suspendedAt), activeUser(sql`${community.ownerId}`));

export async function createPublicChannel(userId: string, rawCommunityId: unknown, input: unknown): Promise<string> {
  const communityId = parse(uuid, rawCommunityId);
  const data = parse(z.object({ name: channelName, communityTitle: z.string().trim().min(1).max(80), acknowledge: z.literal(true) }).strict(), input);
  const id = await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    const { authority } = await requireMember(tx, communityId, userId);
    if (!authority.isOwner) throw forbidden("Only the owner can create a public channel.");
    const caps = await getInstanceSettings(tx);
    const [{ total }] = await tx.select({ total: count() }).from(channel).where(eq(channel.communityId, communityId));
    enforceCap(total, caps.channelsPerCommunity, "The community channel limit has been reached.");
    const [created] = await tx.insert(channel).values({ communityId, name: data.name, kind: "text",
      position: sql`(select coalesce(max(position), 0) + 1 from channel where community_id = ${communityId})`,
    }).returning({ id: channel.id });
    await tx.insert(publicChannel).values({ channelId: created.id, communityTitle: data.communityTitle, channelTitle: data.name });
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: "channel.publish", targetId: created.id });
    return created.id;
  });
  await publish({ type: "channels.changed", communityId });
  return id;
}

export async function unpublishChannel(userId: string, rawChannelId: unknown) {
  const channelId = parse(uuid, rawChannelId);
  const { channel: ch } = await requireChannel(db, channelId, userId);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, ch.communityId);
    const { authority } = await requireMember(tx, ch.communityId, userId);
    if (!authority.isOwner) throw forbidden("Only the owner can unpublish a channel.");
    const updated = await tx.update(publicChannel).set({ unpublishedAt: new Date() })
      .where(and(eq(publicChannel.channelId, channelId), isNull(publicChannel.unpublishedAt))).returning();
    if (!updated.length) throw invalid("This channel is not published. Unpublishing is permanent.");
    await tx.insert(auditLog).values({ communityId: ch.communityId, actorId: userId, action: "channel.unpublish", targetId: channelId });
  });
  await publish({ type: "channels.changed", communityId: ch.communityId });
}

/** Must run under lockCommunity for every writer, including webhooks. Old clients fail closed. */
export async function checkPublicPost(tx: Db, channelId: string, consent: unknown, content: string, attachments: string[] = [], replyToId: string | null = null, threadId: string | null = null) {
  const [publication] = await tx.select().from(publicChannel).where(eq(publicChannel.channelId, channelId));
  if (!publication) return null;
  if (publication.unpublishedAt) throw forbidden("This public channel was permanently unpublished. Create a new channel to publish again.");
  if (consent !== publication.generation) throw forbidden("Acknowledge public posting for this channel before sending or editing.");
  if (attachments.length || replyToId || threadId || new RegExp(ASSET_TOKEN_SOURCE, "i").test(content)) {
    throw invalid("Public channels accept text only, without attachments, community images, replies or threads.");
  }
  return publication;
}

export function publicText(content: string) {
  return content.replace(/<@[^>\n]{1,128}>/g, "@member")
    .replace(new RegExp(ASSET_TOKEN_SOURCE, "gi"), "[community image]")
    .replace(/(?:https?:\/\/[^\s<>]+)?\/api\/(?:attachments|community-assets)\/[^\s<>]+/gi, "[private attachment]");
}

export async function snapshotPublicPost(tx: Db, row: typeof message.$inferSelect) {
  const [author] = await tx.select({ name: user.name }).from(user).where(eq(user.id, row.authorId));
  await tx.insert(publicPost).values({ messageId: row.id, channelId: row.channelId, authorName: author.name, content: publicText(row.content), createdAt: row.createdAt });
}

function cursor(raw: unknown) {
  if (raw === undefined || raw === null) return undefined;
  const result = uuid.safeParse(raw);
  return result.success ? result.data : null;
}

export async function listPublicChannels(rawBefore?: unknown) {
  const before = cursor(rawBefore);
  if (before === null) return { channels: [], next: null };
  const rows = await db.select({ id: publicChannel.channelId, communityTitle: publicChannel.communityTitle, title: publicChannel.channelTitle })
    .from(publicChannel).innerJoin(channel, eq(channel.id, publicChannel.channelId)).innerJoin(community, eq(community.id, channel.communityId))
    .where(and(visible(), before ? lt(publicChannel.channelId, before) : undefined)).orderBy(desc(publicChannel.channelId)).limit(PUBLIC_PAGE_SIZE + 1);
  return { channels: rows.slice(0, PUBLIC_PAGE_SIZE), next: rows.length > PUBLIC_PAGE_SIZE ? rows[PUBLIC_PAGE_SIZE - 1].id : null };
}

/** Metadata and content come from one statement with current visibility predicates; no private DTOs. */
export async function readPublicChannel(rawId: unknown, rawBefore?: unknown) {
  const parsed = uuid.safeParse(rawId); const before = cursor(rawBefore);
  if (!parsed.success || before === null) return null;
  const rows = await db.select({ communityTitle: publicChannel.communityTitle, title: publicChannel.channelTitle,
    posts: sql<Array<{ id: string; authorName: string; content: string; createdAt: string; editedAt: string | null }>>`coalesce((
      select json_agg(public_rows order by public_rows.id asc) from (
        select p.message_id as id, p.author_name as "authorName", p.content, p.created_at as "createdAt", p.edited_at as "editedAt"
        from public_post p join message m on m.id = p.message_id
        where p.channel_id = ${publicChannel.channelId} and m.channel_id = ${publicChannel.channelId}
          and ${activeUser(sql`m.author_id`)} ${before ? sql`and p.message_id < ${before}::uuid` : sql``}
        order by p.message_id desc limit ${PUBLIC_PAGE_SIZE + 1}
      ) public_rows), '[]'::json)`,
  }).from(publicChannel).innerJoin(channel, eq(channel.id, publicChannel.channelId)).innerJoin(community, eq(community.id, channel.communityId))
    .where(and(eq(publicChannel.channelId, parsed.data), visible()));
  if (!rows[0]) return null;
  const { posts, ...titles } = rows[0];
  const hasMore = posts.length > PUBLIC_PAGE_SIZE;
  const bounded = hasMore ? posts.slice(1) : posts;
  return { ...titles, posts: bounded, next: hasMore ? bounded[0].id : null };
}

/** Narrow reporting branch; membership/private context is deliberately not returned. */
export async function publicReportTarget(tx: Db, messageId: string) {
  const [row] = await tx.select({ communityId: channel.communityId, channelId: channel.id }).from(publicPost)
    .innerJoin(message, and(eq(message.id, publicPost.messageId), eq(message.channelId, publicPost.channelId)))
    .innerJoin(publicChannel, eq(publicChannel.channelId, publicPost.channelId))
    .innerJoin(channel, eq(channel.id, publicChannel.channelId)).innerJoin(community, eq(community.id, channel.communityId))
    .where(and(eq(publicPost.messageId, messageId), visible(), activeUser(sql`${message.authorId}`)));
  return row;
}

export async function publicChannelState(userId: string, channelId: string) {
  await requireChannel(db, channelId, userId);
  const [row] = await db.select({ generation: publicChannel.generation, unpublishedAt: publicChannel.unpublishedAt }).from(publicChannel).where(eq(publicChannel.channelId, channelId));
  return row ? { generation: row.generation, unpublished: !!row.unpublishedAt } : null;
}
