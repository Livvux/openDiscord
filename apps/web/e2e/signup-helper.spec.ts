import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { newUserPage, signUp } from "./helpers";

test("signup waits for a delayed successful auth response before checking its redirect", async ({ browser }) => {
  const page = await newUserPage(browser);
  try {
    await page.route("**/api/auth/sign-up/email", async (route) => {
      const response = await route.fetch();
      // Fault injection: response delivery exceeds the helper's separate five-second redirect deadline.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await route.fulfill({ response });
    });
    await signUp(page, "Delayed auth response");
    await expect(page).toHaveURL("/app");
    const diagnostics: unknown = JSON.parse(await readFile(test.info().outputPath("signup-diagnostics.json"), "utf8"));
    expect(diagnostics).toMatchObject({ phase: "complete", status: 200, apiErrorCode: null, responseMs: expect.any(Number), redirectMs: expect.any(Number) });
  } finally {
    await page.context().close();
  }
});

test("signup reports a rejected auth response without hiding it behind a redirect timeout", async ({ browser }) => {
  const page = await newUserPage(browser);
  try {
    await page.route("**/api/auth/sign-up/email", (route) => route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ code: "SIGNUP_QA_REJECTED", message: "Synthetic sign-up rejection." }),
    }));
    await expect(signUp(page, "Rejected auth response")).rejects.toThrow("HTTP 403 (SIGNUP_QA_REJECTED)");
    await expect(page.getByRole("alert")).toHaveText("Synthetic sign-up rejection.");
    const diagnostics: unknown = JSON.parse(await readFile(test.info().outputPath("signup-diagnostics.json"), "utf8"));
    expect(diagnostics).toMatchObject({ phase: "auth-response", status: 403, apiErrorCode: "SIGNUP_QA_REJECTED", redirectMs: null });
  } finally {
    await page.context().close();
  }
});
