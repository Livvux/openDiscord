// Server-Sent Events for one community. The browser's EventSource reconnects on its own;
// connections are capped in lifetime so access is re-checked regularly.
import { db } from "@/db";
import { loadAuthority, loadChannelAuthority } from "@/server/access";
import { AppError, notFound } from "@/server/errors";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { getMessageForBroadcast } from "@/server/messages";
import { hub, type HubEvent } from "@/server/realtime";
import { requireUser } from "@/server/session";
import { parse, uuid } from "@/server/validation";

const HEARTBEAT_MS = 25_000;
const MAX_LIFETIME_MS = 10 * 60_000;
/** Several tabs are fine; hundreds of streams from one account are abuse. Per process. */
const MAX_STREAMS_PER_USER = 8;

const openStreams = new Map<string, number>();

// The hub hands the same event object to every stream in this process, so each message is
// loaded once per event (not once per subscriber) and never served stale after a later edit.
const loads = new WeakMap<HubEvent, ReturnType<typeof getMessageForBroadcast>>();
function loadOnce(event: HubEvent & { messageId: string }) {
  let load = loads.get(event);
  if (!load) {
    load = getMessageForBroadcast(event.messageId);
    loads.set(event, load);
  }
  return load;
}

async function authorize(request: Request, ctx: RouteContext<"/api/communities/[communityId]/events">) {
  const userId = (await requireUser(request.headers)).id;
  const communityId = parse(uuid, (await ctx.params).communityId);
  if (!(await loadAuthority(db, communityId, userId))) throw notFound("Community not found.");
  return { userId, communityId };
}

/** Checks refused stream connections without opening another stream or consuming a stream slot. */
export async function HEAD(request: Request, ctx: RouteContext<"/api/communities/[communityId]/events">) {
  try {
    await authorize(request, ctx);
    return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}

export async function GET(request: Request, ctx: RouteContext<"/api/communities/[communityId]/events">) {
  let userId: string;
  let communityId: string;
  try {
    ({ userId, communityId } = await authorize(request, ctx));
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

      const checkAccess = async () => {
        try {
          await requireUser(request.headers);
          if (await loadAuthority(db, communityId, userId)) return true;
        } catch { /* A revoked or suspended session must stop receiving events. */ }
        send("removed", {});
        close();
        return false;
      };
      const onEvent = async (event: HubEvent) => {
        if (!(await checkAccess())) return;
        // Private channels: only readers of the channel learn that anything happened in it.
        if ("channelId" in event && !(await loadChannelAuthority(db, event.channelId, userId))) return;
        switch (event.type) {
          case "message.created":
          case "message.updated": {
            const loaded = await loadOnce(event);
            // Ignore events whose message isn't in this community.
            if (loaded && loaded.communityId === communityId) send(event.type, loaded.message);
            break;
          }
          case "member.removed":
            if (event.userId === userId) {
              send("removed", {});
              close();
            }
            break;
          case "community.deleted":
            send("removed", {});
            close();
            break;
          case "resync":
            // Removal events may have been missed while the LISTEN connection was down.
            if (!(await loadAuthority(db, communityId, userId))) {
              send("removed", {});
              close();
            } else send("resync", {});
            break;
          default:
            send(event.type, event);
        }
      };

      const unsubscribe = hub.subscribe(communityId, (e) =>
        onEvent(e).catch((error: unknown) => {
          console.error("[realtime] failed to forward event", error);
          close();
        }),
      );
      // A named event (not a comment) so the client can detect dead connections.
      const heartbeat = setInterval(() => { void checkAccess().then((allowed) => { if (allowed) send("ping", {}); }); }, HEARTBEAT_MS);
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
      // Retry quickly after the planned lifetime close.
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
