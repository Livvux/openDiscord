import { lockVoiceLifecycle } from "./voice-locks";
import { invalidateVoiceMembership } from "./voice-control";
import { assetText } from "@/lib/community-assets";
// Bots and incoming webhooks. A bot is a member like anyone else: its roles decide what it may do,
// and the public API calls the same services as the app. A webhook can only post plain messages into
// its one channel. Tokens are shown once and stored as SHA-256 hashes (they are high-entropy secrets).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLog, channel, community, integration, member, message, user } from "@/db/schema";
import { lockCommunity, requireMember } from "./access";
import { enforceAutomod } from "./automod";
import { AppError, notFound } from "./errors";
import { assertActiveUser } from "./instance-policy";
import { consume, enforceCap } from "./limits";
import { parseMentionIds } from "./mentions";
import { getMessageForBroadcast, RATE_LIMIT, type MessageView } from "./messages";
import { Permission, resolveAuthority } from "./permissions";
import { publish } from "./realtime";
import { checkPublicPost, publicText, snapshotPublicPost } from "./public-channels";
import { messageContent, parse, uuid } from "./validation";

export const MAX_INTEGRATIONS = 25;
const integrationName = z.string().trim().min(1, "Give it a name.").max(32, "Use at most 32 characters.");

export interface IntegrationSummary {
  id: string;
  kind: "bot" | "webhook";
  name: string;
  channelId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface CreatedIntegration {
  id: string;
  /** Shown once; only its hash is stored. */
  token: string;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export async function listIntegrations(userId: string, rawCommunityId: unknown): Promise<IntegrationSummary[]> {
  const communityId = parse(uuid, rawCommunityId);
  await requireMember(db, communityId, userId, Permission.ManageCommunity);
  return db
    .select({
      id: integration.id, kind: integration.kind, name: integration.name, channelId: integration.channelId,
      createdAt: integration.createdAt, lastUsedAt: integration.lastUsedAt,
    })
    .from(integration)
    .where(and(eq(integration.communityId, communityId), isNull(integration.revokedAt)))
    .orderBy(asc(integration.createdAt));
}

const createInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), name: integrationName }),
  z.object({ kind: z.literal("webhook"), name: integrationName, channelId: uuid }),
]);

/** Creates a bot (joined as a member with the default role) or a webhook for one text channel. */
export async function createIntegration(userId: string, rawCommunityId: unknown, rawInput: unknown): Promise<CreatedIntegration> {
  const communityId = parse(uuid, rawCommunityId);
  const input = parse(createInput, rawInput);
  const token = newToken(input.kind === "bot" ? "od_bot" : "od_wh");
  const id = await db.transaction(async (tx) => {
    await lockVoiceLifecycle(tx, "auth");
    await lockCommunity(tx, communityId);
    await requireMember(tx, communityId, userId, Permission.ManageCommunity);
    const [{ total }] = await tx.select({ total: count() }).from(integration)
      .where(and(eq(integration.communityId, communityId), isNull(integration.revokedAt)));
    enforceCap(total, MAX_INTEGRATIONS, `A community can have at most ${MAX_INTEGRATIONS} bots and webhooks.`);
    if (input.kind === "webhook") {
      const [ch] = await tx.select({ kind: channel.kind }).from(channel)
        .where(and(eq(channel.id, input.channelId), eq(channel.communityId, communityId)));
      if (!ch) throw notFound("Channel not found.");
      if (ch.kind !== "text") throw new AppError("invalid", "Webhooks post into text channels.");
    }
    // Its own account: no password or session ever exists for it, and the address can't receive mail.
    const botUserId = randomUUID();
    await tx.insert(user).values({ id: botUserId, name: input.name, email: `${botUserId}@bots.invalid`, approvalStatus: "approved" });
    if (input.kind === "bot") await tx.insert(member).values({ communityId, userId: botUserId });
    const [created] = await tx.insert(integration).values({
      communityId, kind: input.kind, name: input.name, userId: botUserId,
      channelId: input.kind === "webhook" ? input.channelId : null, tokenHash: hash(token), createdBy: userId,
    }).returning({ id: integration.id });
    await tx.insert(auditLog).values({ communityId, actorId: userId, action: `${input.kind}.create`, targetId: botUserId });
    return created.id;
  });
  if (input.kind === "bot") await publish({ type: "channels.changed", communityId });
  return { id, token };
}

