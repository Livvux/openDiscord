// Server picture and banner: one re-encoded WebP each, stored like profile pictures (see avatars.ts).
// A replaced or removed picture loses its link from the community row and the media sweeper deletes it.
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { attachment, auditLog, community, member } from "@/db/schema";
import { MAX_ATTACHMENT_BYTES } from "@/lib/limits";
import { lockCommunity, requireMember } from "./access";
import { configuredAttachmentStorage } from "./attachment-storage";
import { listed } from "./discovery";
import { AppError, invalid, notFound } from "./errors";
import { consume } from "./limits";
import { stageCommunityImage, sweepAttachments } from "./media";
import { Permission } from "./permissions";
import { parse, uuid } from "./validation";

const storage = configuredAttachmentStorage();
export const imageKind = z.enum(["icon", "banner"]);
export type CommunityImageKind = z.infer<typeof imageKind>;
const column = { icon: "iconId", banner: "bannerId" } as const;

const sweep = () => void sweepAttachments().catch((error: unknown) => console.error("[community-images] sweep failed", error));

export async function setCommunityImage(userId: string, rawCommunityId: unknown, rawKind: unknown, contentLength: number, body: (limit: number) => Promise<Uint8Array>, requestSignal: AbortSignal): Promise<string> {
  const communityId = parse(uuid, rawCommunityId);
  const kind = parse(imageKind, rawKind);
  // Checked before reading the body, so oversized uploads are never buffered.
  if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_ATTACHMENT_BYTES) throw invalid(`Community pictures can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  await requireMember(db, communityId, userId, Permission.ManageCommunity);
  await consume(`community-image:${userId}`, 10, 60_000);
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(60_000)]);
  const staged = await stageCommunityImage(userId, kind, await body(contentLength), signal);
  signal.throwIfAborted();
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    // Re-checked under the lock: the uploader may have lost the permission meanwhile.
    await requireMember(tx, communityId, userId, Permission.ManageCommunity);
    const linked = await tx.update(attachment).set({ linkedAt: new Date() })
      .where(and(eq(attachment.id, staged.id), eq(attachment.uploaderId, userId), isNull(attachment.channelId), isNull(attachment.messageId),
        isNull(attachment.assetId), isNull(attachment.avatarUserId), isNull(attachment.linkedAt), gt(attachment.createdAt, new Date(Date.now() - 10 * 60_000))))
      .returning({ id: attachment.id });
    if (linked.length !== 1) throw new AppError("conflict", "The uploaded picture is no longer available. Try again.");
    await tx.update(community).set({ [column[kind]]: staged.id }).where(eq(community.id, communityId));
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: `community.${kind}` });
  });
  sweep();
  return staged.id;
}

export async function removeCommunityImage(userId: string, rawCommunityId: unknown, rawKind: unknown): Promise<void> {
  const communityId = parse(uuid, rawCommunityId);
  const kind = parse(imageKind, rawKind);
  await consume(`community-image:${userId}`, 10, 60_000);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    await requireMember(tx, communityId, userId, Permission.ManageCommunity);
    await tx.update(community).set({ [column[kind]]: null }).where(eq(community.id, communityId));
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: `community.${kind}` });
  });
  sweep();
}

/**
 * Members always see their community's pictures. Pictures of listed (Discover) communities are public,
 * also signed out: link previews and the public directory show them.
 */
export async function readCommunityImage(viewerId: string | null, rawId: unknown): Promise<Response> {
  const id = parse(uuid, rawId);
  const membership = viewerId ? sql`exists (select 1 from ${member} m where m.community_id = ${community.id} and m.user_id = ${viewerId})` : sql`false`;
  const [row] = await db.select({ key: attachment.key }).from(community)
    .innerJoin(attachment, or(eq(attachment.id, community.iconId), eq(attachment.id, community.bannerId)))
    .where(and(eq(attachment.id, id), or(listed(), and(isNull(community.suspendedAt), membership))));
  if (!row || !storage) throw notFound("Community picture not found.");
  const response = await storage.read(row.key);
  if (!response.ok || !response.body) throw notFound("Community picture not found.");
  return new Response(response.body, {
    headers: {
      // A new picture gets a new id, so a cached copy is never stale; short enough for unlisted communities.
      "Cache-Control": "private, max-age=3600",
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

