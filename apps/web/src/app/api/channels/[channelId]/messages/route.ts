import { listMessages } from "@/server/messages";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { requireUser } from "@/server/session";

/** Message history: newest page, or older pages with `?before=<messageId>`; a thread with `?thread=<rootId>`. */
export async function GET(request: Request, ctx: RouteContext<"/api/channels/[channelId]/messages">) {
  try {
    const user = await requireUser(request.headers);
    const { channelId } = await ctx.params;
    const params = new URL(request.url).searchParams;
    return Response.json(await listMessages(user.id, channelId, params.get("before"), params.get("thread")), { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