/** Revokes the token at once; a bot also leaves the community. Its past messages stay. */
export async function revokeIntegration(userId: string, rawId: unknown): Promise<void> {
  const id = parse(uuid, rawId);
  const [row] = await db.select().from(integration).where(and(eq(integration.id, id), isNull(integration.revokedAt)));
  if (!row) throw notFound("Integration not found.");
  await db.transaction(async (tx) => {
    await lockVoiceLifecycle(tx);
    await lockCommunity(tx, row.communityId);
    await requireMember(tx, row.communityId, userId, Permission.ManageCommunity);
    await tx.update(integration).set({ revokedAt: new Date() }).where(eq(integration.id, id));
    if (row.kind === "bot") await invalidateVoiceMembership(tx, { communityId: row.communityId, userId: row.userId }, "integration-revoked");
    if (row.kind === "bot") await tx.delete(member).where(and(eq(member.communityId, row.communityId), eq(member.userId, row.userId)));
    await tx.insert(auditLog).values({ communityId: row.communityId, actorId: userId, action: `${row.kind}.revoke`, targetId: row.userId });
  });
  if (row.kind === "bot") await publish({ type: "member.removed", communityId: row.communityId, userId: row.userId });
}

async function findByToken(kind: "bot" | "webhook", token: string) {
  const [row] = await db
    .select()
    .from(integration)
    .innerJoin(community, eq(community.id, integration.communityId))
    .where(and(eq(integration.tokenHash, hash(token)), eq(integration.kind, kind), isNull(integration.revokedAt), isNull(community.suspendedAt)));
  if (!row) return null;
  // Remember use at most once a minute (shown to managers).
  await db.update(integration).set({ lastUsedAt: new Date() })
    .where(and(eq(integration.id, row.integration.id), or(isNull(integration.lastUsedAt), lt(integration.lastUsedAt, new Date(Date.now() - 60_000)))));
  return row.integration;
}

/** Resolves `Authorization: Bot <token>` to the bot's user id, for the public API. */
export async function requireBot(headers: Headers): Promise<{ userId: string }> {
  const match = /^Bot\s+(od_bot_[A-Za-z0-9_-]{43})$/.exec(headers.get("authorization") ?? "");
  const bot = match ? await findByToken("bot", match[1]) : null;
  if (!bot) throw new AppError("unauthorized", "Missing or invalid bot token.");
  await assertActiveUser(bot.userId);
  await consume(`api:${bot.id}`, 60, 60_000);
  return { userId: bot.userId };
}

const webhookBody = z.object({ content: messageContent, publicGeneration: z.uuid().nullish() });

/** Posts a plain message through a webhook. Mentions become plain text: webhooks can't ping or badge anyone. */
/** `<@id>` → `@Name` for members of the community (others become "@member"). */
async function mentionsAsText(communityId: string, content: string): Promise<string> {
  const ids = parseMentionIds(content);
  if (ids.length === 0) return content;
  const rows = await db.select({ id: user.id, name: user.name }).from(member).innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.communityId, communityId), inArray(member.userId, ids)));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return content.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, id: string) => `@${names.get(id) ?? "member"}`);
}

export async function postWebhookMessage(rawId: unknown, rawToken: unknown, rawBody: unknown): Promise<MessageView> {
  const id = parse(uuid, rawId);
  const token = parse(z.string().regex(/^od_wh_[A-Za-z0-9_-]{43}$/, "Invalid webhook."), rawToken);
  const hook = await findByToken("webhook", token);
  // Wrong id/token pairs look exactly like unknown webhooks.
  if (!hook || hook.id !== id || !hook.channelId) throw notFound("Webhook not found.");
  const { content, publicGeneration } = parse(webhookBody, rawBody);
  await consume(`webhook:${hook.id}`, RATE_LIMIT.messages, RATE_LIMIT.windowSeconds * 1000);
  const since = new Date(Date.now() - RATE_LIMIT.windowSeconds * 1000);
  const [{ recent }] = await db.select({ recent: count() }).from(message)
    .where(and(eq(message.authorId, hook.userId), gt(message.createdAt, since)));
  if (recent >= RATE_LIMIT.messages) throw new AppError("rate_limited", "This webhook is posting too quickly.");
  // Webhooks hold no permissions, so AutoMod always applies to them.
  await enforceAutomod(hook.communityId, hook.userId, resolveAuthority(false, []), content);
  const created = await db.transaction(async (tx) => {
    await lockCommunity(tx, hook.communityId);
    const [current] = await tx.select({ id: integration.id }).from(integration)
      .innerJoin(community, eq(community.id, integration.communityId))
      .where(and(eq(integration.id, hook.id), isNull(integration.revokedAt), isNull(community.suspendedAt)));
    if (!current) throw notFound("Webhook not found.");
    await assertActiveUser(hook.userId, tx);
    const publication = await checkPublicPost(tx, hook.channelId!, publicGeneration, content);
    // Public sends never resolve private member names before snapshotting.
    const text = publication ? publicText(content) : assetText(await mentionsAsText(hook.communityId, content));
    const [row] = await tx.insert(message).values({ channelId: hook.channelId!, authorId: hook.userId, content: text }).returning();
    if (publication) await snapshotPublicPost(tx, row);
    return row;
  });
  await publish({ type: "message.created", communityId: hook.communityId, channelId: hook.channelId, messageId: created.id });
  return (await getMessageForBroadcast(created.id))!.message;
}
