import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, signUp } from "./helpers";

test.describe("attachments", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");
  test.skip(!process.env.R2_ENDPOINT, "needs S3-compatible storage (R2_* settings)");

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
});
