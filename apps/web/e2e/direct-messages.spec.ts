import { expect, test, type Page } from "@playwright/test";
import { createInviteLink, expectNoA11yViolations, newUserPage, PASSWORD, sendMessage, signUp } from "./helpers";
import { collectRuntimeErrors } from "./runtime-errors";

async function showNavigationFor(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true }).first();
  const navigation = page.getByRole("button", { name: "Open navigation" });
  await expect.poll(async () => await button.isVisible() || await navigation.isVisible()).toBe(true);
  if (!await button.isVisible()) await navigation.click();
  await expect(button).toBeVisible();
}
async function openConversation(page: Page, name: string) {
  const link = page.getByRole("navigation", { name: "Home" }).getByRole("link").filter({ has: page.locator("[data-dm-peer-name]", { hasText: name }) });
  const navigation = page.getByRole("button", { name: "Open navigation" });
  // New conversations reach the sidebar with its next poll.
  await expect.poll(async () => await link.isVisible() || await navigation.isVisible(), { timeout: 20_000 }).toBe(true);
  if (!await link.isVisible()) await navigation.click();
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}
async function openSecurity(page: Page) {
  const button = page.getByRole("button", { name: "Devices and recovery", exact: true });
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
}
async function verify(a: Page, b: Page) {
  await a.getByRole("button", { name: /^Verify device / }).first().click();
  await expect(b.getByRole("button", { name: "Accept verification", exact: true })).toBeVisible({ timeout: 30_000 });
  await b.getByRole("button", { name: "Accept verification", exact: true }).click();
  await expect(a.getByRole("button", { name: "Show verification numbers", exact: true })).toBeVisible({ timeout: 30_000 });
  await a.getByRole("button", { name: "Show verification numbers", exact: true }).click();
  await expect(a.locator("[data-verification-code]")).toBeVisible({ timeout: 30_000 });
  await expect(b.locator("[data-verification-code]")).toBeVisible({ timeout: 30_000 });
  expect(await a.locator("[data-verification-code]").textContent()).toBe(await b.locator("[data-verification-code]").textContent());
  await a.getByRole("button", { name: "The numbers match", exact: true }).click();
  await b.getByRole("button", { name: "The numbers match", exact: true }).click();
  await expect(a.getByRole("button", { name: /^Verify device / })).toHaveCount(0, { timeout: 30_000 });
  await expect(b.getByRole("button", { name: /^Verify device / })).toHaveCount(0, { timeout: 30_000 });
}

