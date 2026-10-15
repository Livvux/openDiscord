import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { consume } from "@/server/limits";
import { searchMembers } from "@/server/moderation";
import { requireUser } from "@/server/session";

/** Member names for mention autocomplete: `?q=<prefix>`. */
export async function GET(request: Request, ctx: RouteContext<"/api/communities/[communityId]/members">) {
  try {
    const user = await requireUser(request.headers);
    consume(`member-search:${user.id}`, 30, 10_000);
    const { communityId } = await ctx.params;
    const q = new URL(request.url).searchParams.get("q") ?? "";
    return Response.json(await searchMembers(user.id, communityId, q), { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
