import { removeCommunityImage, setCommunityImage } from "@/server/community-images";
import { assertSameOrigin, errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { readLimited } from "@/server/media";
import { requireUser } from "@/server/session";

/** Raw raster body; the server centre-crops it (square picture, 16:9 banner). */
export async function POST(request: Request, ctx: RouteContext<"/api/communities/[communityId]/images/[kind]">) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request.headers);
    const { communityId, kind } = await ctx.params;
    const image = await setCommunityImage(user.id, communityId, kind, Number(request.headers.get("content-length")), (limit) => readLimited(request.body, limit), request.signal);
    return Response.json({ image }, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/communities/[communityId]/images/[kind]">) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request.headers);
    const { communityId, kind } = await ctx.params;
    await removeCommunityImage(user.id, communityId, kind);
    return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
