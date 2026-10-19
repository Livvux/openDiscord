import { after } from "next/server";
import { uploadDmAttachment } from "@/server/dm-attachments";
import { assertSameOrigin, errorResponse, PRIVATE_NO_STORE } from "@/server/http";
import { readLimited, sweepAttachments } from "@/server/media";
import { requireUser } from "@/server/session";

/** Upload: the body is client-side encrypted ciphertext (`?conversation=`). Returns an opaque id for sending. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request.headers);
    const conversation = new URL(request.url).searchParams.get("conversation");
    const view = await uploadDmAttachment(user.id, conversation, Number(request.headers.get("content-length")), (limit) => readLimited(request.body, limit));
    after(() => sweepAttachments().catch((error: unknown) => console.error("[media] sweep failed", error)));
    return Response.json(view, { status: 201, headers: PRIVATE_NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
