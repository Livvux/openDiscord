import { expect, test } from "@playwright/test";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, openAccountMenu, signUp } from "./helpers";

test.describe("home, friends and account menu", () => {
  test("Home stays put, friends connect, and the account menu sets status", async ({ browser, isMobile }) => {
    test.skip(isMobile, "the invite helper drives the desktop sidebar");
    test.setTimeout(90_000);
    const owner = await newUserPage(browser);
    await signUp(owner, "Hana Home");
    await createCommunity(owner, "Hangout");
    const invitePath = await createInviteLink(owner);
    const friend = await joinAsNewUser(browser, "Finn Friend", invitePath);

    // /app is a persistent Home, not a redirect into the first community.
    await owner.goto("/app");
    await expect(owner).toHaveURL(/\/app$/);
    await expect(owner.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await expect(owner.getByRole("heading", { name: "Your communities" })).toBeVisible();
    await expect(owner.getByRole("link", { name: /Hangout/ }).last()).toBeVisible();
    await expectNoA11yViolations(owner);

    // Find a community member by name and send a request.
    await owner.goto("/app/friends");
    await owner.getByLabel("Search your communities").fill("Finn");
    await owner.getByRole("button", { name: "Search" }).click();
    await owner.getByRole("button", { name: "Add Finn Friend as a friend" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Friend request sent." })).toBeVisible();
    await expectNoA11yViolations(owner);

    // The recipient sees it on Home and accepts it from Friends.
    await friend.goto("/app");
    await expect(friend.getByRole("link", { name: /1 friend request from Hana Home/ })).toBeVisible();
    await friend.goto("/app/friends");
    await friend.getByRole("button", { name: "Accept friend request from Hana Home" }).click();
    await friend.getByRole("button", { name: "All", exact: false }).click();
    await expect(friend.getByRole("link", { name: "Message Hana Home" })).toBeVisible();

    // Status and custom status from the account menu; the friend sees them.
    await openAccountMenu(friend);
    await friend.getByLabel("Custom status").fill("Shipping features");
    await friend.getByLabel("Custom status").press("Enter");
    await friend.getByText("Do not disturb", { exact: true }).click();
    await expect(friend.getByRole("radio", { name: /Do not disturb/ })).toBeChecked();
    await expect(friend.getByRole("button", { name: /Account menu for Finn Friend, Do not disturb/ })).toBeVisible();
    await expectNoA11yViolations(friend);
    await friend.keyboard.press("Escape");

    await expect(async () => {
      await owner.goto("/app/friends");
      await expect(owner.getByRole("main").getByText("Shipping features")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    // Friends open encrypted DMs directly, without a message request.
    await owner.getByRole("main").getByRole("link", { name: "Message Finn Friend" }).click();
    await expect(owner).toHaveURL(/\/app\/messages\?to=/);
    await owner.getByRole("button", { name: "Send message request" }).click();
    await expect(owner.getByRole("log", { name: "Private conversation with Finn Friend" })).toBeVisible();
    await expect(owner.getByText("Your message request is waiting for acceptance.")).toHaveCount(0);

    // Sign out from the account menu.
    await openAccountMenu(owner);
    await owner.getByRole("button", { name: "Sign out" }).click();
    await expect(owner).toHaveURL(/\/sign-in$/);
  });

  test("a friend link prefills the code and the recipient can block the sender", async ({ browser }) => {
    const sender = await newUserPage(browser);
    await signUp(sender, "Sam Sender");
    const recipient = await newUserPage(browser);
    await signUp(recipient, "Rae Recipient");
    const code = (await recipient.request.get("/api/auth/get-session").then((r) => r.json())).user.id as string;

    await sender.goto(`/app/friends?add=${encodeURIComponent(code)}`);
    await expect(sender.getByLabel("Friend code")).toHaveValue(code);
    await sender.getByRole("button", { name: "Send request" }).click();
    await expect(sender.getByRole("status").filter({ hasText: "Friend request sent." })).toBeVisible();

    recipient.on("dialog", (dialog) => dialog.accept());
    await recipient.goto("/app/friends");
    await recipient.getByRole("button", { name: "Block Sam Sender" }).click();
    await expect(recipient.getByText("No pending requests.")).toBeVisible();

    await sender.reload();
    await sender.getByLabel("Friend code").fill(code);
    await sender.getByRole("button", { name: "Send request" }).click();
    await expect(sender.getByRole("alert").filter({ hasText: "No account found" })).toBeVisible();
  });
});
