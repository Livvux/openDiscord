import { errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { postWebhookMessage } from "@/server/integrations";

const MAX_BODY_BYTES = 16 * 1024;

/** Incoming webhook: `POST {"content": "…"}`. Unknown, revoked and mismatched URLs all answer 404. */
export async function POST(request: Request, ctx: RouteContext<"/api/webhooks/[webhookId]/[token]">) {
  try {
    const { webhookId, token } = await ctx.params;
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return Response.json({ error: "Body too large." }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "Send a JSON body." }, { status: 400 });
    }
    const message = await postWebhookMessage(webhookId, token, body);
    return Response.json({ id: message.id }, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
