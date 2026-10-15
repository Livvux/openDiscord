import { publicChannelState } from "@/server/public-channels";
import { PUBLIC_POST_NOTICE } from "@/lib/public-channels";
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
      await Promise.all(view.channels.map(async ({ id, name, topic, kind, categoryId }) => ({ id, name, topic, kind, categoryId, publicPosting: await publicChannelState(userId, id), publicPostNotice: PUBLIC_POST_NOTICE }))),
      { headers: PRIVATE_NO_STORE },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
