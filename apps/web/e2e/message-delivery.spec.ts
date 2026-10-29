import { expect, test } from "@playwright/test";
import { createCommunity, newUserPage, sendMessage, signUp } from "./helpers";

test("a lost send response can be retried without duplicating the stored message", async ({ browser }, info) => {
  const page = await newUserPage(browser);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error" && !entry.text().includes("net::ERR_FAILED")) consoleErrors.push(entry.text()); });
  try {
    await signUp(page, "Delivery QA");
    await createCommunity(page, "Delivery QA");
    const text = "Stored once despite a lost response";
    let interrupted = false;
    let retrySucceeded = false;
    const attempts: string[] = [];
    page.on("response", (response) => {
      if (interrupted && response.request().method() === "POST" && response.request().headers()["next-action"] && response.request().postData()?.includes(text) && response.ok()) retrySucceeded = true;
    });
    await page.route("**/app/**", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes(text)) attempts.push(request.postData()!);
      if (!interrupted && request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes(text)) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        interrupted = true;
        await route.abort("failed");
      } else await route.continue();
    });
    const composer = page.getByRole("textbox", { name: "Message #general" });
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Retry message", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("delivery-unconfirmed.png") });
    await expect(page.locator("[data-message-id]").filter({ hasText: text })).toHaveCount(1);
    await page.getByRole("button", { name: "Retry message", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry message", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Sending", { exact: true })).toHaveCount(0);
    await expect.poll(() => retrySucceeded).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    await expect(page.locator("[data-message-id]").filter({ hasText: text })).toHaveCount(1);
    await page.reload();
    await expect(page.locator("[data-message-id]").filter({ hasText: text })).toHaveCount(1);
    await expect(page.locator("[data-message-id]").getByText(text, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("message-delivery.png") });
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally { await page.context().close(); }
});

test("a rejected reply preserves its editable draft and attachment", async ({ browser }) => {
  test.skip(!process.env.ATTACHMENT_DIR && !process.env.R2_ENDPOINT, "Attachment storage required");
  const page = await newUserPage(browser);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => { if (entry.type() === "error") consoleErrors.push(entry.text()); });
  try {
    await signUp(page, "Rejected delivery QA");
    await createCommunity(page, "Rejected delivery QA");
    await sendMessage(page, "Temporary reply target");
    const parent = page.locator("[data-message-id]").filter({ hasText: "Temporary reply target" });
    await parent.getByText("Temporary reply target", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
    await parent.getByText("Temporary reply target", { exact: true }).click({ button: "right" });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "Delete message", exact: true }).click();
    await expect(parent).toHaveCount(0);
    await page.locator('input[type="file"]').setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retained attachment") });
    const composer = page.getByRole("textbox", { name: "Message #general" });
    await composer.fill("Editable rejected reply");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The message you replied to was deleted." })).toBeVisible();
    await expect(composer).toHaveValue("Editable rejected reply");
    await expect(page.getByRole("button", { name: "Remove retry.txt", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry message", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel reply", exact: true }).click();
    await composer.fill("Corrected reply with retained attachment");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const sent = page.locator("[data-message-id]").filter({ hasText: "Corrected reply with retained attachment" });
    await expect(sent).toHaveCount(1);
    await expect(sent.getByRole("link", { name: /retry.txt/ })).toBeVisible();
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally { await page.context().close(); }
});
