import { expect, test, type Page } from "@playwright/test";
import { createInviteLink, expectNoA11yViolations, newUserPage, PASSWORD, sendMessage, signUp } from "./helpers";

async function showNavigationFor(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true }).first();
  const navigation = page.getByRole("button", { name: "Open navigation" });
  await expect.poll(async () => await button.isVisible() || await navigation.isVisible()).toBe(true);
  if (!await button.isVisible()) await navigation.click();
  await expect(button).toBeVisible();
}
async function openConversation(page: Page, name: string) {
  await page.getByRole("complementary", { name: "Direct conversations" }).getByRole("button").filter({ hasText: name }).click();
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
  const wire: string[] = [];
  for (const page of [alice, bob]) {
    page.on("pageerror", (e) => errors.push(e.message));
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
  await expect(alice.getByRole("button", { name: "Send encrypted message", exact: true })).toBeDisabled();
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
  bob.on("pageerror", (e) => errors.push(e.message));
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
  restored.on("pageerror", (e) => errors.push(e.message));
  await restored.goto("/sign-in");
  await restored.getByLabel("Email", { exact: true }).fill(email);
  await restored.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await restored.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(restored).toHaveURL(/\/app$/);
  await restored.goto("/app/messages");
  await restored.getByRole("complementary", { name: "Direct conversations" }).getByRole("button", { name: "Devices and recovery", exact: true }).click();
  await expect(restored.getByLabel("Open encrypted recovery archive", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await restored.getByLabel("Open encrypted recovery archive", { exact: true }).setInputFiles(recoveryFile!);
  const archive = restored.getByRole("region", { name: "Recovered history archives" });
  await archive.locator("summary").click();
  await expect(archive.getByText(first, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(archive.getByText(offline, { exact: true })).toBeVisible();
  await restored.reload();
  await restored.getByRole("complementary", { name: "Direct conversations" }).getByRole("button", { name: "Devices and recovery", exact: true }).click();
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
  await alice.getByRole("complementary", { name: "Direct conversations" }).getByRole("button", { name: "Devices and recovery", exact: true }).click();
  await expect(alice.getByText("1 encrypted transfer(s) awaiting storage confirmation.", { exact: true })).toBeVisible();
  await expect(restored.getByRole("region", { name: "Recovered history archives" }).locator("summary")).toHaveCount(2, { timeout: 45_000 });
  await expect(alice.getByText("No pending encrypted transfers.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await restored.reload();
  await expect(restored.getByRole("region", { name: "Recovered history archives" }).locator("summary")).toHaveCount(2);
  await restored.getByRole("complementary", { name: "Direct conversations" }).getByRole("button", { name: "Devices and recovery", exact: true }).click();
  await expect(restored.getByRole("button", { name: "Restore current encryption identity", exact: true })).toBeVisible();
  await expectNoA11yViolations(restored);
  await restored.screenshot({ path: info.outputPath("verified-private-messages.png"), fullPage: true });

  const charlie = await newUserPage(browser);
  charlie.context().setDefaultTimeout(15_000); charlie.context().setDefaultNavigationTimeout(30_000);
  await signUp(charlie, "Private Charlie");
  await charlie.goto(invite);
  await charlie.getByRole("button", { name: "Accept invite", exact: true }).click();
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
  expect(errors).toEqual([]);
  await Promise.all([alice.context().close(), bobContext.close(), restored.context().close()]);
});
