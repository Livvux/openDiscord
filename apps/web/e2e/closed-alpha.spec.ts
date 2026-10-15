import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { CAPTCHA_HEADER, expectNoA11yViolations, newUserPage, PASSWORD } from "./helpers";

// Instance-wide switch: runs in its own project after all other specs (playwright.config.ts).
test("closed alpha: requests wait for approval, approved accounts get in", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const admin = await newUserPage(browser);
  const applicant = await newUserPage(browser);
  const suffix = randomUUID();
  const adminEmail = `alpha-admin-${suffix}@example.test`;
  const applicantEmail = `alpha-applicant-${suffix}@example.test`;
  let adminId: string | undefined;
  try {
    const signup = await admin.request.post("/api/auth/sign-up/email", { headers: { Origin: baseURL!, ...CAPTCHA_HEADER }, data: { email: adminEmail, password: PASSWORD, name: "Alpha Admin" } });
    expect(signup.ok()).toBe(true);
    adminId = (await signup.json()).user.id as string;
    await db.query("insert into instance_admin (user_id) values ($1)", [adminId]);

    await admin.goto("/app/admin");
    await admin.getByRole("switch", { name: "Closed Alpha" }).click();
    await admin.getByLabel("Reason", { exact: true }).fill("E2E alpha wave");
    await admin.getByRole("button", { name: "Turn on Closed Alpha" }).click();
    await expect(admin.getByText("Closed Alpha on")).toBeVisible();
    await expect(admin.getByRole("switch", { name: "Closed Alpha" })).toBeChecked();

    await applicant.goto("/sign-up");
    await expect(applicant.getByRole("heading", { name: "Request alpha access" })).toBeVisible();
    await expectNoA11yViolations(applicant);
    await applicant.getByLabel("Display name").fill("Alpha Applicant");
    await applicant.getByLabel("Email").fill(applicantEmail);
    await applicant.getByLabel("Password").fill(PASSWORD);
    await applicant.getByRole("checkbox", { name: /I am at least/ }).check();
    await expect(applicant.locator('[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
    await applicant.getByRole("button", { name: "Request access" }).click();
    await expect(applicant.getByRole("heading", { name: "You're on the list" })).toBeVisible();

    await applicant.goto("/sign-in");
    await applicant.getByLabel("Email").fill(applicantEmail);
    await applicant.getByLabel("Password").fill(PASSWORD);
    await applicant.getByRole("checkbox", { name: /I am at least/ }).check();
    await applicant.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(applicant.getByRole("alert").filter({ hasText: "waiting for approval" })).toBeVisible();
    expect(await (await applicant.request.get("/api/auth/get-session")).json()).toBeNull();

    await admin.goto("/app/admin?tab=approvals");
    const row = admin.getByRole("listitem").filter({ hasText: applicantEmail });
    await expectNoA11yViolations(admin);
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row).toHaveCount(0);

    await applicant.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(applicant).toHaveURL(/\/app/);
    await expect(applicant.getByRole("heading", { name: "Welcome, Alpha Applicant" })).toBeVisible();
  } finally {
    await db.query("update instance_settings set closed_alpha = false");
    await admin.context().close().catch(() => {});
    await applicant.context().close().catch(() => {});
    if (adminId) {
      await db.query("delete from instance_audit_log where actor_id=$1", [adminId]);
      await db.query("delete from instance_admin where user_id=$1", [adminId]);
    }
    await db.query('delete from "user" where email = any($1::text[])', [[adminEmail, applicantEmail]]);
    await db.end();
  }
});
