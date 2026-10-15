import { and, asc, count, eq, gt, inArray, isNull, sql, sum } from "drizzle-orm";
import { db } from "@/db";
import { attachment, auditLog, channel, communityAsset } from "@/db/schema";
import { assetRawLimit, assetRefSchema, assetTokens, MAX_COMMUNITY_ASSET_BYTES, MAX_COMMUNITY_EMOJI, MAX_COMMUNITY_STICKERS, MAX_MESSAGE_ASSETS, MAX_MESSAGE_STICKERS, type AssetRef, type AssetView } from "@/lib/community-assets";
import { lockCommunity, requireChannel, requireMember, type Db } from "./access";
import { configuredAttachmentStorage } from "./attachment-storage";
import { AppError, invalid, notFound } from "./errors";
import { PRIVATE_NO_STORE } from "./http";
import { consume } from "./limits";
import { stageCommunityAssetAttachment } from "./media";
import { Permission } from "./permissions";
import { publish } from "./realtime";
import { parse, uuid } from "./validation";

const inputSchema = assetRefSchema.omit({ id: true });
const storage = configuredAttachmentStorage();
const viewColumns = { id: communityAsset.id, name: communityAsset.name, kind: communityAsset.kind, width: attachment.width, height: attachment.height };

export async function listCommunityAssets(userId: string, rawCommunityId: unknown): Promise<AssetView[]> {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, userId);
  return db.select(viewColumns).from(communityAsset).innerJoin(attachment, eq(attachment.assetId, communityAsset.id))
    .where(eq(communityAsset.communityId, communityId)).orderBy(asc(communityAsset.kind), asc(communityAsset.name));
}

