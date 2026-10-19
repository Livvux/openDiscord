import { expect, test, type Locator, type Page } from "@playwright/test";
import { installVoiceProductObserver } from "./fixtures/voice-product-observer";
import { observeVoiceProductResult } from "./fixtures/voice-product-results";
import { createCommunity, createInviteLink, expectNoA11yViolations, joinAsNewUser, newUserPage, sendMessage, signUp } from "./helpers";

// Two accounts in a 1:1 conversation: ringing, a missed call, accepting, native SAS and admission,
// decoded encrypted media, and a block ending the call. Runs in the Voice product job (strict SFU).
const participant = (page: Page, name: string) => page.getByRole("listitem", { name: `Voice participant ${name}`, exact: true });
const audience = (page: Page) => page.getByRole("region", { name: "Full Voice audience", exact: true });
const evidence = (page: Page) => page.evaluate(() => window.__voiceProductEvidence.snapshot());
async function verifyPair(a: Page, aName: string, b: Page, bName: string) {
  const aPeer = participant(a, bName), bPeer = participant(b, aName);
  const symbols = (peer: Locator) => peer.getByRole("list", { name: "Voice SAS symbols" }).locator("li");
  await expect(symbols(aPeer)).toHaveCount(7, { timeout: 30_000 });
  await expect(symbols(bPeer)).toHaveCount(7, { timeout: 30_000 });
  const lhs = await symbols(aPeer).allTextContents();
  await expect.poll(async () => JSON.stringify(await symbols(bPeer).allTextContents()) === JSON.stringify(lhs)).toBe(true);
  await aPeer.getByRole("button", { name: "I compared all seven symbols — they match" }).click();
  await bPeer.getByRole("button", { name: "I compared all seven symbols — they match" }).click();
  await aPeer.getByRole("button", { name: "Admit this verified participant" }).click();
  await bPeer.getByRole("button", { name: "Admit this verified participant" }).click();
  await expect(aPeer).toContainText("Admitted for this exact device.");
  await expect(bPeer).toContainText("Admitted for this exact device.");
}
async function messagingReady(page: Page) {
  await page.goto("/app/messages");
  await expect(page.getByRole("status").filter({ hasText: "Encrypted messaging ready." })).toBeVisible({ timeout: 30_000 });
}

