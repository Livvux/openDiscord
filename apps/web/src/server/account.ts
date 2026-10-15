// GDPR: data access/portability (export) and erasure (account deletion via Better Auth).
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { attachment, auditLog, ban, banAppeal, channel, community, communityAsset, member, message, passkey, publicChannel, publicPost, session, user } from "@/db/schema";
import { assetText } from "@/lib/community-assets";
import { exportDirectData } from "./direct-messages";
import { listBlocked } from "./blocks";
import { notFound } from "./errors";

/** 2: images. 3: blocked people. 4: file attachments. 5: own restrictions and appeals. 6: encrypted private messaging data. 7: community image upload attribution. 8: public snapshots and owned publication state. */
export const EXPORT_FORMAT_VERSION = 8;

/** An image (filename null) or another file. */
export interface ExportedImage { id: string; url: string; contentType: string; filename: string | null; size: number; width: number; height: number; createdAt: string }

export interface UserExport {
  publicPosts: { messageId: string; channelId: string; authorName: string; content: string; createdAt: string; editedAt: string | null }[];
  publicChannels: { channelId: string; communityId: string; generation: string; communityTitle: string; channelTitle: string; createdAt: string; unpublishedAt: string | null }[];
  communityImageUploads: { id: string; communityId: string; name: string; kind: "emoji" | "sticker"; size: number; createdAt: string }[];
  privateMessages: Awaited<ReturnType<typeof exportDirectData>>;
  format: "opendiscord.user-export";
  version: number;
  exportedAt: string;
  profile: { id: string; name: string; email: string; emailVerified: boolean; createdAt: string };
  sessions: { createdAt: string; expiresAt: string; userAgent: string | null }[];
  security: { twoFactorEnabled: boolean; passkeys: { name: string | null; deviceType: string; createdAt: string | null }[] };
  ownedCommunities: { id: string; name: string; createdAt: string }[];
  memberships: { communityId: string; communityName: string; joinedAt: string }[];
  /** Images download from `url` while signed in, like in the app. */
  messages: { id: string; communityId: string; channelName: string; content: string; createdAt: string; editedAt: string | null; images: ExportedImage[] }[];
  blocked: { id: string; name: string; createdAt: string }[];
  restrictions: { communityId: string; reason: string | null; createdAt: string }[];
  appeals: { communityId: string; content: string; createdAt: string; resolvedAt: string | null; resolution: "uphold" | "unban" | null; resolutionNote: string | null }[];
}

