import { expect, test } from "@playwright/test";

test("inline event attributes are blocked while the Next sign-in form hydrates", async ({ page }) => {
  const response = await page.goto("/sign-in");
  expect(response?.headers()["content-security-policy"]).toContain("script-src-attr 'none'");
  await page.getByLabel("Email").fill("csp@example.test");
  await expect(page.getByLabel("Email")).toHaveValue("csp@example.test");
  await page.route("**/api/auth/sign-in/email", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "CSP hydration probe" }),
  }));
  await page.getByLabel("Password", { exact: true }).fill("disposable csp probe password");
  const request = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/sign-in/email");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await request;
  await expect(page.locator("form:visible").getByRole("alert")).toHaveText("CSP hydration probe");
  await page.evaluate(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.effectiveDirective === "script-src-attr") document.documentElement.dataset.cspBlocked = "yes";
    });
    const button = document.createElement("button");
    button.setAttribute("onclick", "document.documentElement.dataset.cspExecuted='yes'");
    document.body.append(button);
    button.click();
    button.remove();
  });
  await expect.poll(() => page.locator("html").getAttribute("data-csp-blocked")).toBe("yes");
  expect(await page.locator("html").getAttribute("data-csp-executed")).toBeNull();
});
