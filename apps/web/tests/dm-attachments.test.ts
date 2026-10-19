import { randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { describe, expect, it } from "vitest";
import { dmAttachmentSchema, plainMessageSchema } from "@/lib/dm/contracts";

const base = { msgtype: "m.text", conversation: randomUUID(), transaction: randomUUID() } as const;
function encrypted(bytes: Uint8Array) {
  const attachment = C.Attachment.encrypt(bytes);
  const info = attachment.mediaEncryptionInfo!;
  const ciphertext = attachment.encryptedData;
  attachment.free();
  return { info, ciphertext };
}

describe("end-to-end encrypted DM attachments", () => {
  it("carries name, type, size and the SDK key/iv/hash only inside the encrypted payload", async () => {
    await C.initAsync();
    const { info } = encrypted(new TextEncoder().encode("hello"));
    const file = { id: randomUUID(), info, name: "notes.txt", mime: "text/plain", size: 5 };
    expect(plainMessageSchema.parse({ ...base, body: "", attachments: [file] }).attachments).toEqual([file]);
    expect(plainMessageSchema.parse({ ...base, body: "caption", attachments: [file] }).body).toBe("caption");
    // Text-only messages keep their previous shape.
    expect(plainMessageSchema.parse({ ...base, body: "text only" })).toEqual({ ...base, body: "text only" });
    expect(() => plainMessageSchema.parse({ ...base, body: "  " })).toThrow();
    expect(() => plainMessageSchema.parse({ ...base, body: "", attachments: [] })).toThrow();
    expect(() => plainMessageSchema.parse({ ...base, body: "", attachments: Array.from({ length: 5 }, () => file) })).toThrow();
    expect(() => plainMessageSchema.parse({ ...base, body: "", attachments: [{ ...file, size: 25 * 1024 * 1024 + 1 }] })).toThrow();
  });

  it("refuses encryption information without a SHA-256 integrity hash", async () => {
    await C.initAsync();
    const { info } = encrypted(new Uint8Array([1, 2, 3]));
    const parsed = JSON.parse(info) as { hashes: Record<string, string> };
    expect(parsed.hashes.sha256).toBeTruthy();
    const file = { id: randomUUID(), name: "a.bin", mime: "application/octet-stream", size: 3 };
    expect(dmAttachmentSchema.parse({ ...file, info }).info).toBe(info);
    expect(() => dmAttachmentSchema.parse({ ...file, info: JSON.stringify({ ...parsed, hashes: {} }) })).toThrow();
    expect(() => dmAttachmentSchema.parse({ ...file, info: "not json" })).toThrow();
  });

  it("decrypts only the exact ciphertext the sender hashed", async () => {
    await C.initAsync();
    const plain = new Uint8Array(4096).map((_, i) => i % 251);
    const { info, ciphertext } = encrypted(plain);
    expect(Buffer.from(ciphertext).equals(Buffer.from(plain))).toBe(false);
    expect(C.Attachment.decrypt(new C.EncryptedAttachment(ciphertext, info))).toEqual(plain);
    const altered = ciphertext.slice(); altered[10] ^= 1;
    expect(() => C.Attachment.decrypt(new C.EncryptedAttachment(altered, info))).toThrow();
    expect(() => C.Attachment.decrypt(new C.EncryptedAttachment(ciphertext.slice(0, -1), info))).toThrow();
  });
});
