import { expect, test } from "@playwright/test";
import { expectNoA11yViolations } from "./helpers";

for (const path of ["/discord-alternative", "/hosting"]) {
  test(`${path} supports an informed hosting decision`, async ({ page }) => {
    const errors: string[] = [];
    const failedRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.url().startsWith(page.url().split("/").slice(0, 3).join("/")) && response.status() >= 400) {
        failedRequests.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });
    await page.goto("/");
    await page.getByRole("contentinfo").getByRole("link", { name: path === "/hosting" ? "Hosting and costs" : "Discord alternative", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("main")).toContainText("Closed alpha");
    await expect(page.getByRole("main")).toContainText("not end-to-end encrypted");
    await expect(page.getByRole("main").getByRole("link", { name: "Request alpha access", exact: true })).toHaveAttribute("href", "/sign-up");
    await expect(page.getByRole("main").getByRole("link", { name: "Read the self-hosting guide", exact: true })).toHaveAttribute("href", "https://github.com/Livvux/openDiscord/blob/main/docs/SELF-HOSTING.md");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expectNoA11yViolations(page);
    expect(errors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
}
