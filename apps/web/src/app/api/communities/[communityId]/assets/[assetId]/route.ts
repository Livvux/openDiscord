import { deleteCommunityAsset } from "@/server/community-assets";
import { assertSameOrigin, errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { requireUser } from "@/server/session";

export async function DELETE(request: Request, ctx: RouteContext<"/api/communities/[communityId]/assets/[assetId]">) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request.headers);
    const { communityId, assetId } = await ctx.params;
    await deleteCommunityAsset(user.id, communityId, assetId);
    return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
