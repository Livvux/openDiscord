import { assertSameOrigin, errorResponse, PRIVATE_NO_STORE, readJsonBody } from "@/server/http";
import { deletePushSubscription, savePushSubscription } from "@/server/push";
import { requireUser } from "@/server/session";

/** Stores this browser's push subscription (`PushSubscription.toJSON()`). */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request.headers);
    await savePushSubscription(user.id, await readJsonBody(request, 4096));
    return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Forgets this browser's subscription: `{"endpoint": "…"}`. */
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request.headers);
    const body = (await readJsonBody(request, 4096)) as { endpoint?: unknown } | null;
    await deletePushSubscription(user.id, body?.endpoint);
    return new Response(null, { status: 204, headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
