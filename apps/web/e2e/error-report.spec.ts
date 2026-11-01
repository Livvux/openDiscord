import { expect, test } from "@playwright/test";

test("startup diagnostics omit private error details without violating CSP", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  const reports: unknown[] = [];
  await page.route("**/api/error-report", async (route) => {
    reports.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
  await page.evaluate(() => {
    const error = new TypeError("private-message recovery-key customer@example.test");
    error.stack = `TypeError: private-message\n at test (${location.origin}/_next/static/chunks/qa.js:12:34)`;
    window.dispatchEvent(new ErrorEvent("error", { error }));
  });
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toEqual({ source: "browser-error", type: "TypeError", frames: [{ filename: "/_next/static/chunks/qa.js", lineno: 12, colno: 34 }] });
  expect(JSON.stringify(reports)).not.toMatch(/private-message|recovery-key|customer@example/);
  expect(consoleErrors).toEqual([]);
});
