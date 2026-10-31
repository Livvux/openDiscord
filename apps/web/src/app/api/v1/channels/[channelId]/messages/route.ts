import { z } from "zod";
import { errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { requireBot } from "@/server/integrations";
import { listMessages, sendMessage } from "@/server/messages";
import { parse } from "@/server/validation";

/** Newest page (or `?before=`, `?after=`, `?around=`), oldest first; `?thread=` for a thread. Same permissions as members. */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/channels/[channelId]/messages">) {
  try {
    const { userId } = await requireBot(request.headers);
    const { channelId } = await ctx.params;
    const params = new URL(request.url).searchParams;
    const page = await listMessages(userId, channelId, params.get("before"), params.get("thread"), { after: params.get("after"), around: params.get("around") });
    return Response.json(page, { headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

const body = z.object({
  publicGeneration: z.uuid().nullish(),
  transactionId: z.uuid().nullish(),
  content: z.string(),
  replyToId: z.string().nullish(),
  threadId: z.string().nullish(),
});

/** Sends a message as the bot (rate limits, AutoMod and channel permissions apply). */
export async function POST(request: Request, ctx: RouteContext<"/api/v1/channels/[channelId]/messages">) {
  try {
    const { userId } = await requireBot(request.headers);
    const { channelId } = await ctx.params;
    const input = parse(body, await readJsonBody(request, 16 * 1024));
    const message = await sendMessage(userId, channelId, input.content, [], input.replyToId ?? null, input.threadId ?? null, input.publicGeneration, input.transactionId);
    return Response.json(message, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
