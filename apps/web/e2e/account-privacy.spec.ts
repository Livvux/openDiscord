import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, newUserPage, signUp } from "./helpers";

test("account settings explain email delivery requirements and show coarse device labels", async ({ browser, isMobile }) => {
  const page = await newUserPage(browser);
  await signUp(page, "Account privacy");
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { name: "Email address", exact: true })).toBeVisible();
  await expect(page.getByText("Email changes are unavailable because this instance has not configured email delivery.")).toBeVisible();
  await expect(page.getByText("This device", { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "This device" }))
    .toContainText(isMobile ? "Chrome on Android" : "Chrome on Windows");
  await expectNoA11yViolations(page);
  await page.context().close();
});
