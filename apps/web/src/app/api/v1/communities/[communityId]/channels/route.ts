import { getCommunityView } from "@/server/communities";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { requireBot } from "@/server/integrations";

/** Channels the bot can view, in sidebar order. */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/communities/[communityId]/channels">) {
  try {
    const { userId } = await requireBot(request.headers);
    const { communityId } = await ctx.params;
    const view = await getCommunityView(userId, communityId);
    return Response.json(
      view.channels.map(({ id, name, topic, kind, categoryId }) => ({ id, name, topic, kind, categoryId })),
      { headers: PRIVATE_NO_STORE },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
