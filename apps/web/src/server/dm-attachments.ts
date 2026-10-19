import { assertCanSendDirect, directAttachmentFor } from "./direct-messages";
import { notFound } from "./errors";
import { requireStorage, uploadDmCiphertext, type AttachmentView } from "./media";
import { parse, uuid } from "./validation";

/** Ciphertext from a member who may post here; the server never sees the file's name, type or key. */
export async function uploadDmAttachment(actor: string, conversationId: unknown, contentLength: number, body: (limit: number) => Promise<Uint8Array>): Promise<Pick<AttachmentView, "id" | "size">> {
  await assertCanSendDirect(actor, parse(uuid, conversationId));
  const { id, size } = await uploadDmCiphertext(actor, contentLength, body);
  return { id, size };
}

/** Streams sent ciphertext to members of its conversation. Everyone else gets "not found". */
export async function readDmAttachment(actor: string, id: unknown): Promise<Response> {
  const storage = requireStorage();
  const { key } = await directAttachmentFor(actor, parse(uuid, id));
  const res = await storage.read(key);
  if (!res.ok || !res.body) {
    console.error("[dm] attachment read failed", res.status);
    throw notFound("Attachment not found.");
  }
  return new Response(res.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      ...(res.headers.has("Content-Length") && { "Content-Length": res.headers.get("Content-Length")! }),
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="encrypted.bin"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
