import { after } from "next/server";
import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { readLimited, sweepAttachments, uploadAttachment } from "@/server/media";
import { requireUser } from "@/server/session";

/** Image upload: the raw file is the body. Returns an id to pass when sending the message. */
export async function POST(request: Request, ctx: RouteContext<"/api/channels/[channelId]/attachments">) {
  try {
    const user = await requireUser(request.headers);
    const { channelId } = await ctx.params;
    const length = Number(request.headers.get("content-length"));
    const view = await uploadAttachment(user.id, channelId, request.headers.get("content-type"), length, (limit) => readLimited(request.body, limit));
    after(() => sweepAttachments().catch((error: unknown) => console.error("[media] sweep failed", error)));
    return Response.json(view, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