export async function createCommunityAsset(userId: string, rawCommunityId: unknown, rawInput: unknown, contentLength: number, body: (limit: number) => Promise<Uint8Array>, requestSignal: AbortSignal): Promise<AssetView> {
  const communityId = parse(uuid, rawCommunityId);
  const input = parse(inputSchema, rawInput);
  if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > assetRawLimit(input.kind)) throw invalid("That community image exceeds the upload limit.");
  await requireMember(db, communityId, userId, Permission.ManageCommunity);
  await consume(`upload:${userId}`, 10, 60_000);
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(5 * 60_000)]);
  const staged = await stageCommunityAssetAttachment(userId, input.kind, await body(contentLength), signal);
  signal.throwIfAborted();
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local transaction_timeout = '30s'`);
    await tx.execute(sql`set local statement_timeout = '15s'`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await lockCommunity(tx, communityId);
    await requireMember(tx, communityId, userId, Permission.ManageCommunity);
    const [file] = await tx.select().from(attachment).where(and(eq(attachment.id, staged.id), eq(attachment.uploaderId, userId),
      isNull(attachment.messageId), isNull(attachment.channelId), isNull(attachment.assetId), isNull(attachment.linkedAt),
      gt(attachment.createdAt, new Date(Date.now() - 10 * 60_000)))).for("update");
    if (!file) throw new AppError("conflict", "The uploaded community image is no longer available.");
    await checkLibraryCapacity(tx, communityId, input.kind, file.size);
    const [existing] = await tx.select({ id: communityAsset.id }).from(communityAsset).where(and(eq(communityAsset.communityId, communityId), eq(communityAsset.name, input.name)));
    if (existing) throw new AppError("conflict", "That community image name is already in use.");
    const [asset] = await tx.insert(communityAsset).values({ communityId, ...input }).returning();
    const linked = await tx.update(attachment).set({ assetId: asset.id, linkedAt: new Date() })
      .where(and(eq(attachment.id, file.id), eq(attachment.uploaderId, userId), isNull(attachment.channelId), isNull(attachment.messageId), isNull(attachment.assetId), isNull(attachment.linkedAt))).returning({ id: attachment.id });
    if (linked.length !== 1) throw new AppError("conflict", "The uploaded community image is no longer available.");
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: "asset.create", targetId: input.name });
    await publish({ type: "assets.changed", communityId }, tx);
    return { id: asset.id, name: asset.name, kind: asset.kind, width: file.width, height: file.height };
  });
}

async function checkLibraryCapacity(tx: Db, communityId: string, kind: AssetRef["kind"], additionalBytes: number) {
  const [{ number }] = await tx.select({ number: count() }).from(communityAsset).where(and(eq(communityAsset.communityId, communityId), eq(communityAsset.kind, kind)));
  const cap = kind === "emoji" ? MAX_COMMUNITY_EMOJI : MAX_COMMUNITY_STICKERS;
  if (number >= cap) throw new AppError("conflict", `This community can have at most ${cap} ${kind === "emoji" ? "custom emoji" : "stickers"}.`);
  const [{ bytes }] = await tx.select({ bytes: sum(attachment.size).mapWith(Number) }).from(communityAsset)
    .innerJoin(attachment, eq(attachment.assetId, communityAsset.id)).where(eq(communityAsset.communityId, communityId));
  if ((bytes ?? 0) + additionalBytes > MAX_COMMUNITY_ASSET_BYTES) throw new AppError("conflict", "The community image library can use at most 64 MiB.");
}

export async function deleteCommunityAsset(userId: string, rawCommunityId: unknown, rawId: unknown): Promise<void> {
  const communityId = parse(uuid, rawCommunityId);
  const id = parse(uuid, rawId);
  await consume(`asset-delete:${userId}`, 20, 60_000);
  await db.transaction(async (tx) => {
    await lockCommunity(tx, communityId);
    await requireMember(tx, communityId, userId, Permission.ManageCommunity);
    const [removed] = await tx.delete(communityAsset).where(and(eq(communityAsset.id, id), eq(communityAsset.communityId, communityId))).returning({ name: communityAsset.name });
    if (!removed) throw notFound("Community image not found.");
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: "asset.delete", targetId: removed.name });
    await publish({ type: "assets.changed", communityId }, tx);
  });
}

export async function readCommunityAsset(userId: string, rawId: unknown): Promise<Response> {
  const id = parse(uuid, rawId);
  const [row] = await db.select({ communityId: communityAsset.communityId, key: attachment.key }).from(communityAsset)
    .innerJoin(attachment, eq(attachment.assetId, communityAsset.id)).where(eq(communityAsset.id, id));
  if (!row || !storage) throw notFound("Community image not found.");
  await requireMember(db, row.communityId, userId);
  const response = await storage.read(row.key);
  if (!response.ok || !response.body) throw notFound("Community image not found.");
  return new Response(response.body, { headers: { ...PRIVATE_NO_STORE, "Content-Type": "image/webp", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
}

/** Called under the community mutation lock after current channel/rules authorization. */
export async function validateCommunityAssetRefs(tx: Db, communityId: string, content: string): Promise<void> {
  const refs = assetTokens(content);
  if (refs.length > MAX_MESSAGE_ASSETS || refs.filter((ref) => ref.kind === "sticker").length > MAX_MESSAGE_STICKERS) throw invalid("A message can include at most 32 custom images and 3 stickers.");
  if (refs.length === 0) return;
  const rows = await tx.select().from(communityAsset).where(and(eq(communityAsset.communityId, communityId), inArray(communityAsset.id, [...new Set(refs.map((ref) => ref.id))])));
  const known = new Map(rows.map((row) => [row.id, row]));
  if (refs.some((ref) => known.get(ref.id)?.kind !== ref.kind || known.get(ref.id)?.name !== ref.name)) throw invalid("A community image was removed or belongs to another community. Remove it and choose it again.");
}

/** Read DTOs are scoped to each message channel, even for raw tokens in historical content. */
export async function assetsForMessages(rows: readonly { id: string; channelId: string; content: string }[]): Promise<Map<string, AssetView[]>> {
  const ids = [...new Set(rows.flatMap((row) => assetTokens(row.content).map((ref) => ref.id)))];
  const result = new Map<string, AssetView[]>();
  if (ids.length === 0) return result;
  const assets = await db.select({ ...viewColumns, channelId: channel.id }).from(communityAsset)
    .innerJoin(attachment, eq(attachment.assetId, communityAsset.id)).innerJoin(channel, eq(channel.communityId, communityAsset.communityId))
    .where(and(inArray(communityAsset.id, ids), inArray(channel.id, [...new Set(rows.map((row) => row.channelId))])));
  const known = new Map(assets.map(({ channelId, ...asset }) => [`${channelId}:${asset.id}`, asset]));
  for (const row of rows) result.set(row.id, assetTokens(row.content).flatMap((ref) => {
    const asset = known.get(`${row.channelId}:${ref.id}`);
    return asset?.name === ref.name && asset.kind === ref.kind ? [asset] : [];
  }));
  return result;
}

export async function listChannelAssets(userId: string, rawChannelId: unknown): Promise<AssetView[]> {
  const { channel } = await requireChannel(db, parse(uuid, rawChannelId), userId);
  return listCommunityAssets(userId, channel.communityId);
}
