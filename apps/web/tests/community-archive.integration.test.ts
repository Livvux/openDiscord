import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attachment, community, communityAsset, session } from "@/db/schema";
import { configuredAttachmentStorage } from "@/server/attachment-storage";
import { exportCommunityArchive, importCommunityArchive } from "@/server/community-archive";
import { assetToken } from "@/lib/community-assets";
import { createCommunityAsset, listCommunityAssets, readCommunityAsset } from "@/server/community-assets";
import { exportCommunity, importCommunity } from "@/server/community-export";
import { createCommunity, getCommunityView } from "@/server/communities";
import { listMessages, sendMessage } from "@/server/messages";
import { mediaEnabled, readAttachment, uploadAttachment } from "@/server/media";
import { testUsers } from "./helpers";

const users = testUsers();
const actors: { id: string; sessionId: string }[] = [];
const storage = configuredAttachmentStorage();
afterAll(async () => {
  if (actors.length) {
    const ids = actors.map((actor) => actor.id);
    const rows = await db.select().from(attachment).where(inArray(attachment.uploaderId, ids));
    for (const row of rows) await storage?.remove(row.key);
    await db.delete(attachment).where(inArray(attachment.uploaderId, ids));
  }
  await users.cleanup();
});
async function actor(name: string) {
  const current = { id: await users.create(name), sessionId: randomUUID() };
  await db.insert(session).values({ id: current.sessionId, userId: current.id, token: randomUUID(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60_000) });
  actors.push(current);
  return current;
}
async function fixture() {
  const source = await actor("Portable owner");
  const target = await actor("New owner");
  const { communityId, channelId } = await createCommunity(source.id, "Portable home");
  const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: "#23684f" } }).png().toBuffer();
  const binary = Buffer.from([0, 255, 13, 10, 60, 62, 1]);
  const image = await uploadAttachment(source.id, channelId, "image/png", png.length, async () => png);
  const file = await uploadAttachment(source.id, channelId, "text/html", binary.length, async () => binary, "report%2520.html");
  await sendMessage(source.id, channelId, "Portable message", [image.id, file.id]);
  const stream = await exportCommunityArchive(source, communityId);
  const bytes = Buffer.from(await new Response(stream).arrayBuffer());
  return { source, target, communityId, bytes, binary };
}
const body = (bytes: Uint8Array) => new Response(Uint8Array.from(bytes)).body!;

