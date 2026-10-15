import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, newUserPage, PASSWORD, uniqueEmail } from "./helpers";

test("registration requires age attestation and public policies stay accessible", async ({ browser }) => {
  const page = await newUserPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/sign-up");
  const form = page.locator("form:visible");
  await form.getByLabel("Display name").fill("Policy reader");
  await form.getByLabel("Email").fill(uniqueEmail("policy"));
  await form.getByLabel("Password").fill(PASSWORD);
  const attestation = form.getByRole("checkbox", { name: new RegExp(`I am at least ${process.env.MINIMUM_AGE ?? 16} years old`) });
  await expect(attestation).not.toBeChecked();
  await expect(attestation).toHaveAttribute("required", "");
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  await expectNoA11yViolations(page);
  for (const [path, title] of [["terms", "Terms of use"], ["privacy", "Privacy notice"], ["guidelines", "Community Guidelines"], ["imprint", "Imprint / Anbieterkennzeichnung"]]) {
    await page.goto(`/${path}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expectNoA11yViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
  await page.context().close();
});
