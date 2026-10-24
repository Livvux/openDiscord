import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, signUp } from "./helpers";

async function befriend(owner: Page, friend: Page, friendName: string) {
  await owner.goto("/app");
  await owner.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: "Add Friend" }).click();
  await owner.getByLabel("Search your communities").fill(friendName);
  await owner.getByRole("button", { name: "Search" }).click();
  await owner.getByRole("button", { name: `Add friend: ${friendName}` }).click();
  await friend.goto("/app");
  await friend.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^Pending/ }).click();
  await friend.getByRole("button", { name: /^Accept friend request from / }).click();
}

test("encrypted image and file attachments: ciphertext on the wire, decrypted inline and as a download", async ({ browser, isMobile }) => {
  test.skip(isMobile, "the invite helper drives the desktop sidebar");
  test.skip(!process.env.R2_ENDPOINT && !process.env.ATTACHMENT_DIR, "needs private attachment storage");
  test.setTimeout(180_000);
  const owner = await newUserPage(browser);
  await signUp(owner, "Ada Attach");
  await createCommunity(owner, "Attachment Lab");
  const friend = await joinAsNewUser(browser, "Finn Files", await createInviteLink(owner));
  const uploads: Buffer[] = [];
  owner.on("request", (request) => { if (new URL(request.url()).pathname === "/api/dm/attachments") uploads.push(request.postDataBuffer() ?? Buffer.alloc(0)); });
  const sends: string[] = [];
  owner.on("request", (request) => { if (new URL(request.url()).pathname === "/api/dm" && request.method() === "POST") sends.push(request.postData() ?? ""); });
  try {
    await befriend(owner, friend, "Finn Files");
    await owner.goto("/app");
    await owner.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^All/ }).click();
    await owner.getByRole("main").getByRole("link", { name: "Message Finn Files" }).click();
    await expect(owner.getByLabel("Encrypted message")).toBeEnabled({ timeout: 30_000 });

    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#22c55e" } }).png().toBuffer();
    const secret = Buffer.from("Quarterly secret ledger 4471\n");
    await owner.locator('input[type="file"]').setInputFiles([
      { name: "green-pixel-art.png", mimeType: "image/png", buffer: png },
      { name: "ledger-4471.txt", mimeType: "text/plain", buffer: secret },
    ]);
    await expect(owner.getByRole("list", { name: "Encrypted attachments" }).getByRole("listitem")).toHaveCount(2);
    await owner.getByLabel("Encrypted message").fill("Files for you");
    await owner.getByRole("button", { name: "Send encrypted message" }).click();
    await expect(owner.getByRole("log").getByText("Files for you")).toBeVisible({ timeout: 30_000 });

    // Only ciphertext left the browser: neither bytes nor names nor types.
    expect(uploads).toHaveLength(2);
    for (const body of uploads) {
      expect(body.includes(secret)).toBe(false);
      expect(body.includes(png.subarray(0, 16))).toBe(false);
    }
    const wire = sends.join("\n");
    for (const leak of ["ledger-4471.txt", "green-pixel-art.png", "image/png", "text/plain"]) expect(wire).not.toContain(leak);

    await friend.goto("/app/messages");
    await friend.getByRole("navigation", { name: "Home" }).getByRole("link").filter({ hasText: "Ada Attach" }).click();
    const log = friend.getByRole("log", { name: "Private conversation with Ada Attach" });
    await expect(log.getByText("Files for you")).toBeVisible({ timeout: 30_000 });
    const image = log.getByRole("img", { name: "green-pixel-art.png" });
    await expect(image).toBeVisible({ timeout: 30_000 });
    await expect(image).toHaveAttribute("src", /^blob:/);
    expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(40);

    const download = friend.waitForEvent("download");
    await log.getByRole("button", { name: "Download encrypted file ledger-4471.txt" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("ledger-4471.txt");
    expect((await readFile((await file.path())!)).equals(secret)).toBe(true);

    // The server copy is opaque to everyone, including the recipient's direct request.
    const conversations = (await friend.request.get("/api/dm").then((r) => r.json())).conversations as { id: string }[];
    const timeline = await friend.request.get(`/api/dm?conversation=${conversations[0].id}`).then((r) => r.text());
    expect(timeline).not.toContain("ledger-4471.txt");
  } finally {
    await Promise.all([owner.context().close(), friend.context().close()]);
  }
});
