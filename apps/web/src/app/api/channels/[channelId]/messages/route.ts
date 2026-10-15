import { listMessages } from "@/server/messages";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { requireUser } from "@/server/session";

/** Message history: newest page, or older pages with `?before=<messageId>`. */
export async function GET(request: Request, ctx: RouteContext<"/api/channels/[channelId]/messages">) {
  try {
    const user = await requireUser(request.headers);
    const { channelId } = await ctx.params;
    const before = new URL(request.url).searchParams.get("before");
    return Response.json(await listMessages(user.id, channelId, before), { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
