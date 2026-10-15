// The signed-in person's own event stream (mentions across all communities). Community streams carry
// channel traffic; this one only carries events addressed to one person.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { community } from "@/db/schema";
import { loadChannelAuthority } from "@/server/access";
import { AppError } from "@/server/errors";
import { errorResponse } from "@/server/http";
import { getMessageForBroadcast, type MessageView } from "@/server/messages";
import { hub, userTopic, type HubEvent } from "@/server/realtime";
import { requireUser } from "@/server/session";

const HEARTBEAT_MS = 25_000;
const MAX_LIFETIME_MS = 10 * 60_000;
const MAX_STREAMS_PER_USER = 8;
const EXCERPT_LENGTH = 140;

const openStreams = new Map<string, number>();

export interface MentionNotice {
  communityId: string;
  communityName: string;
  channelId: string;
  channelName: string;
  messageId: string;
  authorName: string;
  excerpt: string;
}

function excerpt(message: MessageView): string {
  const names = new Map(message.mentions.map((m) => [m.id, m.name]));
  const text = message.content.replace(/<@([A-Za-z0-9_-]+)>/g, (_, id: string) => `@${names.get(id) ?? "someone"}`);
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}

/** Re-checks visibility at delivery: access may have changed since the mention was written. */
async function mentionNotice(userId: string, event: Extract<HubEvent, { type: "mention.created" }>): Promise<MentionNotice | null> {
  const access = await loadChannelAuthority(db, event.channelId, userId);
  if (!access) return null;
  const loaded = await getMessageForBroadcast(event.messageId);
  if (!loaded || loaded.message.channelId !== event.channelId) return null;
  const [c] = await db.select({ name: community.name }).from(community).where(eq(community.id, access.channel.communityId));
  return {
    communityId: access.channel.communityId,
    communityName: c?.name ?? "",
    channelId: access.channel.id,
    channelName: access.channel.name,
    messageId: loaded.message.id,
    authorName: loaded.message.authorName,
    excerpt: excerpt(loaded.message),
  };
}

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = (await requireUser(request.headers)).id;
    if ((openStreams.get(userId) ?? 0) >= MAX_STREAMS_PER_USER) {
      throw new AppError("rate_limited", "Too many open connections. Close some tabs.");
    }
  } catch (error) {
    return errorResponse(error);
  }

  openStreams.set(userId, (openStreams.get(userId) ?? 0) + 1);
  const encoder = new TextEncoder();
  let cleanup = () => {};
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // Already cancelled by the client.
        }
      };
      // A revoked or suspended session must stop receiving events.
      const sessionValid = () => requireUser(request.headers).then(() => true, () => (close(), false));

      const onEvent = async (event: HubEvent) => {
        if (event.type === "resync") return send("resync", {});
        if (event.type !== "mention.created" || !(await sessionValid())) return;
        const notice = await mentionNotice(userId, event);
        if (notice) send("mention", notice);
      };
      const unsubscribe = hub.subscribe(userTopic(userId), (e) =>
        onEvent(e).catch((error: unknown) => {
          console.error("[realtime] failed to forward personal event", error);
          close();
        }),
      );
      const heartbeat = setInterval(() => void sessionValid().then((ok) => ok && send("ping", {})), HEARTBEAT_MS);
      const lifetime = setTimeout(close, MAX_LIFETIME_MS);
      let released = false;
      cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        if (released) return;
        released = true;
        const remaining = (openStreams.get(userId) ?? 1) - 1;
        if (remaining > 0) openStreams.set(userId, remaining);
        else openStreams.delete(userId);
      };
      request.signal.addEventListener("abort", close);
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      send("ready", {});
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
