import { expect, test } from "@playwright/test";
import { expectNoA11yViolations } from "./helpers";

test("landing page renders without errors and links to sign-up", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Communities belong to everyone.");
  await expect(page.getByRole("img", { name: /Preview of the opendiscord chat client/ })).toBeVisible();

  // Tabs in the install panel swap content.
  await page.getByRole("tab", { name: "Hosted" }).click();
  await expect(page.getByRole("tabpanel")).toContainText("Start a community");

  await expectNoA11yViolations(page);

  const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noHorizontalScroll).toBe(true);

  await page.getByRole("link", { name: "Start a community" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  expect(errors).toEqual([]);
});

test("sends the security headers on every page, with or without a TLS proxy in front", async ({ request }) => {
  const headers = (await request.get("/")).headers();
  expect(headers["strict-transport-security"]).toBe("max-age=31536000");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
});


test("funding page publishes the operator cost total and works on small screens", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("link", { name: "Funding and running costs", exact: true }).click();
  await expect(page).toHaveURL(/\/funding$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What it costs to keep us online.");
  await expect(page.getByRole("region", { name: "Monthly running costs" })).toContainText("€250");
  await expect(page.getByRole("region", { name: "Our funding goal" })).toContainText("€250 monthly");
  await expect(page.getByRole("link", { name: "Contribute on GitHub" })).toHaveAttribute("href", "https://github.com/Livvux/openDiscord/blob/main/CONTRIBUTING.md");
  await expect(page.getByRole("link", { name: "Sponsor Livvux on GitHub" })).toHaveAttribute("href", "https://github.com/sponsors/Livvux");
  await expectNoA11yViolations(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
