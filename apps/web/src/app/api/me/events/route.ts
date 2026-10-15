// The signed-in person's own event stream (mentions across all communities). Community streams carry
// channel traffic; this one only carries events addressed to one person.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { community } from "@/db/schema";
import { loadChannelAuthority } from "@/server/access";
import { errorResponse } from "@/server/http";
import { getMessageForBroadcast, type MessageView } from "@/server/messages";
import { hub, userTopic, type HubEvent } from "@/server/realtime";
import { requireUser } from "@/server/session";
import { mutedCommunities, touchPresence } from "@/server/presence";
import { excerptOf } from "@/lib/mentions";
import { acquireStreamLease, MAX_STREAM_LIFETIME_MS } from "@/server/stream-leases";

const HEARTBEAT_MS = 25_000;
const EXCERPT_LENGTH = 140;

export interface MentionNotice {
  communityId: string;
  communityName: string;
  channelId: string;
  channelName: string;
  messageId: string;
  authorName: string;
  excerpt: string;
  /** The person muted this community: badge only, no desktop notification. */
  muted: boolean;
}

const excerpt = (message: MessageView) => excerptOf(message.content, message.mentions, EXCERPT_LENGTH);

/** Re-checks visibility at delivery: access may have changed since the mention was written. */
async function mentionNotice(userId: string, event: Extract<HubEvent, { type: "mention.created" }>): Promise<MentionNotice | null> {
  const access = await loadChannelAuthority(db, event.channelId, userId);
  if (!access) return null;
  const loaded = await getMessageForBroadcast(event.messageId);
  if (!loaded || loaded.message.channelId !== event.channelId) return null;
  const [c] = await db.select({ name: community.name }).from(community).where(eq(community.id, access.channel.communityId));
  const muted = await mutedCommunities(userId, [access.channel.communityId]);
  return {
    communityId: access.channel.communityId,
    communityName: c?.name ?? "",
    channelId: access.channel.id,
    channelName: access.channel.name,
    messageId: loaded.message.id,
    authorName: loaded.message.authorName,
    excerpt: excerpt(loaded.message),
    muted: muted.has(access.channel.communityId),
  };
}

export async function GET(request: Request) {
  let userId: string;
  let release: () => Promise<void>;
  try {
    userId = (await requireUser(request.headers)).id;
    release = await acquireStreamLease(userId, "personal");
  } catch (error) {
    return errorResponse(error);
  }

  const encoder = new TextEncoder();
  let cleanup: () => Promise<void> = release;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        void cleanup().catch((error: unknown) => console.error("[realtime] stream lease release failed", error));
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
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      cleanup = () => {
        request.signal.removeEventListener("abort", close);
        unsubscribe();
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        return release();
      };
      request.signal.addEventListener("abort", close, { once: true });
      // Abort may have happened while authentication or the database acquisition was pending.
      if (request.signal.aborted) { close(); return; }
      try {
        unsubscribe = hub.subscribe(userTopic(userId), (e) =>
          onEvent(e).catch((error: unknown) => {
            console.error("[realtime] failed to forward personal event", error);
            close();
          }),
        );
        // The heartbeat doubles as presence: an open tab means "online" (shown only if the person opted in).
        const beat = () => void sessionValid().then(async (ok) => {
          if (!ok) return;
          send("ping", {});
          await touchPresence(userId).catch((error: unknown) => console.error("[presence] touch failed", error));
        });
        void touchPresence(userId).catch((error: unknown) => console.error("[presence] touch failed", error));
        heartbeat = setInterval(beat, HEARTBEAT_MS);
        lifetime = setTimeout(close, MAX_STREAM_LIFETIME_MS);
      } catch (error) {
        close();
        throw error;
      }
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      send("ready", {});
    },
    cancel() {
      closed = true;
      return cleanup();
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
