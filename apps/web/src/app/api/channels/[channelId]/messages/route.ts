import { listMessages } from "@/server/messages";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { requireUser } from "@/server/session";

/**
 * Message history: newest page; `?before=<id>` older, `?after=<id>` newer, `?around=<id>` centered on a message;
 * a thread with `?thread=<rootId>`.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/channels/[channelId]/messages">) {
  try {
    const user = await requireUser(request.headers);
    const { channelId } = await ctx.params;
    const params = new URL(request.url).searchParams;
    const page = await listMessages(user.id, channelId, params.get("before"), params.get("thread"), { after: params.get("after"), around: params.get("around") });
    return Response.json(page, { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
