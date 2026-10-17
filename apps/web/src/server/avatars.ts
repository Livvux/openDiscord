// Profile pictures: one re-encoded square WebP per account, stored like attachments (docs/DECISIONS.md D9).
// Replaced or removed pictures and those of deleted accounts lose their link and the media sweeper deletes them.
import { and, eq, getTableName, gt, isNull, sql, type Column, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { attachment, dmConversation, friendship, member } from "@/db/schema";
import { configuredAttachmentStorage } from "./attachment-storage";
import { AVATAR_RAW_BYTES } from "@/lib/limits";
import { AppError, invalid, notFound } from "./errors";
import { AccountBlocked, assertActiveUser } from "./instance-policy";
import { consume } from "./limits";
import { stageAvatarAttachment, sweepAttachments } from "./media";
import { parse, uuid } from "./validation";

const storage = configuredAttachmentStorage();

/** The current picture's id for a user id column, or null; the id doubles as the cache-busting version. */
// Both sides are qualified by hand: drizzle leaves columns unqualified in single-table selects,
// where "id" would bind to the attachment inside the subquery.
export const avatarOf = (userId: Column): SQL<string | null> =>
  sql<string | null>`(select avatar.id from ${attachment} avatar where avatar.avatar_user_id = ${sql.identifier(getTableName(userId.table))}.${sql.identifier(userId.name)})`;

export async function ownAvatar(userId: string): Promise<string | null> {
  const [row] = await db.select({ id: attachment.id }).from(attachment).where(eq(attachment.avatarUserId, userId));
  return row?.id ?? null;
}

export async function setAvatar(userId: string, contentLength: number, body: (limit: number) => Promise<Uint8Array>, requestSignal: AbortSignal): Promise<string> {
  // Checked before reading the body, so oversized uploads are never buffered.
  if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > AVATAR_RAW_BYTES) throw invalid(`Profile pictures can be at most ${AVATAR_RAW_BYTES / 1024 / 1024} MB.`);
  await consume(`avatar:${userId}`, 5, 60_000);
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(60_000)]);
  const staged = await stageAvatarAttachment(userId, await body(contentLength), signal);
  signal.throwIfAborted();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`avatar:${userId}`}, 0))`);
    // Unlink the previous picture first: the unique index allows one per account.
    await tx.update(attachment).set({ avatarUserId: null }).where(eq(attachment.avatarUserId, userId));
    const linked = await tx.update(attachment).set({ avatarUserId: userId, linkedAt: new Date() })
      .where(and(eq(attachment.id, staged.id), eq(attachment.uploaderId, userId), isNull(attachment.channelId), isNull(attachment.messageId),
        isNull(attachment.assetId), isNull(attachment.linkedAt), gt(attachment.createdAt, new Date(Date.now() - 10 * 60_000))))
      .returning({ id: attachment.id });
    if (linked.length !== 1) throw new AppError("conflict", "The uploaded picture is no longer available. Try again.");
  });
  void sweepAttachments().catch((error: unknown) => console.error("[avatars] sweep failed", error));
  return staged.id;
}

export async function removeAvatar(userId: string): Promise<void> {
  await consume(`avatar:${userId}`, 5, 60_000);
  await db.update(attachment).set({ avatarUserId: null }).where(eq(attachment.avatarUserId, userId));
  void sweepAttachments().catch((error: unknown) => console.error("[avatars] sweep failed", error));
}

const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];

/** Same audience as the profile card: yourself, a shared community, a friendship (or request) or a direct conversation. */
async function canSee(viewerId: string, ownerId: string): Promise<boolean> {
  if (viewerId === ownerId) return true;
  try { await assertActiveUser(ownerId); } catch (error) { if (error instanceof AccountBlocked) return false; throw error; }
  const [first, second] = pair(viewerId, ownerId);
  const { rows: [row] } = await db.execute<{ visible: boolean }>(sql`select (
    exists (select 1 from ${member} a join ${member} b on a.community_id = b.community_id where a.user_id = ${ownerId} and b.user_id = ${viewerId})
    or exists (select 1 from ${friendship} where first_id = ${first} and second_id = ${second})
    or exists (select 1 from ${dmConversation} where first_id = ${first} and second_id = ${second} and status <> 'rejected')
  ) as visible`);
  return row?.visible === true;
}

export async function readAvatar(viewerId: string, rawId: unknown): Promise<Response> {
  const id = parse(uuid, rawId);
  const [row] = await db.select({ key: attachment.key, ownerId: attachment.avatarUserId }).from(attachment).where(eq(attachment.id, id));
  if (!row?.ownerId || !storage || !(await canSee(viewerId, row.ownerId))) throw notFound("Profile picture not found.");
  const response = await storage.read(row.key);
  if (!response.ok || !response.body) throw notFound("Profile picture not found.");
  return new Response(response.body, {
    headers: {
      // The id changes with every new picture, so a cached copy is never stale; short enough for revoked access.
      "Cache-Control": "private, max-age=3600",
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
