// Server-Sent Events for one community. The browser's EventSource reconnects on its own;
// connections are capped in lifetime so access is re-checked regularly.
import { db } from "@/db";
import { loadAuthority, loadChannelAuthority } from "@/server/access";
import { notFound } from "@/server/errors";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { getMessageForBroadcast } from "@/server/messages";
import { hub, type HubEvent } from "@/server/realtime";
import { requireUser } from "@/server/session";
import { parse, uuid } from "@/server/validation";
import { acquireStreamLease, MAX_STREAM_LIFETIME_MS } from "@/server/stream-leases";

const HEARTBEAT_MS = 25_000;

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
  let release: () => Promise<void>;
  let communityId: string;
  try {
    ({ userId, communityId } = await authorize(request, ctx));
    release = await acquireStreamLease(userId, "community");
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
        unsubscribe = hub.subscribe(communityId, (e) =>
          onEvent(e).catch((error: unknown) => {
            console.error("[realtime] failed to forward event", error);
            close();
          }),
        );
        // A named event (not a comment) so the client can detect dead connections.
        heartbeat = setInterval(() => { void checkAccess().then((allowed) => { if (allowed) send("ping", {}); }); }, HEARTBEAT_MS);
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
