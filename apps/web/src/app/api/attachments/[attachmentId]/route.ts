import { errorResponse } from "@/server/http";
import { readAttachment } from "@/server/media";
import { requireUser } from "@/server/session";

/** Serves an image only to members of the channel it was posted in. */
export async function GET(request: Request, ctx: RouteContext<"/api/attachments/[attachmentId]">) {
  try {
    const user = await requireUser(request.headers);
    return await readAttachment(user.id, (await ctx.params).attachmentId);
  } catch (error) {
    return errorResponse(error);
  }
}