describe.skipIf(!mediaEnabled)("complete private attachment archives", () => {
  it("preserves the entire library with fresh IDs, remaps tokens and gives JSON readable fallbacks", async () => {
    const source = await actor("Image owner");
    const target = await actor("Image importer");
    const { communityId, channelId } = await createCommunity(source.id, "Image library");
    const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: "#23684f" } }).png().toBuffer();
    const used = await createCommunityAsset(source.id, communityId, { name: "hello", kind: "emoji" }, png.length, async () => png, new AbortController().signal);
    await createCommunityAsset(source.id, communityId, { name: "unused", kind: "sticker" }, png.length, async () => png, new AbortController().signal);
    await sendMessage(source.id, channelId, `Welcome ${assetToken(used)}`);
    const json = await exportCommunity(source.id, communityId);
    expect(json.version).toBe(2);
    expect(json.assets).toHaveLength(2);
    expect(json.messages[0].content).toBe("Welcome :hello:");
    const importedJson = await importCommunity(target.id, json);
    expect(await listCommunityAssets(target.id, importedJson)).toEqual([]);
    const bytes = Buffer.from(await new Response(await exportCommunityArchive(source, communityId)).arrayBuffer());
    const imported = await importCommunityArchive(target, body(bytes));
    const library = await listCommunityAssets(target.id, imported);
    expect(library.map((a) => a.name).sort()).toEqual(["hello", "unused"]);
    const fresh = library.find((a) => a.name === "hello")!;
    expect(fresh.id).not.toBe(used.id);
    const view = await getCommunityView(target.id, imported);
    expect((await listMessages(target.id, view.channels[0].id)).messages[0].content).toBe(`Welcome ${assetToken(fresh)}`);
    expect((await readCommunityAsset(target.id, fresh.id)).ok).toBe(true);
    await expect(readCommunityAsset(source.id, fresh.id)).rejects.toThrow();
    const lines = gunzipSync(bytes).toString().trimEnd().split("\n").map((line) => JSON.parse(line));
    const file = lines.find((record) => record.type === "file");
    file.messageKey = "ambiguous";
    await expect(importCommunityArchive(source, body(gzipSync(lines.map((record) => JSON.stringify(record)).join("\n") + "\n")))).rejects.toThrow();
    expect(await db.select().from(communityAsset).where(eq(communityAsset.communityId, imported))).toHaveLength(2);
  });
  it("round trips real image and arbitrary binary bytes with private delivery", async () => {
    const { source, target, bytes, binary } = await fixture();
    const text = gunzipSync(bytes).toString();
    expect(text).not.toContain(source.id);
    expect(text).not.toContain("attachments/");
    const imported = await importCommunityArchive(target, body(bytes));
    const view = await getCommunityView(target.id, imported);
    const page = await listMessages(target.id, view.channels[0].id);
    expect(page.messages[0].content).toBe("Portable message");
    expect(page.messages[0].attachments).toHaveLength(2);
    const file = page.messages[0].attachments.find((item) => item.filename !== null)!;
    const image = page.messages[0].attachments.find((item) => item.filename === null)!;
    const response = await readAttachment(target.id, file.id);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(binary);
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(file.filename).toBe("report%20.html");
    expect([image.width, image.height]).toEqual([2, 3]);
    await expect(readAttachment(source.id, file.id)).rejects.toThrow();
  });
  it("reads legacy version-two archives with version-one JSON metadata", async () => {
    const { target, bytes } = await fixture();
    const records = gunzipSync(bytes).toString().trimEnd().split("\n").map((line) => JSON.parse(line));
    records[0].version = 2;
    records[0].data.version = 1;
    delete records[0].data.assets;
    const imported = await importCommunityArchive(target, body(gzipSync(records.map((record) => JSON.stringify(record)).join("\n") + "\n")));
    expect(await listCommunityAssets(target.id, imported)).toEqual([]);
    const view = await getCommunityView(target.id, imported);
    expect((await listMessages(target.id, view.channels[0].id)).messages[0].attachments).toHaveLength(2);
  });
  it("refuses a non-owner export", async () => {
    const { target, communityId } = await fixture();
    await expect(exportCommunityArchive(target, communityId)).rejects.toThrow();
  });
  it("does not create a community without a complete footer; staged files stay private", async () => {
    const { target, bytes } = await fixture();
    const lines = gunzipSync(bytes).toString().trimEnd().split("\n");
    lines.pop();
    await expect(importCommunityArchive(target, body(gzipSync(`${lines.join("\n")}\n`)))).rejects.toThrow("end marker");
    expect(await db.select().from(community).where(eq(community.ownerId, target.id))).toHaveLength(0);
    const rows = await db.select().from(attachment).where(eq(attachment.uploaderId, target.id));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.messageId).toBeNull(); expect(row.channelId).toBeNull();
      await expect(readAttachment(target.id, row.id)).rejects.toThrow();
    }
  });
  it("rejects corrupt file hashes and duplicate footers without a new community", async () => {
    for (const mutation of [
      (text: string) => text.replace(/"sha256":"[a-f0-9]{64}"/, `"sha256":"${"0".repeat(64)}"`),
      (text: string) => `${text}${text.trimEnd().split("\n").pop()}\n`,
    ]) {
      const { target, bytes } = await fixture();
      await expect(importCommunityArchive(target, body(gzipSync(mutation(gunzipSync(bytes).toString()))))).rejects.toThrow();
      expect(await db.select().from(community).where(eq(community.ownerId, target.id))).toHaveLength(0);
    }
  });
});
