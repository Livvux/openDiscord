import { expect, test } from "@playwright/test";
import { collectRuntimeErrors } from "./runtime-errors";

test("runtime collection catches uncaught errors and rejected promises across navigation", async ({ page }) => {
  const errors: string[] = [];
  await collectRuntimeErrors(page, errors);
  await page.goto("/sign-in");
  await page.evaluate(() => {
    setTimeout(() => { throw new Error("uncaught runtime probe"); }, 0);
    void Promise.reject(new Error("unhandled rejection probe"));
  });
  await expect.poll(() => errors).toEqual(expect.arrayContaining(["uncaught runtime probe", "unhandled rejection probe"]));
  await page.goto("/sign-up");
  await page.evaluate(() => { setTimeout(() => { throw new Error("after navigation probe"); }, 0); });
  await expect.poll(() => errors).toContain("after navigation probe");
});

test("a handled aborted fetch is a network diagnostic, not an unhandled application rejection", async ({ page }, info) => {
  const errors: string[] = [], diagnostics: string[] = [];
  await collectRuntimeErrors(page, errors, diagnostics);
  try {
  await page.goto("/sign-in");
  await page.route("**/api/runtime-error-probe", (route) => route.abort("aborted"));
  expect(await page.evaluate(async () => {
    try { await fetch("/api/runtime-error-probe"); return false; } catch { return true; }
  })).toBe(true);
  // Wait for a later browser task so a possible unhandledrejection event has fired.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  expect(errors).toEqual([]);
  } finally {
    await info.attach("runtime-error-probe", { body: JSON.stringify({ errors, diagnostics }), contentType: "application/json" });
  }
});
