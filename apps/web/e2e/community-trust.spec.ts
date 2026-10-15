import { expect, test, type Page } from "@playwright/test";
import { createInviteLink, expectNoA11yViolations, newUserPage, sendMessage, signUp } from "./helpers";

async function showNavigationFor(page: Page, buttonName: string) {
  const button = page.getByRole("button", { name: buttonName, exact: true }).first();
  const navigation = page.getByRole("button", { name: "Open navigation" });
  await expect.poll(async () => await button.isVisible() || await navigation.isVisible()).toBe(true);
  if (!await button.isVisible()) {
    await navigation.click();
  }
  await expect(button).toBeVisible();
}

test("rules join, updated acknowledgement and private ban appeal review", async ({ browser }, testInfo) => {
  const owner = await newUserPage(browser);
  const errors: string[] = [];
  owner.on("pageerror", (e) => errors.push(e.message));
  await signUp(owner, "Trust Moderator");
  await owner.goto("/app");
  await showNavigationFor(owner, "Create a community");
  await owner.getByRole("button", { name: "Create a community" }).first().click();
  await owner.getByLabel("Name", { exact: true }).fill("Community Trust");
  await owner.getByRole("button", { name: "Create", exact: true }).click();
  await expect(owner.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
  const channelPath = new URL(owner.url()).pathname;
  const communityId = channelPath.split("/")[3];
  const settingsPath = `/app/c/${communityId}/settings`;
  await showNavigationFor(owner, "Invite people");
  const invitePath = await createInviteLink(owner);
  await owner.goto(settingsPath);
  const rules = owner.locator('section[aria-labelledby="community-rules"]');
  await rules.getByRole("textbox", { name: "Community rules", exact: true }).fill("Be respectful. <b>Plain text rules</b>");
  await rules.getByRole("checkbox", { name: "Require acknowledgement before joining or sending messages", exact: true }).check();
  await rules.getByRole("button", { name: "Save community rules" }).click();
  await expect(rules.getByRole("status")).toHaveText("Rules saved.");

  const member = await newUserPage(browser);
  member.on("pageerror", (e) => errors.push(e.message));
  await signUp(member, "Trust Appellant");
  await member.goto(invitePath);
  await expect(member.getByText("Be respectful. <b>Plain text rules</b>", { exact: true })).toBeVisible();
  await expect(member.getByRole("button", { name: "Accept invite" })).toBeDisabled();
  await member.getByLabel("I acknowledge the community rules").check();
  await member.getByRole("button", { name: "Accept invite" }).click();
  await expect(member.getByRole("heading", { name: "general", exact: true })).toBeVisible();
  await sendMessage(member, "I joined after acknowledging.");

  await rules.getByRole("textbox", { name: "Community rules", exact: true }).fill("Updated: respect privacy.");
  await rules.getByRole("button", { name: "Save community rules" }).click();
  await expect(rules.getByRole("status")).toHaveText("Rules saved.");
  await member.reload();
  const banner = member.getByRole("region", { name: "Required community rules" });
  await expect(banner.getByText("Updated: respect privacy.")).toBeVisible();
  await banner.getByRole("button", { name: "I acknowledge the community rules" }).click();
  await expect(banner).toHaveCount(0);
  await sendMessage(member, "I accepted the update.");
  await expectNoA11yViolations(member);

  await owner.reload();
  owner.once("dialog", (dialog) => dialog.accept("Repeated disruption <b>text only</b>"));
  await owner.getByRole("button", { name: "Ban Trust Appellant", exact: true }).click();
  await expect(owner.getByRole("button", { name: "Ban Trust Appellant", exact: true })).toHaveCount(0);
  await member.goto("/app/restrictions");
  await expect(member.getByText("Reason: Repeated disruption <b>text only</b>", { exact: true })).toBeVisible();
  await member.getByLabel("Appeal explanation").fill("I understand; please review <script>as text</script>.");
  await member.getByRole("button", { name: "Submit ban appeal" }).click();
  await expect(member.getByRole("status")).toHaveText("Your appeal is awaiting review.");
  await expect(member.getByRole("button", { name: "Submit ban appeal" })).toHaveCount(0);
  await member.screenshot({ path: testInfo.outputPath("own-restriction.png"), fullPage: true });

  await owner.reload();
  const reviews = owner.locator('section[aria-labelledby="ban-appeals"]');
  await expect(reviews.getByText("I understand; please review <script>as text</script>.", { exact: true })).toBeVisible();
  await reviews.getByLabel("Decision").selectOption("unban");
  await reviews.getByLabel("Reply to appellant (optional)").fill("You can rejoin.");
  await reviews.getByRole("button", { name: "Resolve appeal for Trust Appellant" }).click();
  await expect(reviews.getByText("Resolved: ban removed — You can rejoin.", { exact: true })).toBeVisible();
  await member.reload();
  await expect(member.getByText("You have no active community bans.")).toBeVisible();
  await expect(member.getByText("Moderator reply: You can rejoin.", { exact: true })).toBeVisible();
  await expectNoA11yViolations(member);
  await member.screenshot({ path: testInfo.outputPath("resolved-appeal.png"), fullPage: true });

  const visitor = await newUserPage(browser);
  await visitor.goto("/app/restrictions");
  await expect(visitor).toHaveURL(/\/sign-in/);
  expect(errors).toEqual([]);
  await Promise.all([owner.context().close(), member.context().close(), visitor.context().close()]);
});
