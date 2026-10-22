import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, signUp } from "./helpers";

test.describe("attachments", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");
  test.skip(!process.env.R2_ENDPOINT && !process.env.ATTACHMENT_DIR, "needs private attachment storage");

  test("files are sent and downloaded; images are shown inline", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Fia Files");
    await createCommunity(owner, "Shared Drive");
    const invitePath = await createInviteLink(owner);
    const member = await joinAsNewUser(browser, "Gus Getter", invitePath);

    const chooser = owner.waitForEvent("filechooser");
    await owner.getByRole("button", { name: /Attach files/ }).click();
    await (await chooser).setFiles([
      { name: "notes.html", mimeType: "text/html", buffer: Buffer.from("<script>alert(1)</script>") },
      // 1×1 PNG.
      { name: "dot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") },
    ]);
    await expect(owner.getByRole("list", { name: "Attachments" }).getByRole("status")).toHaveCount(0, { timeout: 15_000 });
    await owner.getByRole("button", { name: "Send message" }).click();

    const files = member.getByRole("log").getByRole("list", { name: "Files" });
    await expect(files.getByRole("link", { name: /notes\.html/ })).toBeVisible();
    await expect(member.getByRole("log").getByRole("img", { name: "Image 1 from Fia Files" })).toBeVisible();
    const download = member.waitForEvent("download");
    await files.getByRole("link", { name: /notes\.html/ }).click();
    expect((await download).suggestedFilename()).toBe("notes.html");
  });

  test("a file larger than the proxy body buffer is stored byte for byte", async ({ browser }, info) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Big File Owner");
    await createCommunity(owner, "Large Files");
    // Above Next's 10 MB proxy request-body buffer, below the 25 MB file limit.
    const bytes = randomBytes(15 * 1024 * 1024);
    const path = info.outputPath("large.bin");
    writeFileSync(path, bytes);
    const chooser = owner.waitForEvent("filechooser");
    await owner.getByRole("button", { name: /Attach files/ }).click();
    await (await chooser).setFiles(path);
    await expect(owner.getByRole("list", { name: "Attachments" }).getByRole("status")).toHaveCount(0, { timeout: 60_000 });
    await owner.getByRole("button", { name: "Send message" }).click();
    const link = owner.getByRole("log").getByRole("link", { name: /large\.bin/ });
    await expect(link).toBeVisible();
    const response = await owner.request.get((await link.getAttribute("href"))!);
    expect(response.status()).toBe(200);
    const body = await response.body();
    expect(body.length).toBe(bytes.length);
    expect(createHash("sha256").update(body).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
