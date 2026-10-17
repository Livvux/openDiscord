import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

test.describe("profile pictures", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");
  test.skip(!process.env.R2_ENDPOINT && !process.env.ATTACHMENT_DIR, "needs private attachment storage");

  test("a cropped picture is uploaded, shown to community members and removed", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Pia Picture");
    await createCommunity(owner, "Portraits");
    await sendMessage(owner, "hello with a face");
    const invitePath = await createInviteLink(owner);

    await owner.goto("/app/settings");
    const chooser = owner.waitForEvent("filechooser");
    await owner.getByRole("button", { name: "Upload picture" }).click();
    const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#f97316" } }).png().toBuffer();
    await (await chooser).setFiles({ name: "me.png", mimeType: "image/png", buffer: png });
    const dialog = owner.getByRole("dialog", { name: "Crop your picture" });
    await dialog.getByRole("application", { name: "Picture position" }).press("ArrowLeft");
    await dialog.getByLabel("Zoom").fill("2");
    await dialog.getByRole("button", { name: "Save picture" }).click();
    await expect(dialog).toBeHidden();
    await expect(owner.getByRole("button", { name: "Change picture" })).toBeVisible();

    const member = await joinAsNewUser(browser, "Max Member", invitePath);
    const picture = member.getByRole("log").locator('img[src*="/api/avatars/"]').first();
    await expect(picture).toBeVisible();
    expect(await picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(256);

    await owner.getByRole("button", { name: "Remove" }).click();
    await expect(owner.getByRole("button", { name: "Upload picture" })).toBeVisible();
  });
});