test.describe("encrypted direct-message calls", () => {
  test.describe.configure({ retries: 0 });
  test.skip(({ isMobile }) => isMobile, "Two desktop contexts.");
  test("1:1 call rings, records a missed call, connects with E2EE media and ends on a block", async ({ browser }, info) => {
    test.setTimeout(240_000);
    const alice = await newUserPage(browser), names = ["Call Alice", "Call Bob"];
    const pages: Page[] = [alice];
    const runtimeErrors: string[] = [];
    let primaryFailure = false, stage = "setup";
    try {
      const prepare = async (page: Page) => {
        await page.addInitScript(installVoiceProductObserver);
        if (page.context().browser()?.browserType().name() !== "firefox") await page.context().grantPermissions(["microphone", "camera"]);
        // Account/friend setup navigations are covered elsewhere (Firefox can report an aborted RSC stream there).
        page.on("pageerror", (error) => { if (stage !== "setup") runtimeErrors.push(`${stage}: ${error.message}`); });
      };
      await prepare(alice);
      await signUp(alice, names[0]);
      await createCommunity(alice, "Call Club");
      const bob = await joinAsNewUser(browser, names[1], await createInviteLink(alice));
      pages.push(bob); await prepare(bob);
      await sendMessage(bob, "Hello from Bob");
      // Become friends, so the conversation opens without a message request.
      await alice.getByRole("log", { name: /Messages in/ }).getByRole("button", { name: `View profile of ${names[1]}`, exact: true }).last().click();
      await alice.getByRole("dialog", { name: names[1] }).getByRole("button", { name: "Add Friend" }).click();
      await expect(alice.getByRole("dialog", { name: names[1] }).getByRole("status").filter({ hasText: "Friend request sent." })).toBeVisible();
      await bob.goto("/app");
      await bob.getByRole("button", { name: `Accept friend request from ${names[0]}` }).click();
      for (const page of pages) await messagingReady(page);
      await alice.goto("/app");
      await alice.getByRole("group", { name: "Filter friends" }).getByRole("button", { name: /^All/ }).click();
      await alice.getByRole("link", { name: `Message ${names[1]}` }).click();
      await expect(alice.getByRole("heading", { level: 1, name: names[1] })).toBeVisible({ timeout: 30_000 });

      stage = "missed-call";
      // A call nobody answers becomes a missed call for Bob.
      await alice.getByRole("button", { name: "Call", exact: true }).click();
      await alice.getByRole("button", { name: "Create temporary device and join" }).click();
      await expect(audience(alice)).toBeVisible({ timeout: 20_000 });
      const ring = bob.getByRole("group", { name: `Incoming call from ${names[0]}` });
      await expect(ring).toBeVisible({ timeout: 20_000 });
      await expectNoA11yViolations(bob);
      await alice.getByRole("button", { name: "Leave Voice", exact: true }).click();
      const missed = bob.getByRole("group", { name: `Missed call from ${names[0]}` });
      await expect(missed).toBeVisible({ timeout: 20_000 });
      await missed.getByRole("button", { name: "Dismiss" }).click();
      await expect(missed).toHaveCount(0);

      stage = "accept";
      // Bob accepts the next call from wherever he is; accepting is his join consent.
      await alice.getByRole("button", { name: "Join voice", exact: true }).click();
      await alice.getByRole("button", { name: "Create temporary device and join" }).click();
      await expect(audience(alice)).toBeVisible({ timeout: 20_000 });
      await ring.getByRole("button", { name: "Accept call" }).click();
      await expect(bob).toHaveURL(/\/app\/messages\?c=/);
      await expect(audience(bob)).toBeVisible({ timeout: 20_000 });
      for (const page of pages) await expect(audience(page).getByRole("listitem", { name: /^Voice participant / })).toHaveCount(2);
      await verifyPair(alice, names[0], bob, names[1]);
      for (const page of pages) expect(await evidence(page)).toMatchObject({ captureCalls: 0, senders: 0, workers: 0 });
      await Promise.all(pages.map((page) => audience(page).getByRole("button", { name: "Allow this audience and prepare encrypted media" }).click()));
      for (const page of pages) await expect(page.getByRole("status").filter({ hasText: "Encrypted voice ready — microphone off" }).first()).toBeVisible({ timeout: 30_000 });

      stage = "media";
      // Every DM participant may speak and show video; only explicit clicks capture.
      await alice.getByRole("button", { name: "Unmute microphone", exact: true }).click();
      await expect(alice.getByRole("button", { name: "Mute microphone", exact: true })).toBeVisible({ timeout: 25_000 });
      await alice.getByRole("button", { name: "Camera", exact: true }).click();
      await expect(alice.getByRole("button", { name: "Stop camera", exact: true })).toBeVisible({ timeout: 25_000 });
      await expect(bob.getByRole("button", { name: "Camera", exact: true })).toBeEnabled();
      const autoplay = bob.getByRole("button", { name: "Enable audio playback" }).first();
      if (await autoplay.isVisible()) await autoplay.click();
      await expect.poll(async () => (await evidence(bob)).audioEnergy, { timeout: 20_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await evidence(bob)).videoFrames, { timeout: 20_000 }).toBeGreaterThan(10);
      const stats = await evidence(bob);
      expect(stats.codecs).toContain("audio/opus"); expect(stats.codecs).toContain("video/vp8");
      expect(stats).toMatchObject({ ordered: true, captureCalls: 0 });
      await expect(bob.getByRole("region", { name: "Video" }).locator("video")).toHaveCount(1);
      await bob.screenshot({ path: info.outputPath("dm-call.png"), mask: [audience(bob)] });

      stage = "block";
      // A block ends the call for both people and no new call can start.
      await bob.getByRole("button", { name: "Block person" }).click();
      for (const page of pages) await expect(page.getByRole("status").filter({ hasText: "Voice stopped" }).first()).toBeVisible({ timeout: 20_000 });
      for (const page of pages) await expect.poll(async () => (await evidence(page)).allTerminated).toBe(true);
      await expect(bob.getByRole("button", { name: "Call", exact: true })).toHaveCount(0);
      expect(runtimeErrors).toEqual([]);
    } catch (error) {
      primaryFailure = true; throw error;
    } finally {
      const closed = await Promise.all(pages.map((page) => observeVoiceProductResult(() => page.context().close(), { timeoutMs: 2000, stage: "cleanup" })));
      if (!primaryFailure && closed.some((result) => !result.ok)) throw new Error("DM call context cleanup failed.");
    }
  });
});
