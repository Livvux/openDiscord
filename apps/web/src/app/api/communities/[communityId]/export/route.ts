import { exportCommunity } from "@/server/community-export";
import { errorResponse } from "@/server/http";
import { requireUser } from "@/server/session";

/** Owner-only JSON export for moving the community to another instance. */
export async function GET(request: Request, ctx: RouteContext<"/api/communities/[communityId]/export">) {
  try {
    const user = await requireUser(request.headers);
    const { communityId } = await ctx.params;
    const data = await exportCommunity(user.id, communityId);
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="opendiscord-community-${communityId}.json"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
