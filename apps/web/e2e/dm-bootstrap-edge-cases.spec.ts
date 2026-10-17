import { expect, test, type Page, type Route } from "@playwright/test";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, PASSWORD, signUp } from "./helpers";

// Browser-level edge cases of the first encryption setup and of history paging, with the unmodified
// Matrix SDK, the production server and PostgreSQL. Request timing is controlled with routes only.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function signIn(page: Page, email: string, next: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[/?]/g, "\\$&")}$`));
}
const userIdOf = async (page: Page) => (await page.request.get("/api/auth/get-session").then((r) => r.json())).user.id as string;
const deviceIdOf = (page: Page, userId: string) => page.evaluate((id) => JSON.parse(localStorage.getItem(`opendiscord.dm.device:${id}`)!).id as string, userId);
/** DmDeviceBootstrap marks a completed setup; until then a navigation would interrupt it. */
const setupCompleted = (page: Page, userId: string) => expect.poll(() => page.evaluate((id) => localStorage.getItem(`opendiscord.dm.ready:${id}`) !== null, userId), { timeout: 30_000 }).toBe(true);
async function openConversation(page: Page, name: string) {
  await page.goto("/app/messages");
  const link = page.getByRole("navigation", { name: "Home" }).getByRole("link").filter({ has: page.locator("[data-dm-peer-name]", { hasText: name }) });
  await link.click({ timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  await expect(page.getByText("Encrypted messaging ready.", { exact: true })).toBeVisible({ timeout: 30_000 });
}
async function send(page: Page, text: string) {
  const composer = page.getByLabel("Encrypted message", { exact: true });
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(text);
  await composer.press("Enter");
}
/** Community fixture so the two accounts may open a DM; returns the second person's page. */
async function connect(alice: Page, bobName: string) {
  await createCommunity(alice, "DM edge cases");
  const bob = await joinAsNewUser(alice.context().browser()!, bobName, await createInviteLink(alice));
  const bobId = await userIdOf(bob);
  // Home enrolls the encryption device, as on a first visit.
  await bob.goto("/app");
  await setupCompleted(bob, bobId);
  const id = await alice.evaluate(async (target) => {
    const response = await fetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request", target }) });
    if (!response.ok) throw new Error("Could not create the conversation fixture");
    return (await response.json()).id as string;
  }, bobId);
  await bob.evaluate(async (conversation) => {
    const response = await fetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "respond", id: conversation, status: "accepted" }) });
    if (!response.ok) throw new Error("Could not accept the conversation fixture");
  }, id);
  return bob;
}
const isSigning = (route: Route) => (route.request().postDataJSON() as { kind?: string } | null)?.kind === "signing";

