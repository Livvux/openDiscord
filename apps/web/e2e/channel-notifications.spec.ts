import { expect, test } from "@playwright/test";
import { createCommunity, expectNoA11yViolations, newUserPage, signUp } from "./helpers";

test("a channel's own notification level mutes it in the sidebar and survives a reload", async ({ browser }) => {
  const page = await newUserPage(browser);
  await signUp(page, "Nina Notify");
  await createCommunity(page, "Quiet place");
  await page.getByRole("button", { name: "Notifications for #general" }).click();
  await expect(page.getByRole("radio", { name: "Community default (Mentions)" })).toBeChecked();
  await expectNoA11yViolations(page);
  await page.getByRole("radio", { name: "Muted" }).check();
  await expect(page.getByRole("link", { name: "general (muted)", includeHidden: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("link", { name: "general (muted)", includeHidden: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Notifications for #general" }).click();
  await page.getByRole("radio", { name: "Community default (Mentions)" }).check();
  await expect(page.getByRole("link", { name: "general", exact: true, includeHidden: true })).toHaveCount(1);
});
