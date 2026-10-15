import { errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { postWebhookMessage } from "@/server/integrations";

const MAX_BODY_BYTES = 16 * 1024;

/** Incoming webhook: `POST {"content": "…"}`. Unknown, revoked and mismatched URLs all answer 404. */
export async function POST(request: Request, ctx: RouteContext<"/api/webhooks/[webhookId]/[token]">) {
  try {
    const { webhookId, token } = await ctx.params;
    const message = await postWebhookMessage(webhookId, token, await readJsonBody(request, MAX_BODY_BYTES));
    return Response.json({ id: message.id }, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
