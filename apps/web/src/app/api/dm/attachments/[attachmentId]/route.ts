import { readDmAttachment } from "@/server/dm-attachments";
import { errorResponse } from "@/server/http";
import { consume } from "@/server/limits";
import { requireUser } from "@/server/session";

/** Serves encrypted DM ciphertext to conversation members; the browser verifies and decrypts it. */
export async function GET(request: Request, ctx: RouteContext<"/api/dm/attachments/[attachmentId]">) {
  try {
    const user = await requireUser(request.headers);
    await consume(`dm-attachment-read:${user.id}`, 120, 60_000);
    return await readDmAttachment(user.id, (await ctx.params).attachmentId);
  } catch (error) {
    return errorResponse(error);
  }
}
