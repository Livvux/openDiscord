import { readCommunityImage } from "@/server/community-images";
import { AppError } from "@/server/errors";
import { errorResponse } from "@/server/http";
import { AccountBlocked } from "@/server/instance-policy";
import { requireUser } from "@/server/session";

/** Signed out works too: pictures of listed communities appear in link previews. */
export async function GET(request: Request, ctx: RouteContext<"/api/community-images/[imageId]">) {
  try {
    const user = await requireUser(request.headers).catch((error: unknown) => {
      if ((error instanceof AppError && error.code === "unauthorized") || error instanceof AccountBlocked) return null;
      throw error;
    });
    return await readCommunityImage(user?.id ?? null, (await ctx.params).imageId);
  } catch (error) { return errorResponse(error); }
}
