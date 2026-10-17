import { authenticatorCode as totp } from "../tests/totp";
import { expect, test, type Page } from "@playwright/test";
import { expectNoA11yViolations, newUserPage, PASSWORD, signUp } from "./helpers";

test.skip(({ isMobile }) => isMobile, "desktop flow");

async function signOut(page: Page) {
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

async function signInWithPassword(page: Page, email: string) {
  const form = page.locator("form:visible");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(PASSWORD);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("authenticator app (TOTP) two-factor sign-in with backup code fallback", async ({ browser }) => {
  const page = await newUserPage(browser);
  const email = await signUp(page, "Tara Totp");
  await page.goto("/app/settings");

  await page.getByLabel("Confirm your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Set up" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const secret = (await page.locator("code").first().textContent())!.trim();
  const backupCode = (await page.getByRole("listitem").filter({ hasText: /^[\w-]{6,}$/ }).first().textContent())!.trim();
  await expectNoA11yViolations(page);

  // A wrong code doesn't enable it.
  await page.getByLabel("Enter the 6-digit code to finish").fill("000000");
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid code" })).toBeVisible();
  await page.getByLabel("Enter the 6-digit code to finish").fill(totp(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Authenticator app is on.")).toBeVisible();

  // Password alone is no longer enough.
  await signOut(page);
  await signInWithPassword(page, email);
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in$/);

  await signInWithPassword(page, email);
  await page.getByLabel(/6-digit code/).fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Friends" })).toBeVisible();

  // A backup code works once.
  await signOut(page);
  await signInWithPassword(page, email);
  await page.getByRole("button", { name: "Use a backup code instead" }).click();
  await page.getByLabel("Backup code").fill(backupCode);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Friends" })).toBeVisible();
});

test("passkey registration and passwordless sign-in", async ({ browser }) => {
  const page = await newUserPage(browser);
  // Chromium's virtual authenticator stands in for Touch ID / a security key.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });

  await signUp(page, "Pat Passkey");
  await page.goto("/app/settings");
  await page.getByLabel("Name (optional)").fill("Test laptop");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByText("Test laptop")).toBeVisible();

  await signOut(page);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Friends" })).toBeVisible();

  await page.goto("/app/settings");
  await page.getByRole("button", { name: "Remove passkey Test laptop" }).click();
  await expect(page.getByText("No passkeys yet.")).toBeVisible();
});