test.describe("first DM setup and history paging edge cases", () => {
  test.skip(({ isMobile }) => isMobile, "browser crypto state does not depend on the layout");
  test.setTimeout(240_000);
  const errors: string[] = [];
  test.beforeEach(() => { errors.length = 0; });
  test.afterEach(() => { expect(errors).toEqual([]); });
  const watch = (page: Page) => { page.on("pageerror", (e) => errors.push(e.message)); return page; };

  test("two browsers racing the first setup: the loser is an unverified device that gets no keys until verified", async ({ browser }) => {
    const winner = watch(await newUserPage(browser)), loser = watch(await newUserPage(browser));
    // Both browsers queried "no identity" and generated their own; the server stores the winner's first.
    const winnerArrived = deferred(), loserArrived = deferred(), winnerStored = deferred();
    let raced = { winner: false, loser: false };
    await winner.context().route("**/api/dm/crypto", async (route) => {
      if (!isSigning(route) || raced.winner) return route.fallback();
      raced = { ...raced, winner: true }; winnerArrived.resolve();
      await loserArrived.promise;
      await route.fulfill({ response: await route.fetch() });
      winnerStored.resolve();
    });
    await loser.context().route("**/api/dm/crypto", async (route) => {
      if (!isSigning(route) || raced.loser) return route.fallback();
      raced = { ...raced, loser: true }; loserArrived.resolve();
      await Promise.all([winnerArrived.promise, winnerStored.promise]);
      await route.fallback();
    });
    const email = await signUp(winner, "Race Alice");
    await signIn(loser, email, "/app");
    const alice = await userIdOf(winner);
    await Promise.all([setupCompleted(winner, alice), setupCompleted(loser, alice)]);
    expect(raced).toEqual({ winner: true, loser: true });
    const loserDevice = await deviceIdOf(loser, alice);

    const bob = watch(await connect(winner, "Race Bob"));
    await openConversation(winner, "Race Bob");
    await send(winner, "Winner to Bob 5521");
    await expect(winner.getByRole("log").getByText("Winner to Bob 5521", { exact: true })).toBeVisible({ timeout: 30_000 });
    await openConversation(bob, "Race Alice");
    await expect(bob.getByRole("log").getByText("Winner to Bob 5521", { exact: true })).toBeVisible({ timeout: 30_000 });
    await send(bob, "Bob to Alice 7734");
    await expect(winner.getByRole("log").getByText("Bob to Alice 7734", { exact: true })).toBeVisible({ timeout: 30_000 });

    // Neither the winner nor Bob shared room keys with the unverified loser, and it cannot send.
    await openConversation(loser, "Race Bob");
    const loserLog = loser.getByRole("log", { name: "Private conversation with Race Bob" });
    await expect(loserLog.getByText(/Cannot decrypt or authenticate/)).toHaveCount(2, { timeout: 30_000 });
    await expect(loserLog.getByText(/Winner to Bob 5521|Bob to Alice 7734/)).toHaveCount(0);
    await send(loser, "Loser before verification");
    await expect(loser.getByRole("alert").filter({ hasText: /Verify this browser with your other device/ })).toBeVisible();
    await expect(bob.getByRole("log").getByText("Loser before verification", { exact: true })).toHaveCount(0);

    // The winner lists the loser as an unverified device of the same account; SAS upgrades it.
    await winner.getByRole("button", { name: "Devices and recovery", exact: true }).click();
    await winner.getByRole("button", { name: `Verify device ${loserDevice.slice(0, 8)}`, exact: true }).click();
    await loser.getByRole("button", { name: "Accept verification", exact: true }).click({ timeout: 30_000 });
    await winner.getByRole("button", { name: "Show verification numbers", exact: true }).click({ timeout: 30_000 });
    await expect(winner.locator("[data-verification-code]")).toBeVisible({ timeout: 30_000 });
    await expect(loser.locator("[data-verification-code]")).toBeVisible({ timeout: 30_000 });
    expect(await winner.locator("[data-verification-code]").textContent()).toBe(await loser.locator("[data-verification-code]").textContent());
    await winner.getByRole("button", { name: "The numbers match", exact: true }).click();
    await loser.getByRole("button", { name: "The numbers match", exact: true }).click();
    await expect(winner.getByRole("button", { name: `Verify device ${loserDevice.slice(0, 8)}`, exact: true })).toHaveCount(0, { timeout: 30_000 });

    // After verification, new messages reach the former loser in both directions.
    await send(bob, "Bob after verification 9043");
    await expect(loserLog.getByText("Bob after verification 9043", { exact: true })).toBeVisible({ timeout: 30_000 });
    await send(loser, "Second browser after verification 3310");
    await expect(bob.getByRole("log").getByText("Second browser after verification 3310", { exact: true })).toBeVisible({ timeout: 30_000 });
    await Promise.all([winner, loser, bob].map((page) => page.context().close()));
  });

  test("a network error after the server stored the identity is not treated as a second device", async ({ browser }) => {
    const alice = watch(await newUserPage(browser));
    let lost = false;
    // The server commits the signing keys, but the browser never sees the response.
    await alice.context().route("**/api/dm/crypto", async (route) => {
      if (!isSigning(route) || lost) return route.fallback();
      lost = true;
      await route.fetch();
      await route.abort("connectionreset");
    });
    await signUp(alice, "Lossy Alice", "/sign-up?next=/app/messages");
    await expect.poll(() => lost, { timeout: 30_000 }).toBe(true);
    // Fails visibly instead of continuing with a device that its own identity never signed.
    await expect(alice.getByRole("button", { name: "Retry encryption", exact: true })).toBeVisible({ timeout: 30_000 });
    await alice.getByRole("button", { name: "Retry encryption", exact: true }).click();
    await expect(alice.getByText("Encrypted messaging ready.", { exact: true })).toBeVisible({ timeout: 30_000 });

    const bob = watch(await connect(alice, "Lossy Bob"));
    await openConversation(alice, "Lossy Bob");
    await send(alice, "Signed after the retry 6408");
    await openConversation(bob, "Lossy Alice");
    await expect(bob.getByRole("log").getByText("Signed after the retry 6408", { exact: true })).toBeVisible({ timeout: 30_000 });
    await Promise.all([alice, bob].map((page) => page.context().close()));
  });

  test("loading earlier messages after the peer's identity changed fails closed like the live timeline", async ({ browser }) => {
    const alice = watch(await newUserPage(browser));
    await signUp(alice, "Paging Alice");
    let bob = watch(await connect(alice, "Paging Bob"));
    const bobEmail = (await bob.request.get("/api/auth/get-session").then((r) => r.json())).user.email as string;
    await openConversation(bob, "Paging Alice");
    await send(bob, "Earlier from Bob 2287");
    await openConversation(alice, "Paging Bob");
    await expect(alice.getByRole("log").getByText("Earlier from Bob 2287", { exact: true })).toBeVisible({ timeout: 30_000 });
    await send(alice, "Latest from Alice 1175");
    await expect(alice.getByRole("log").getByText("Latest from Alice 1175", { exact: true })).toBeVisible({ timeout: 30_000 });

    // A one-message page, so Bob's message is only reachable through "Load earlier".
    await alice.route((url) => url.pathname === "/api/dm" && url.searchParams.has("conversation") && !url.searchParams.has("before"), async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, messages: body.messages.slice(-1), hasMore: true } });
    });
    await alice.reload();
    const log = alice.getByRole("log", { name: "Private conversation with Paging Bob" });
    await expect(log.getByText("Latest from Alice 1175", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(log.getByText("Earlier from Bob 2287", { exact: true })).toHaveCount(0);

    // Hold Alice's polling refresh, so her last device query predates Bob's new identity.
    const unfreeze = deferred();
    let frozen = false, listings = 0;
    await alice.route((url) => url.pathname === "/api/dm" && url.search === "", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      frozen = true; listings += 1;
      await unfreeze.promise;
      await route.fallback();
    });
    await expect.poll(() => frozen, { timeout: 10_000 }).toBe(true);

    // Bob resets his encryption identity and enrolls a new one.
    await bob.evaluate(async (password) => {
      const state = await fetch("/api/dm/reset").then((r) => r.json());
      const response = await fetch("/api/dm/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: state.identity, password, confirmed: true }) });
      if (!response.ok) throw new Error("Identity reset fixture failed");
    }, PASSWORD);
    await bob.context().close();
    bob = watch(await newUserPage(browser));
    await signIn(bob, bobEmail, "/app/messages");
    await expect(bob.getByText("Encrypted messaging ready.", { exact: true })).toBeVisible({ timeout: 30_000 });

    await alice.getByRole("button", { name: "Load earlier encrypted messages", exact: true }).click();
    await expect(log.getByText(/Cannot decrypt or authenticate/)).toHaveCount(1, { timeout: 30_000 });
    await expect(log.getByText("Earlier from Bob 2287", { exact: true })).toHaveCount(0);
    // Once the held refresh completes, the paged message stays in the timeline and stays closed.
    const held = listings;
    unfreeze.resolve();
    // Refreshes are single-flight: a new listing request means the held one has rendered.
    await expect.poll(() => listings, { timeout: 15_000 }).toBeGreaterThan(held);
    await expect(log.getByText(/Cannot decrypt or authenticate/)).toHaveCount(1);
    await expect(log.getByText("Earlier from Bob 2287", { exact: true })).toHaveCount(0);
    await Promise.all([alice, bob].map((page) => page.context().close()));
  });
});