test("real SAS, ciphertext transport, offline delivery, persistent history and recovery", async ({ browser }, info) => {
  test.setTimeout(300_000);
  const alice = await newUserPage(browser);
  let bob = await newUserPage(browser);
  for (const context of [alice.context(), bob.context()]) { context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(30_000); }
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const wire: string[] = [];
  for (const page of [alice, bob]) {
    await collectRuntimeErrors(page, errors, diagnostics);
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/dm") && request.method() === "POST") wire.push(request.postData() ?? ""); });
  }
  const email = await signUp(alice, "Private Alice");
  await showNavigationFor(alice, "Create a community");
  await alice.getByRole("button", { name: "Create a community", exact: true }).first().click();
  await alice.getByLabel("Name", { exact: true }).fill("Private Test Community");
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  await expect(alice.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
  await showNavigationFor(alice, "Invite people");
  const invite = await createInviteLink(alice);
  const mobileNavigation = alice.getByRole("button", { name: "Open navigation" });
  if (await mobileNavigation.isVisible()) {
    await alice.keyboard.press("Escape");
    await expect(mobileNavigation).toHaveAttribute("aria-expanded", "false");
  }
  await signUp(bob, "Private Bob");
  await bob.goto(invite);
  await bob.getByRole("button", { name: "Accept invite", exact: true }).click();
  await sendMessage(bob, "Find my community profile here.");
  await expect(alice.getByRole("link", { name: "Message Private Bob privately" })).toBeVisible();
  await alice.getByRole("link", { name: "Message Private Bob privately" }).click();
  await expect(alice.getByRole("button", { name: "Send message request", exact: true })).toBeEnabled({ timeout: 30_000 });
  await alice.getByRole("button", { name: "Send message request", exact: true }).click();
  await bob.goto("/app/messages");
  await openConversation(bob, "Private Alice");
  await bob.getByRole("button", { name: "Accept message request", exact: true }).click();
  // Sending no longer waits for SAS (trust on first use); verification is the optional upgrade.
  await expect(alice.getByLabel("Encrypted message", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await openSecurity(alice);
  await expect(alice.getByRole("button", { name: /^Verify device / })).toHaveCount(1, { timeout: 30_000 });
  await verify(alice, bob);
  const first = "Private payload only in the two browsers 9182";
  await alice.getByLabel("Encrypted message", { exact: true }).fill(first);
  await alice.getByRole("button", { name: "Send encrypted message", exact: true }).click();
  await expect(bob.getByRole("log").getByText(first, { exact: true })).toBeVisible({ timeout: 30_000 });
  const conversationId = (await alice.request.get("/api/dm").then((r) => r.json())).conversations[0].id as string;
  const serverTimeline = await alice.request.get(`/api/dm?conversation=${conversationId}`).then((r) => r.text());
  expect(serverTimeline).not.toContain(first);
  expect(wire.join("\n")).not.toContain(first);
  await alice.getByRole("button", { name: "Choose emoji", exact: true }).click();
  const emojiPicker = alice.getByRole("dialog", { name: "Choose emoji or sticker" });
  await emojiPicker.getByRole("textbox").fill("party popper");
  await emojiPicker.getByRole("gridcell", { name: "party popper", exact: true }).click();
  await expect(alice.getByLabel("Encrypted message", { exact: true })).toHaveValue("🎉");
  await alice.getByRole("button", { name: "Send encrypted message", exact: true }).click();
  const privateEmoji = bob.getByRole("log").getByRole("img", { name: "🎉", exact: true });
  await expect(privateEmoji).toBeVisible({ timeout: 30_000 });
  await expect(privateEmoji).toHaveAttribute("src", "/twemoji/17.0.3/svg/1f389.svg");
  expect(wire.join("\n")).not.toContain("🎉");
  await bob.reload();
  await openConversation(bob, "Private Alice");
  await expect(bob.getByRole("log").getByText(first, { exact: true })).toBeVisible({ timeout: 30_000 });
  const bobContext = bob.context();
  await bob.close();
  const offline = "Offline encrypted delivery 6317";
  await alice.getByLabel("Encrypted message", { exact: true }).fill(offline);
  await alice.getByRole("button", { name: "Send encrypted message", exact: true }).click();
  await expect(alice.getByRole("log").getByText(offline, { exact: true })).toBeVisible();
  bob = await bobContext.newPage();
  await collectRuntimeErrors(bob, errors, diagnostics);
  await bob.goto("/app/messages");
  await openConversation(bob, "Private Alice");
  await expect(bob.getByRole("log").getByText(offline, { exact: true })).toBeVisible({ timeout: 30_000 });

  await alice.getByRole("button", { name: "Create encrypted recovery backup", exact: true }).click();
  const download = alice.waitForEvent("download");
  await alice.getByRole("link", { name: "Download your private recovery file", exact: true }).click();
  const recoveryFile = await (await download).path();
  expect(recoveryFile).toBeTruthy();
  const restored = await newUserPage(browser);
  restored.context().setDefaultTimeout(15_000); restored.context().setDefaultNavigationTimeout(30_000);
  await collectRuntimeErrors(restored, errors, diagnostics);
  await restored.goto("/sign-in?next=/app/messages");
  await restored.getByLabel("Email", { exact: true }).fill(email);
  await restored.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await restored.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(restored).toHaveURL(/\/app\/messages$/);
  await openSecurity(restored);
  await expect(restored.getByLabel("Open encrypted recovery archive", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await restored.getByLabel("Open encrypted recovery archive", { exact: true }).setInputFiles(recoveryFile!);
  const archive = restored.getByRole("region", { name: "Recovered history archives" });
  await archive.locator("summary").click();
  await expect(archive.getByText(first, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(archive.getByText(offline, { exact: true })).toBeVisible();
  await restored.reload();
  await openSecurity(restored);
  restored.once("dialog", (dialog) => dialog.accept());
  await restored.getByRole("button", { name: "Restore current encryption identity", exact: true }).click();
  await expect(restored.getByRole("button", { name: "Restore current encryption identity", exact: true })).toHaveCount(0);
  await restored.reload();
  await restored.getByRole("region", { name: "Recovered history archives" }).locator("summary").click();
  await expect(restored.getByRole("region", { name: "Recovered history archives" }).getByText(first, { exact: true })).toBeVisible();
  // Abort the first archive transaction after Olm has consumed its delivery. A fresh
  // encrypted retry must recover it, including after the sending browser reloads.
  await restored.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
      const request = original.call(this, value, key);
      if (this.name === "imports") {
        IDBObjectStore.prototype.add = original;
        document.documentElement.dataset.archiveCommitAborted = "true";
        this.transaction.abort();
      }
      return request;
    };
  });
  await expect(alice.getByRole("button", { name: "Share identity and history", exact: true })).toBeVisible({ timeout: 30_000 });
  await alice.getByRole("button", { name: "Share identity and history", exact: true }).click();
  await expect.poll(() => restored.evaluate(() => document.documentElement.dataset.archiveCommitAborted)).toBe("true");
  await expect(alice.getByText("1 encrypted transfer(s) awaiting storage confirmation.", { exact: true })).toBeVisible();
  await alice.reload();
  await openConversation(alice, "Private Bob");
  await openSecurity(alice);
  await expect(alice.getByText("1 encrypted transfer(s) awaiting storage confirmation.", { exact: true })).toBeVisible();
  await expect(restored.getByRole("region", { name: "Recovered history archives" }).locator("summary")).toHaveCount(2, { timeout: 45_000 });
  await expect(alice.getByText("No pending encrypted transfers.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await restored.reload();
  await expect(restored.getByRole("region", { name: "Recovered history archives" }).locator("summary")).toHaveCount(2);
  await openSecurity(restored);
  await expect(restored.getByRole("button", { name: "Restore current encryption identity", exact: true })).toBeVisible();
  await expectNoA11yViolations(restored);
  await restored.screenshot({ path: info.outputPath("verified-private-messages.png"), fullPage: true });

  const charlie = await newUserPage(browser);
  charlie.context().setDefaultTimeout(15_000); charlie.context().setDefaultNavigationTimeout(30_000);
  await signUp(charlie, "Private Charlie");
  await charlie.goto(invite);
  await charlie.getByRole("button", { name: "Accept invite", exact: true }).click();
  await expect(charlie).toHaveURL(/\/app\/c\/[0-9a-f-]+(?:\/|$)/);
  await expect(charlie.getByRole("heading", { level: 1, name: "general", exact: true })).toBeVisible();
  const charlieId = (await charlie.request.get("/api/auth/get-session").then((response) => response.json())).user.id as string;
  const secondConversation = await alice.evaluate(async (target) => {
    const response = await fetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request", target }) });
    if (!response.ok) throw new Error("Could not create second conversation fixture");
    return (await response.json()).id as string;
  }, charlieId);
  await charlie.evaluate(async (id) => {
    const response = await fetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "respond", id, status: "accepted" }) });
    if (!response.ok) throw new Error("Could not accept second conversation fixture");
  }, secondConversation);
  await alice.getByLabel("Encrypted message", { exact: true }).fill("Draft intended only for Bob");
  await openConversation(alice, "Private Charlie");
  await expect(alice.getByLabel("Encrypted message", { exact: true })).toHaveValue("");
  await openConversation(alice, "Private Bob");
  await expect(alice.getByLabel("Encrypted message", { exact: true })).toHaveValue("");
  await charlie.context().close();

  await bob.route("**/api/dm?conversation=*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.messages.push({ ...body.messages[0], id: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    await route.fulfill({ response, json: body });
  });
  await bob.reload();
  await openConversation(bob, "Private Alice");
  await expect(bob.getByRole("log").getByText(first, { exact: true })).toHaveCount(1, { timeout: 30_000 });
  await expect(bob.getByRole("log").getByText(/Cannot decrypt or authenticate/)).toHaveCount(1);
  await bob.unrouteAll();
  await bob.route("**/api/dm?conversation=*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.messages[0].transactionId = "00000000-0000-4000-8000-000000000001";
    await route.fulfill({ response, json: body });
  });
  await bob.reload();
  await openConversation(bob, "Private Alice");
  await expect(bob.getByRole("log").getByText(first, { exact: true })).toHaveCount(0);
  await expect(bob.getByRole("log").getByText(/Cannot decrypt or authenticate/).first()).toBeVisible({ timeout: 30_000 });
  await bob.unrouteAll();
  await bob.getByRole("button", { name: "Block person", exact: true }).click();
  await expect(bob.getByRole("button", { name: "Unblock person", exact: true })).toBeVisible();
  await expect(alice.getByRole("button", { name: "Send encrypted message", exact: true })).toHaveCount(0, { timeout: 30_000 });
  await info.attach("runtime-errors", { body: JSON.stringify({ errors, diagnostics }), contentType: "application/json" });
  expect(errors).toEqual([]);
  await Promise.all([alice.context().close(), bobContext.close(), restored.context().close()]);
});


