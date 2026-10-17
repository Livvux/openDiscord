import { readAvatar } from "@/server/avatars";
import { errorResponse } from "@/server/http";
import { requireUser } from "@/server/session";

export async function GET(request: Request, ctx: RouteContext<"/api/avatars/[avatarId]">) {
  try {
    const user = await requireUser(request.headers);
    return await readAvatar(user.id, (await ctx.params).avatarId);
  } catch (error) { return errorResponse(error); }
}
