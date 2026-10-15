import { listChannelAssets } from "@/server/community-assets";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { requireUser } from "@/server/session";

export async function GET(request: Request, ctx: RouteContext<"/api/channels/[channelId]/assets">) {
  try {
    const user = await requireUser(request.headers);
    return Response.json(await listChannelAssets(user.id, (await ctx.params).channelId), { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
