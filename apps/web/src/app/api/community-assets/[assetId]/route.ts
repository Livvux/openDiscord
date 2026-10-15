import { readCommunityAsset } from "@/server/community-assets";
import { errorResponse } from "@/server/http";
import { requireUser } from "@/server/session";

export async function GET(request: Request, ctx: RouteContext<"/api/community-assets/[assetId]">) {
  try {
    const user = await requireUser(request.headers);
    return await readCommunityAsset(user.id, (await ctx.params).assetId);
  } catch (error) { return errorResponse(error); }
}
