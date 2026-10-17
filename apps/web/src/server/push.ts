// Web Push for mentions and new private messages when no tab is open (or the tab is in the background). Optional: needs VAPID
// keys. Browsers deliver pushes through their vendor's push service (Google, Mozilla, Apple, Microsoft);
// the payload is end-to-end encrypted for the browser, so that service only sees that a push happened.
import { and, count, eq, inArray, or } from "drizzle-orm";
import webpush from "web-push";
import { z } from "zod";
import { db } from "@/db";
import { channel, community, pushSubscription, user, userBlock } from "@/db/schema";
import { loadChannelAuthority } from "./access";
import { AppError } from "./errors";
import { enforceCap } from "./limits";
import { getMessageForBroadcast } from "./messages";
import { mutedCommunities, presenceChoice } from "./presence";
import { excerptOf } from "@/lib/mentions";
import { parse } from "./validation";

const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const subject = process.env.VAPID_SUBJECT || "mailto:admin@localhost";

export const pushEnabled = Boolean(publicKey && privateKey);
export const vapidPublicKey = publicKey ?? null;
if (pushEnabled) webpush.setVapidDetails(subject, publicKey!, privateKey!);

export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/**
 * Push endpoints come from the browser, so they're user input: only well-known push services over
 * HTTPS are accepted, which keeps the server from being pointed at internal addresses (SSRF).
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];

export function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((h) => h.test(url.hostname));
  } catch {
    return false;
  }
}

const subscriptionInput = z.object({
  endpoint: z.string().max(1024).refine(isAllowedEndpoint, "This push service isn't supported."),
  // P-256 public key (65 bytes) and auth secret (16 bytes), base64url as browsers send them.
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{86,88}={0,2}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{21,24}={0,2}$/) }),
});

export async function savePushSubscription(userId: string, rawSubscription: unknown): Promise<void> {
  if (!pushEnabled) throw new AppError("not_found", "Push notifications aren't set up on this instance.");
  const sub = parse(subscriptionInput, rawSubscription);
  const [existing] = await db.select({ id: pushSubscription.id }).from(pushSubscription).where(eq(pushSubscription.endpoint, sub.endpoint));
  if (!existing) {
    const [{ total }] = await db.select({ total: count() }).from(pushSubscription).where(eq(pushSubscription.userId, userId));
    enforceCap(total, MAX_SUBSCRIPTIONS_PER_USER, `Push notifications can be on for at most ${MAX_SUBSCRIPTIONS_PER_USER} devices.`);
  }
  // An endpoint belongs to one browser profile: re-subscribing moves it to whoever is signed in now.
  await db
    .insert(pushSubscription)
    .values({ userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
    .onConflictDoUpdate({ target: pushSubscription.endpoint, set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
}

export async function deletePushSubscription(userId: string, rawEndpoint: unknown): Promise<void> {
  const endpoint = parse(z.string().max(1024), rawEndpoint);
  await db.delete(pushSubscription).where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)));
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** The transport, replaceable in tests. Resolves the HTTP status code. */
export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<number>;

const sendWithWebPush: PushSender = async (sub, payload) => {
  try {
    return (await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: "high" })).statusCode;
  } catch (error) {
    if (error instanceof webpush.WebPushError) return error.statusCode;
    throw error;
  }
};

/**
 * Pushes a mention to the person's devices if they can still read the channel and haven't muted the
 * community or set Do not disturb (people who blocked the author were already left out by `syncMentions`). Gone (404/410)
 * or unusable subscriptions are removed. Errors are logged, never thrown.
 */
export async function pushMention(userId: string, channelId: string, messageId: string, send: PushSender = sendWithWebPush): Promise<number> {
  if (!pushEnabled && send === sendWithWebPush) return 0;
  const subs = await db.select().from(pushSubscription).where(eq(pushSubscription.userId, userId));
  if (subs.length === 0) return 0;
  const access = await loadChannelAuthority(db, channelId, userId);
  if (!access) return 0;
  if ((await mutedCommunities(userId, [access.channel.communityId])).size > 0) return 0;
  if ((await presenceChoice(userId)) === "dnd") return 0;
  const loaded = await getMessageForBroadcast(messageId);
  if (!loaded) return 0;
  const [c] = await db.select({ name: community.name }).from(community).innerJoin(channel, eq(channel.communityId, community.id)).where(eq(channel.id, channelId));
  const payload: PushPayload = {
    title: `${loaded.message.authorName} in #${access.channel.name}`,
    body: excerptOf(loaded.message.content, loaded.message.mentions, 140) || "Sent an attachment",
    url: `/app/c/${access.channel.communityId}/${channelId}`,
    tag: messageId,
  };
  return deliver(subs, JSON.stringify({ ...payload, community: c?.name ?? "" }), send);
}

/**
 * New encrypted DM. The server cannot read it and never tries: the payload names the sender only.
 * Skipped for Do not disturb and blocks. One notification per conversation (same tag) instead of a stack.
 */
export async function pushDirectMessage(userId: string, senderId: string, send: PushSender = sendWithWebPush): Promise<number> {
  if (!pushEnabled && send === sendWithWebPush) return 0;
  const subs = await db.select().from(pushSubscription).where(eq(pushSubscription.userId, userId));
  if (subs.length === 0) return 0;
  if ((await presenceChoice(userId)) === "dnd") return 0;
  const [block] = await db.select({ id: userBlock.blockerId }).from(userBlock)
    .where(or(and(eq(userBlock.blockerId, userId), eq(userBlock.blockedId, senderId)), and(eq(userBlock.blockerId, senderId), eq(userBlock.blockedId, userId)))).limit(1);
  if (block) return 0;
  const [sender] = await db.select({ name: user.name }).from(user).where(eq(user.id, senderId));
  if (!sender) return 0;
  const payload: PushPayload = {
    title: sender.name,
    body: "New encrypted message",
    url: `/app/messages?to=${encodeURIComponent(senderId)}`,
    tag: `dm:${senderId}`,
  };
  return deliver(subs, JSON.stringify(payload), send);
}

async function deliver(subs: (typeof pushSubscription.$inferSelect)[], body: string, send: PushSender): Promise<number> {
  const gone: string[] = [];
  let delivered = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const status = await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
      if (status === 404 || status === 410) gone.push(s.id);
      else if (status < 300) delivered += 1;
    } catch (error) {
      // Network errors (ECONNRESET, ETIMEDOUT…) carry a code: keep the subscription and try next time.
      // Without one, encryption failed before any request, i.e. the stored keys are unusable: drop it.
      const network = typeof (error as { code?: unknown }).code === "string";
      console.error(`[push] send failed${network ? "" : "; removing the subscription"}`, error);
      if (!network) gone.push(s.id);
    }
  }));
  if (gone.length) await db.delete(pushSubscription).where(inArray(pushSubscription.id, gone));
  return delivered;
}
