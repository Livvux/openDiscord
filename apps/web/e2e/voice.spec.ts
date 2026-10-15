import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, signUp } from "./helpers";

const LIVEKIT_HTTP = (process.env.LIVEKIT_URL ?? "ws://localhost:7880").replace(/^ws/, "http");

test.describe("voice channels", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");
  test.beforeAll(async () => {
    const up = await fetch(LIVEKIT_HTTP).then((r) => r.ok, () => false);
    test.skip(!up, `LiveKit isn't running at ${LIVEKIT_HTTP}`);
  });

  test("two people talk; losing Connect removes someone from the call", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await owner.context().grantPermissions(["microphone"]);
    await signUp(owner, "Vera Voice");
    await createCommunity(owner, "Talk Club");
    // Headless Chromium's fake microphone hangs on the first capture made inside the app; open it once up front.
    await owner.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop())));
    const invitePath = await createInviteLink(owner);

    await owner.getByRole("button", { name: "Create channel" }).click();
    await owner.getByLabel("Channel name").fill("hangout");
    await owner.getByRole("radio", { name: /Voice/ }).check();
    await owner.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
    await expect(owner.getByRole("heading", { level: 2, name: "hangout" })).toBeVisible();
    const voiceUrl = owner.url();
    await owner.getByRole("button", { name: "Join voice" }).click();
    await expect(owner.getByText("You're connected.")).toBeVisible({ timeout: 15_000 });
    await expect(owner.getByRole("button", { name: "Mute", exact: true })).toBeVisible({ timeout: 20_000 });

    const member = await joinAsNewUser(browser, "Walt Wave", invitePath);
    await member.context().grantPermissions(["microphone"]);
    await member.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop())));
    await member.goto(voiceUrl);
    await expect(member.getByRole("list", { name: "People in hangout" }).getByText("Vera Voice")).toBeVisible();
    await member.getByRole("button", { name: "Join voice" }).click();
    await expect(member.getByText("You're connected.")).toBeVisible({ timeout: 15_000 });
    await expect(owner.getByRole("list", { name: "People in hangout" }).getByText("Walt Wave")).toBeVisible();
    await expectNoA11yViolations(member);

    // The call survives navigating to a text channel, with controls in the sidebar.
    await member.getByRole("link", { name: "general" }).click();
    await expect(member.getByRole("region", { name: "Voice connection" })).toContainText("Voice connected");
    await member.getByRole("button", { name: "Mute microphone" }).click();
    await expect(member.getByRole("button", { name: "Unmute microphone" })).toBeVisible();

    // The owner takes away Connect: the member is removed from the room.
    await owner.getByRole("button", { name: "Channel settings" }).click();
    await owner.getByRole("dialog").getByLabel("Connect for everyone").selectOption("deny");
    await expect(member.getByRole("alert").filter({ hasText: "disconnected from voice" })).toBeVisible({ timeout: 15_000 });
    await expect(member.getByRole("region", { name: "Voice connection" })).toHaveCount(0);
  });
});
