import { expect, test, type Page } from "@playwright/test";
import {
  createCommunity,
  createInviteLink,
  joinAsNewUser,
  newUserPage,
  sendMessage,
  signUp,
  waitForLive,
} from "./helpers";

function messageRow(page: Page, text: string) {
  // A reply preview can repeat the original text; the original message is first.
  return page.getByRole("log", { name: /Messages in/ }).getByRole("listitem").filter({ hasText: text }).first();
}

async function openMessageMenu(page: Page, text: string) {
  await messageRow(page, text).getByText(text).last().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Message actions", exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

function friendRow(page: Page, name: string) {
  return page.getByRole("region", { name: "Your friends" }).getByRole("listitem").filter({ hasText: name });
}

test.describe("context menus", () => {
  test.skip(({ isMobile }) => isMobile, "desktop pointer and keyboard flows");
  test.describe.configure({ timeout: 120_000 });

  test("message menus preserve permissions, keyboard focus, and existing conversation actions", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Casey Moderator");
    await createCommunity(owner, "Context Lab");
    const member = await joinAsNewUser(browser, "Robin Member", await createInviteLink(owner));

    try {
      await waitForLive(owner);
      const referenceText = "A reference for message menu actions";
      const draftText = "A member draft to edit from the menu";
      const editedText = "The member edited this through the menu";
      await sendMessage(owner, referenceText);
      await sendMessage(member, draftText);
      const reference = messageRow(member, referenceText);

      // Keyboard opening, arrow navigation, and Escape must work on the message itself.
      await reference.focus();
      await member.keyboard.press("Shift+F10");
      const menu = member.getByRole("menu", { name: "Message actions", exact: true });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Edit message", exact: true })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: "Delete message", exact: true })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: "Pin message", exact: true })).toHaveCount(0);
      await member.screenshot({ path: test.info().outputPath("message-context-menu.png") });
      await member.keyboard.press("Home");
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      await member.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
      await member.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(reference).toBeFocused();

      await openMessageMenu(member, referenceText);
      await menu.getByRole("menuitem", { name: "Reply", exact: true }).focus();
      await member.keyboard.press("Enter");
      await expect(member.getByText("Replying to Casey Moderator")).toBeVisible();
      await sendMessage(member, "A reply selected from the context menu");
      await expect(messageRow(owner, "A reply selected from the context menu").getByRole("button", { name: /Reply to Casey Moderator/ })).toBeVisible();

      // Actions that open another overlay must survive the menu closing.
      await openMessageMenu(member, referenceText);
      await menu.getByRole("menuitem", { name: "Add reaction", exact: true }).click();
      const picker = member.getByRole("dialog", { name: "Add a reaction", exact: true });
      await expect(picker).toBeVisible();
      await picker.getByRole("button", { name: /party popper/i }).click();
      await expect(messageRow(owner, referenceText).getByRole("button", { name: "🎉 1 reaction", exact: true })).toBeVisible();

      await openMessageMenu(member, referenceText);
      await menu.getByRole("menuitem", { name: "Start a thread", exact: true }).click();
      const thread = member.getByRole("complementary", { name: "Thread by Casey Moderator" });
      await expect(thread.getByText(referenceText, { exact: true })).toBeVisible();
      await thread.getByRole("textbox", { name: "Reply in thread" }).fill("A thread started from the context menu");
      await thread.getByRole("textbox", { name: "Reply in thread" }).press("Enter");
      await expect(thread.getByRole("log", { name: "Thread replies" }).getByText("A thread started from the context menu")).toBeVisible();
      await member.keyboard.press("Escape");
      await expect(thread).toBeHidden();
      await openMessageMenu(member, referenceText);
      await expect(menu.getByRole("menuitem", { name: "Start a thread", exact: true })).toHaveCount(0);
      await menu.getByRole("menuitem", { name: "Open thread", exact: true }).click();
      await expect(thread.getByText("A thread started from the context menu")).toBeVisible();
      await member.keyboard.press("Escape");

      await openMessageMenu(member, referenceText);
      await menu.getByRole("menuitem", { name: "Report message", exact: true }).click();
      const report = member.getByRole("dialog", { name: "Report message", exact: true });
      const reportReason = report.getByRole("textbox", { name: "Why are you reporting this message?" });
      await reportReason.fill("A draft reason that should keep its editing menu");
      await reportReason.click({ button: "right" });
      await expect(member.getByRole("menu", { name: "Message actions", exact: true, includeHidden: true })).toHaveCount(0);
      await expect(reportReason).toHaveValue("A draft reason that should keep its editing menu");
      await member.keyboard.press("Escape");
      await expect(report).toBeHidden();

      await member.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await openMessageMenu(member, referenceText);
      await menu.getByRole("menuitem", { name: "Copy text", exact: true }).click();
      await expect.poll(() => member.evaluate(() => navigator.clipboard.readText())).toBe(referenceText);

      // An ordinary member may edit/delete their own message, but cannot pin it.
      await openMessageMenu(member, draftText);
      await expect(menu.getByRole("menuitem", { name: "Delete message", exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Pin message", exact: true })).toHaveCount(0);
      await menu.getByRole("menuitem", { name: "Edit message", exact: true }).click();
      const editor = member.getByRole("textbox", { name: "Edit message", exact: true });
      await editor.fill(editedText);
      await editor.press("Enter");
      await expect(editor).toBeHidden();
      await expect(messageRow(owner, editedText)).toBeVisible();

      await openMessageMenu(member, editedText);
      member.once("dialog", (dialog) => dialog.dismiss());
      await menu.getByRole("menuitem", { name: "Delete message", exact: true }).click();
      await member.reload();
      await expect(messageRow(member, editedText)).toBeVisible();
      await waitForLive(member);

      // Moderators may delete/pin another author's message, but may not edit it.
      const moderatorMenu = await openMessageMenu(owner, editedText);
      await expect(moderatorMenu.getByRole("menuitem", { name: "Edit message", exact: true })).toHaveCount(0);
      await expect(moderatorMenu.getByRole("menuitem", { name: "Delete message", exact: true })).toBeVisible();
      await moderatorMenu.getByRole("menuitem", { name: "Pin message", exact: true }).click();
      await expect(messageRow(member, editedText).getByText("Pinned", { exact: true })).toBeVisible();
    } finally {
      await Promise.all([owner.context().close(), member.context().close()]);
    }
  });

  test("server menus respect ownership and persist personal notification changes", async ({ browser }) => {
    const owner = await newUserPage(browser);
    const communityName = "Menu Garden";
    await signUp(owner, "Sage Owner");
    await createCommunity(owner, communityName);
    const member = await joinAsNewUser(browser, "River Visitor", await createInviteLink(owner));

    try {
      const channelUrl = member.url();
      const ownerRail = owner.getByRole("navigation", { name: "Communities" }).getByRole("link", { name: new RegExp(`^${communityName}`) });
      const memberRail = member.getByRole("navigation", { name: "Communities" }).getByRole("link", { name: new RegExp(`^${communityName}`) });
      const ownerMenu = owner.getByRole("menu", { name: `${communityName} server actions`, exact: true });
      const memberMenu = member.getByRole("menu", { name: `${communityName} server actions`, exact: true });

      // The heading and community rail expose the same permission-aware actions.
      await owner.getByRole("heading", { name: communityName, exact: true }).click({ button: "right" });
      await expect(ownerMenu.getByRole("menuitem", { name: "Community settings", exact: true })).toBeVisible();
      await expect(ownerMenu.getByRole("menuitem", { name: "Invite people", exact: true })).toBeVisible();
      await expect(ownerMenu.getByRole("menuitem", { name: "Leave community", exact: true })).toHaveCount(0);
      await owner.screenshot({ path: test.info().outputPath("server-context-menu.png") });
      await owner.keyboard.press("Escape");

      // Portalled text fields must not reopen the server menu of their trigger.
      await owner.getByRole("button", { name: "Search messages", exact: true }).click();
      const search = owner.getByRole("dialog", { name: `Search ${communityName}`, exact: true });
      const searchInput = search.getByRole("searchbox", { name: "Search messages", exact: true });
      await searchInput.click({ button: "right" });
      await expect(owner.getByRole("menu", { name: `${communityName} server actions`, exact: true, includeHidden: true })).toHaveCount(0);
      await expect(searchInput).toBeFocused();
      await search.getByRole("button", { name: "Close", exact: true }).click();

      await memberRail.focus();
      await member.keyboard.press("Shift+F10");
      await expect(memberMenu.getByRole("menuitem", { name: "Community info", exact: true })).toBeVisible();
      await expect(memberMenu.getByRole("menuitem", { name: "Community settings", exact: true })).toHaveCount(0);
      // The default member role includes permission to create invites.
      await memberMenu.getByRole("menuitem", { name: "Invite people", exact: true }).click();
      const invite = member.getByRole("dialog", { name: `Invite people to ${communityName}`, exact: true });
      await expect(invite.getByRole("button", { name: "Create invite link", exact: true })).toBeVisible();
      await member.keyboard.press("Escape");
      await expect(invite).toBeHidden();
      await expect(memberRail).toBeFocused();

      await memberRail.click({ button: "right" });
      await memberMenu.getByRole("menuitem", { name: "Notifications", exact: true }).hover();
      await member.getByRole("menuitemradio", { name: "Muted", exact: true }).click();
      await expect(memberRail).toHaveAccessibleName(/, muted/);
      await member.reload();
      await expect(memberRail).toHaveAccessibleName(/, muted/);
      await expect(ownerRail).not.toHaveAccessibleName(/muted/);

      // Read the setting on a fresh page to prove this survived the menu instance.
      await memberRail.click({ button: "right" });
      await memberMenu.getByRole("menuitem", { name: "Community info", exact: true }).click();
      await expect(member).toHaveURL(/\/settings$/);
      await expect(member.getByRole("radio", { name: /^Muted/ })).toBeChecked();
      await member.goto(channelUrl);

      await memberRail.click({ button: "right" });
      await memberMenu.getByRole("menuitem", { name: "Leave community", exact: true }).click();
      const leave = member.getByRole("dialog", { name: `Leave ${communityName}?`, exact: true });
      await expect(leave).toBeVisible();
      await leave.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(leave).toBeHidden();
      await member.reload();
      await sendMessage(member, "I can still send after canceling leave");
      await expect(messageRow(owner, "I can still send after canceling leave")).toBeVisible();

      await memberRail.click({ button: "right" });
      await memberMenu.getByRole("menuitem", { name: "Leave community", exact: true }).click();
      await leave.getByRole("button", { name: "Leave community", exact: true }).click();
      await expect(member).toHaveURL(/\/app$/);
      await expect(memberRail).toHaveCount(0);
    } finally {
      await Promise.all([owner.context().close(), member.context().close()]);
    }
  });

  test("nested author and friend menus keep relationship and block actions on the selected person", async ({ browser }) => {
    const owner = await newUserPage(browser);
    await signUp(owner, "Alex Author");
    await createCommunity(owner, "People Menus");
    const member = await joinAsNewUser(browser, "Blair Friend", await createInviteLink(owner));

    try {
      const channelUrl = owner.url();
      await waitForLive(owner);
      await sendMessage(owner, "Right-click this author's name");
      await sendMessage(member, "A friend's message to hide after blocking");

      await member.getByRole("complementary", { name: "Members", exact: true }).getByText("Alex Author", { exact: true }).click({ button: "right" });
      const memberListMenu = member.getByRole("menu", { name: "User actions", exact: true });
      await expect(memberListMenu).toBeVisible();
      await expect(memberListMenu.getByRole("menuitem", { name: "Message", exact: true })).toBeVisible();
      await expect(memberListMenu.getByRole("menuitem", { name: "Copy User ID", exact: true })).toBeVisible();
      await member.keyboard.press("Escape");
      await expect(memberListMenu).toBeHidden();

      const author = messageRow(member, "Right-click this author's name").getByRole("button", { name: "Actions for Alex Author", exact: true }).last();
      await author.click({ button: "right" });
      const memberMenu = member.getByRole("menu", { name: "User actions", exact: true });
      await expect(memberMenu).toBeVisible();
      await expect(member.getByRole("menu")).toHaveCount(1);
      await expect(member.getByRole("menu", { name: "Message actions", exact: true })).toHaveCount(0);
      await expect(memberMenu.getByRole("menuitem", { name: "Message", exact: true })).toBeVisible();
      await expect(memberMenu.getByRole("menuitem", { name: "Copy User ID", exact: true })).toBeVisible();
      await member.screenshot({ path: test.info().outputPath("user-context-menu.png") });
      await member.keyboard.press("Escape");
      await expect(author).toBeFocused();

      // A name menu opens the existing friend-code flow for the selected author.
      await author.click({ button: "right" });
      await memberMenu.getByRole("menuitem", { name: "Add Friend", exact: true }).click();
      await expect(member).toHaveURL(/\/app\/friends\?add=/);
      const friendCode = new URL(member.url()).searchParams.get("add");
      expect(friendCode).toBeTruthy();
      await expect(member.getByLabel("Friend code")).toHaveValue(friendCode!);
      await member.getByRole("button", { name: "Send request", exact: true }).click();
      await expect(member.getByRole("status").filter({ hasText: "Friend request sent." })).toBeVisible();
      await member.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^Pending/ }).click();
      await friendRow(member, "Alex Author").getByText("Alex Author", { exact: true }).click({ button: "right" });
      await expect(memberMenu.getByRole("menuitem", { name: "Cancel Friend Request", exact: true })).toBeVisible();
      await expect(memberMenu.getByRole("menuitem", { name: "Accept Friend Request", exact: true })).toHaveCount(0);
      await member.keyboard.press("Escape");

      await owner.goto("/app/friends");
      await friendRow(owner, "Blair Friend").getByText("Blair Friend", { exact: true }).click({ button: "right" });
      const ownerMenu = owner.getByRole("menu", { name: "User actions", exact: true });
      await expect(ownerMenu.getByRole("menuitem", { name: "Decline Friend Request", exact: true })).toBeVisible();
      await expect(ownerMenu.getByRole("menuitem", { name: "Cancel Friend Request", exact: true })).toHaveCount(0);
      await ownerMenu.getByRole("menuitem", { name: "Accept Friend Request", exact: true }).click();
      await owner.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^All/ }).click();
      const friend = friendRow(owner, "Blair Friend");
      await expect(friend.getByRole("link", { name: "Message Blair Friend", exact: true })).toBeVisible();

      await friend.getByText("Blair Friend", { exact: true }).click({ button: "right" });
      await expect(ownerMenu.getByRole("menuitem", { name: "Remove Friend", exact: true })).toBeVisible();
      await expect(ownerMenu.getByRole("menuitem", { name: "Add Friend", exact: true })).toHaveCount(0);
      owner.once("dialog", (dialog) => dialog.dismiss());
      await ownerMenu.getByRole("menuitem", { name: "Block", exact: true }).click();
      await owner.reload();
      await expect(friend.getByRole("link", { name: "Message Blair Friend", exact: true })).toBeVisible();

      await friend.getByText("Blair Friend", { exact: true }).click({ button: "right" });
      owner.once("dialog", (dialog) => dialog.accept());
      await ownerMenu.getByRole("menuitem", { name: "Block", exact: true }).click();
      await expect(friend).toHaveCount(0);
      await owner.goto(channelUrl);
      await expect(owner.getByText("Message from a blocked person.")).toBeVisible();
      await expect(owner.getByRole("log").getByText("A friend's message to hide after blocking")).toHaveCount(0);
      await member.goto(channelUrl);
      await expect(messageRow(member, "A friend's message to hide after blocking")).toBeVisible();

      await owner.getByRole("button", { name: "Show blocked message", exact: true }).click();
      const blockedAuthor = messageRow(owner, "A friend's message to hide after blocking").getByRole("button", { name: "Actions for Blair Friend", exact: true }).last();
      await blockedAuthor.click({ button: "right" });
      await ownerMenu.getByRole("menuitem", { name: "Unblock", exact: true }).click();
      // Wait for the persisted relationship to reach the menu before reloading.
      await expect(async () => {
        await owner.keyboard.press("Escape");
        await blockedAuthor.click({ button: "right" });
        await expect(ownerMenu.getByRole("menuitem", { name: "Block", exact: true })).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
      await owner.keyboard.press("Escape");
      await owner.reload();
      await expect(messageRow(owner, "A friend's message to hide after blocking")).toBeVisible();
      await expect(owner.getByText("Message from a blocked person.")).toHaveCount(0);
    } finally {
      await Promise.all([owner.context().close(), member.context().close()]);
    }
  });
});

test("long-press opens a usable message menu on touch devices", async ({ browser, isMobile }) => {
  test.skip(!isMobile, "mobile touch flow");
  test.setTimeout(90_000);
  const page = await newUserPage(browser);

  try {
    await signUp(page, "Taylor Touch");
    await createCommunity(page, "Pocket Menus");
    const message = "Hold this message to reply";
    await sendMessage(page, message);
    // The helper also sees optimistic text; wait for its confirmed replacement
    // before measuring a touch target that must stay attached during the hold.
    await expect(page.getByRole("log", { name: /Messages in/ }).getByRole("listitem", { name: "Sending", exact: true })).toHaveCount(0);
    const confirmedMessage = messageRow(page, message);
    await expect(confirmedMessage).toHaveAttribute("data-message-id", /^[0-9a-f-]{36}$/);
    const target = confirmedMessage.getByText(message, { exact: true });
    await target.scrollIntoViewIfNeeded();
    const bounds = await target.boundingBox();
    if (!bounds) throw new Error("The message has no visible touch target.");

    // Keep a real Chromium touch active until the long-press menu appears.
    const touch = await page.context().newCDPSession(page);
    const menu = page.getByRole("menu", { name: "Message actions", exact: true });
    try {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, id: 0 }],
      });
      await expect(menu).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("mobile-message-context-menu.png") });
    } finally {
      try {
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } finally {
        await touch.detach();
      }
    }

    // Releasing the opening touch must not activate an item under the finger.
    await expect(menu).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Edit message", exact: true })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Reply", exact: true }).tap();
    await expect(page.getByText("Replying to Taylor Touch")).toBeVisible();
    await sendMessage(page, "A reply from the touch context menu");
    await expect(messageRow(page, "A reply from the touch context menu").getByRole("button", { name: /Reply to Taylor Touch/ })).toBeVisible();
  } finally {
    await page.context().close();
  }
});
