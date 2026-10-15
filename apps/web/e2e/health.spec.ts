import { expect, test } from "@playwright/test";

test("public health probes return minimal live responses in a browser", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const [path, status] of [["/api/health", "ok"], ["/api/ready", "ready"]]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["cache-control"]).toContain("no-store");
    expect(await response?.json()).toEqual({ status });
    await expect(page.locator("body")).toContainText(status);
  }
  expect(errors).toEqual([]);
});
