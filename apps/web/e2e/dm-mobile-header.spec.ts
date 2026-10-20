import { expect, test, type Page } from "@playwright/test";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, signUp } from "./helpers";

const userIdOf = async (page: Page) => (await page.request.get("/api/auth/get-session").then((r) => r.json())).user.id as string;
const dm = (page: Page, body: object) => page.evaluate(async (payload) => {
  const response = await fetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error("DM fixture request failed");
  return (await response.json()) as { id: string };
}, body);

// RC1 QA: at 390px (iPhone 13) the header actions squeezed the peer's name to zero width.
test("a 1:1 conversation keeps the peer's name readable on narrow phones", async ({ browser, isMobile }) => {
  test.skip(!isMobile, "phone layout");
  const alice = await newUserPage(browser);
  await signUp(alice, "Narrow Alice");
  await createCommunity(alice, "Narrow phones");
  await alice.getByRole("button", { name: "Open navigation", exact: true }).click();
  const bob = await joinAsNewUser(browser, "Narrow Bob", await createInviteLink(alice));
  const { id } = await dm(alice, { action: "request", target: await userIdOf(bob) });
  await dm(bob, { action: "respond", id, status: "accepted" });
  for (const width of [390, 375]) {
    await alice.setViewportSize({ width, height: 700 });
    await alice.goto(`/app/messages?c=${id}`);
    const title = alice.getByRole("heading", { level: 1, name: "Narrow Bob", exact: true });
    await expect(title).toBeVisible();
    expect((await title.boundingBox())!.width, `title width at ${width}px`).toBeGreaterThan(40);
    expect(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`).toBe(true);
  }
  await Promise.all([alice.context().close(), bob.context().close()]);
});