test("explicit identity reset revokes devices and backups after password confirmation", async ({ browser }) => {
  const page = await newUserPage(browser);
  page.context().setDefaultTimeout(15_000);
  const errors: string[] = [];
  const diagnostics: string[] = [];
  await collectRuntimeErrors(page, errors, diagnostics);
  try {
    const email = await signUp(page, "Reset identity");
    await page.goto("/app/messages");
    await expect(page.getByText("Encrypted messaging ready.", { exact: true })).toBeVisible({ timeout: 30_000 });
    await openSecurity(page);
    await page.getByRole("button", { name: "Create encrypted recovery backup", exact: true }).click();
    await expect(page.getByRole("link", { name: "Download your private recovery file", exact: true })).toBeVisible();
    const before = await page.request.get("/api/dm").then((response) => response.json());
    const oldDevice = before.devices.find((device: { id: string; revoked: boolean }) => !device.revoked).id as string;
    await page.getByRole("button", { name: "Reset lost encryption identity", exact: true }).click();
    await expect(page.getByRole("button", { name: "Permanently reset encryption identity", exact: true })).toBeDisabled();
    await page.getByLabel("Current password", { exact: true }).fill(PASSWORD);
    await page.getByRole("checkbox", { name: /I understand that this destroys/ }).check();
    await page.getByRole("button", { name: "Reset lost encryption identity", exact: true }).click();
    await expect(page.getByRole("button", { name: "Permanently reset encryption identity", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Current password", { exact: true })).toHaveValue("");
    await page.getByLabel("Current password", { exact: true }).fill(PASSWORD);
    await page.getByRole("checkbox", { name: /I understand that this destroys/ }).check();
    await page.getByRole("button", { name: "Permanently reset encryption identity", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in\?next=/);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/messages$/);
    await expect(page.getByText("Encrypted messaging ready.", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => {
      const current = await page.request.get("/api/dm").then((response) => response.json());
      return current.devices.filter((device: { id: string; revoked: boolean }) => !device.revoked && device.id !== oldDevice).length;
    }).toBe(1);
    const after = await page.request.get("/api/dm").then((response) => response.json());
    expect(after.devices.find((device: { id: string }) => device.id === oldDevice).revoked).toBe(true);
    expect((await page.request.get("/api/dm/backups").then((response) => response.json())).backups).toHaveLength(0);
    await test.info().attach("runtime-errors", { body: JSON.stringify({ errors, diagnostics }), contentType: "application/json" });
    expect(errors).toEqual([]);
  } finally { await page.context().close(); }
});
