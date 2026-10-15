import { createCommunityAsset, listCommunityAssets } from "@/server/community-assets";
import { assertSameOrigin, errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { readLimited } from "@/server/media";
import { requireUser } from "@/server/session";

export async function GET(request: Request, ctx: RouteContext<"/api/communities/[communityId]/assets">) {
  try {
    const user = await requireUser(request.headers);
    return Response.json(await listCommunityAssets(user.id, (await ctx.params).communityId), { headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}

/** Raw raster body; immutable name/kind are supplied as bounded query parameters. */
export async function POST(request: Request, ctx: RouteContext<"/api/communities/[communityId]/assets">) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request.headers);
    const params = new URL(request.url).searchParams;
    const asset = await createCommunityAsset(user.id, (await ctx.params).communityId,
      { name: params.get("name"), kind: params.get("kind") }, Number(request.headers.get("content-length")),
      (limit) => readLimited(request.body, limit), request.signal);
    return Response.json(asset, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) { return errorResponse(error); }
}
