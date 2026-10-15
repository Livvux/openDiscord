import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment } from "@/db/schema";
import { createCommunity } from "@/server/communities";
import { linkAttachments, sweepAttachments } from "@/server/media";
import { sendMessage } from "@/server/messages";
import { testUsers } from "./helpers";

describe.skipIf(!process.env.ATTACHMENT_DIR)("private sweep permanent claims", () => {
  const fixtures = testUsers();
  let owner: string; let channelId: string;
  beforeAll(async () => { owner = await fixtures.create("Sweep owner"); ({ channelId } = await createCommunity(owner, "Sweep claims")); });
  afterAll(async () => { await fixtures.cleanup(); await sweepAttachments(); });
  it("retains a failed object removal with a permanent claim and refuses later linking, then retries", async () => {
    const key = `attachments/${randomUUID()}.bin`;
    const path = join(process.env.ATTACHMENT_DIR!, key);
    // A directory at the object path makes unlink fail deterministically without storage mocks.
    await mkdir(path, { recursive: true });
    const [staged] = await db.insert(attachment).values({ uploaderId: owner, channelId, key, contentType: "application/octet-stream", filename: "claim.bin", size: 1, width: 0, height: 0, createdAt: new Date(0) }).returning();
    try {
      await sweepAttachments();
      const [claimed] = await db.select().from(attachment).where(eq(attachment.id, staged.id));
      expect(claimed.linkedAt).not.toBeNull(); expect(claimed.messageId).toBeNull(); expect(claimed.assetId).toBeNull();
      const message = await sendMessage(owner, channelId, "Cannot attach a claimed object");
      await expect(db.transaction((tx) => linkAttachments(tx, owner, channelId, message.id, [staged.id]))).rejects.toThrow(/no longer available/);
      await rm(path, { recursive: true });
      await sweepAttachments();
      expect(await db.select().from(attachment).where(eq(attachment.id, staged.id))).toEqual([]);
    } finally { await rm(path, { recursive: true, force: true }); await db.delete(attachment).where(eq(attachment.id, staged.id)); }
  });
});