/** Everything stored about the person, as portable JSON. Excludes secrets (password hash, tokens). */
export async function exportUserData(userId: string): Promise<UserExport> {
  const [profile] = await db.select().from(user).where(eq(user.id, userId));
  if (!profile) throw notFound("Account not found.");
  const [sessions, passkeys, owned, memberships, messages, blocked, restrictions, appeals, publicPosts, publicChannels] = await Promise.all([
    db.select().from(session).where(eq(session.userId, userId)).orderBy(asc(session.createdAt)),
    db.select().from(passkey).where(eq(passkey.userId, userId)),
    db.select().from(community).where(eq(community.ownerId, userId)),
    db
      .select({ communityId: member.communityId, communityName: community.name, joinedAt: member.joinedAt })
      .from(member)
      .innerJoin(community, eq(community.id, member.communityId))
      .where(eq(member.userId, userId)),
    db
      .select({
        id: message.id,
        communityId: channel.communityId,
        channelName: channel.name,
        content: message.content,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
      })
      .from(message)
      .innerJoin(channel, eq(channel.id, message.channelId))
      .where(eq(message.authorId, userId))
      .orderBy(asc(message.id)),
    listBlocked(userId),
    db.select({ communityId: ban.communityId, reason: ban.reason, createdAt: ban.createdAt }).from(ban).where(eq(ban.userId, userId)).orderBy(asc(ban.createdAt)),
    db.select({ communityId: banAppeal.communityId, content: banAppeal.content, createdAt: banAppeal.createdAt,
      resolvedAt: banAppeal.resolvedAt, resolution: banAppeal.resolution, resolutionNote: banAppeal.resolutionNote,
    }).from(banAppeal).where(eq(banAppeal.userId, userId)).orderBy(asc(banAppeal.createdAt)),
    db.select({ messageId: publicPost.messageId, channelId: publicPost.channelId, authorName: publicPost.authorName,
      content: publicPost.content, createdAt: publicPost.createdAt, editedAt: publicPost.editedAt,
    }).from(publicPost).innerJoin(message, eq(message.id, publicPost.messageId))
      .where(eq(message.authorId, userId)).orderBy(asc(publicPost.messageId)),
    db.select({ channelId: publicChannel.channelId, communityId: channel.communityId, generation: publicChannel.generation,
      communityTitle: publicChannel.communityTitle, channelTitle: publicChannel.channelTitle,
      createdAt: publicChannel.createdAt, unpublishedAt: publicChannel.unpublishedAt,
    }).from(publicChannel).innerJoin(channel, eq(channel.id, publicChannel.channelId))
      .innerJoin(community, eq(community.id, channel.communityId)).where(eq(community.ownerId, userId)).orderBy(asc(publicChannel.channelId)),
  ]);
  const images = messages.length === 0 ? [] : await db.select({
    id: attachment.id, messageId: attachment.messageId, contentType: attachment.contentType, filename: attachment.filename, size: attachment.size,
    width: attachment.width, height: attachment.height, createdAt: attachment.createdAt,
  }).from(attachment).where(inArray(attachment.messageId, messages.map((m) => m.id))).orderBy(asc(attachment.id));
  const byMessage = Map.groupBy(images, (i) => i.messageId!);
  const imagesOf = (messageId: string): ExportedImage[] => (byMessage.get(messageId) ?? [])
    .map(({ id, contentType, filename, size, width, height, createdAt }) => ({ id, contentType, filename, size, width, height, url: `/api/attachments/${id}`, createdAt: createdAt.toISOString() }));

  const communityImageUploads = await db.select({ id: communityAsset.id, communityId: communityAsset.communityId,
    name: communityAsset.name, kind: communityAsset.kind, size: attachment.size, createdAt: attachment.createdAt,
  }).from(attachment).innerJoin(communityAsset, eq(communityAsset.id, attachment.assetId)).where(eq(attachment.uploaderId, userId));
  return {
    publicPosts: publicPosts.map((post) => ({ ...post, createdAt: post.createdAt.toISOString(), editedAt: post.editedAt?.toISOString() ?? null })),
    publicChannels: publicChannels.map((publication) => ({ ...publication, createdAt: publication.createdAt.toISOString(), unpublishedAt: publication.unpublishedAt?.toISOString() ?? null })),
    communityImageUploads: communityImageUploads.map((asset) => ({ ...asset, createdAt: asset.createdAt.toISOString() })),
    privateMessages: await exportDirectData(userId),
    format: "opendiscord.user-export",
    version: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    profile: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      emailVerified: profile.emailVerified,
      createdAt: profile.createdAt.toISOString(),
    },
    sessions: sessions.map((s) => ({
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      userAgent: s.userAgent,
    })),
    // Public keys and TOTP secrets are credentials, not personal content: only their existence is exported.
    security: {
      twoFactorEnabled: profile.twoFactorEnabled === true,
      passkeys: passkeys.map((p) => ({ name: p.name, deviceType: p.deviceType, createdAt: p.createdAt?.toISOString() ?? null })),
    },
    ownedCommunities: owned.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt.toISOString() })),
    memberships: memberships.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
    messages: messages.map((m) => ({
      ...m,
      content: assetText(m.content),
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt?.toISOString() ?? null,
      images: imagesOf(m.id),
    })),
    blocked: blocked.map((b) => ({ ...b, createdAt: b.createdAt.toISOString() })),
    restrictions: restrictions.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    appeals: appeals.map((a) => ({ ...a, createdAt: a.createdAt.toISOString(), resolvedAt: a.resolvedAt?.toISOString() ?? null })),
  };
}

export async function ownedCommunityNames(userId: string): Promise<string[]> {
  const rows = await db.select({ name: community.name }).from(community).where(eq(community.ownerId, userId));
  return rows.map((r) => r.name);
}

export async function twoFactorEnabled(userId: string): Promise<boolean> {
  const [row] = await db.select({ enabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId));
  return row?.enabled === true;
}

/** Erasure: audit entries about a deleted person keep the action but lose the link to them. */
export async function unlinkFromAuditLog(userId: string): Promise<void> {
  await db.update(auditLog).set({ targetId: null }).where(eq(auditLog.targetId, userId));
}
