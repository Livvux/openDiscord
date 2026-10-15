import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { onlineMembers } from "@/server/presence";
import { requireUser } from "@/server/session";

/** Ids of members who are online and chose to show it. */
export async function GET(request: Request, ctx: RouteContext<"/api/communities/[communityId]/presence">) {
  try {
    const user = await requireUser(request.headers);
    const { communityId } = await ctx.params;
    return Response.json(await onlineMembers(user.id, communityId), { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
