import { expect, test, type JSHandle } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createCommunity, createInviteLink, joinAsNewUser, newUserPage, sendMessage, signUp, waitForLive } from "./helpers";

type Witness = { source: EventSource; ready: boolean; ids: string[]; errors: number };

// The ordinary Playwright webServer starts one standalone Next process. A writer-side
// native SSE witness therefore observes the same live hub that the held reader will join.
test("fresh community snapshot catches up after its first stream opens", async ({ browser, isMobile }) => {
  test.skip(isMobile, "the initial transport interleaving is covered on desktop");
  test.setTimeout(90_000);
  const writer = await newUserPage(browser);
  const diagnostics: { order: string[]; statuses: { actor: string; path: string; status: number }[]; errors: string[]; attempts: number; forwarded: number; catchupIds: string[][] } = {
    order: [], statuses: [], errors: [], attempts: 0, forwarded: 0, catchupIds: [],
  };
  let reader: Awaited<ReturnType<typeof newUserPage>> | undefined;
  let witness: JSHandle<Witness> | undefined;
  let release = () => {};
  let released = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const monitor = (page: typeof writer, actor: string) => {
    page.on("pageerror", (error) => diagnostics.errors.push(`${actor}: ${error.name}`));
    page.on("console", (message) => {
      // Do not serialize arbitrary application output or credentials.
      if (message.type() === "error") diagnostics.errors.push(`${actor}: console.error`);
    });
  };
  monitor(writer, "writer");
  try {
    await signUp(writer, "Gap Writer");
    await createCommunity(writer, "Initial Stream Gap");
    await waitForLive(writer);
    const channelUrl = writer.url();
    const match = new URL(channelUrl).pathname.match(/^\/app\/c\/([^/]+)\/([^/]+)$/);
    expect(match).not.toBeNull();
    const [, communityId, channelId] = match!;
    const streamPath = `/api/communities/${communityId}/events`;
    const historyPath = `/api/channels/${channelId}/messages`;
    const seed = `snapshot-seed-${crypto.randomUUID()}`;
    await sendMessage(writer, seed);
    const invite = await createInviteLink(writer);
    reader = await joinAsNewUser(browser, "Gap Reader", invite);
    monitor(reader, "reader");
    await reader.goto("/app");

    // This is a separate real authenticated native stream, never a replacement
    // constructor or injected event. Its ready + created events are actual bytes.
    witness = await writer.evaluateHandle((path): Witness => {
      const source = new EventSource(path);
      const observed: Witness = { source, ready: false, ids: [], errors: 0 };
      source.addEventListener("ready", () => { observed.ready = true; });
      source.addEventListener("message.created", (event) => {
        const message: unknown = JSON.parse(event.data);
        if (message && typeof message === "object" && "id" in message && typeof message.id === "string") observed.ids.push(message.id);
      });
      source.addEventListener("error", () => { observed.errors += 1; });
      return observed;
    }, streamPath);
    await expect.poll(() => witness!.evaluate((observed) => observed.ready)).toBe(true);
    diagnostics.order.push("writer-witness-ready");

    let reached = () => {};
    const initialAttempt = new Promise<void>((resolve) => { reached = resolve; });
    await reader.route((url) => url.pathname === streamPath, async (route) => {
      expect(route.request().method()).toBe("GET");
      diagnostics.attempts += 1;
      diagnostics.order.push("reader-stream-held");
      reached();
      await gate;
      diagnostics.forwarded += 1;
      await route.continue();
    });
    reader.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === streamPath || url.pathname === historyPath) {
        diagnostics.statuses.push({ actor: "reader", path: url.pathname, status: response.status() });
      }
      if (released && url.pathname === historyPath && response.request().method() === "GET") {
        void response.json().then((page: { messages: { id: string }[] }) => {
          diagnostics.catchupIds.push(page.messages.map((message) => message.id));
        }).catch(() => diagnostics.errors.push("reader: history response unreadable"));
      }
    });
    // A document navigation discards the previous community provider and replay cache.
    await reader.goto(channelUrl);
    await initialAttempt;
    await expect(reader.getByRole("log").getByText(seed, { exact: true })).toBeVisible();
    await expect(reader.locator('[data-realtime="connecting"]')).toBeAttached();
    await expect(reader.locator('[data-realtime="open"]')).toHaveCount(0);
    expect(diagnostics.attempts).toBe(1);
    expect(diagnostics.forwarded).toBe(0);
    diagnostics.order.push("reader-real-snapshot-visible-before-send");

    const content = `gap-message-${crypto.randomUUID()}`;
    const actionResponse = writer.waitForResponse((response) => response.request().method() === "POST"
      && response.request().headers()["next-action"] !== undefined
      && response.url() === channelUrl
      && (response.request().postData() ?? "").includes(content));
    await sendMessage(writer, content);
    const action = await actionResponse;
    diagnostics.statuses.push({ actor: "writer", path: new URL(action.url()).pathname, status: action.status() });
    expect(action.ok()).toBe(true);
    const item = writer.getByRole("log").locator("li[data-message-id]").filter({ hasText: content });
    await expect(item).toHaveCount(1);
    const id = await item.getAttribute("data-message-id");
    expect(id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    // The composer only upserts result.data on action success; also require the
    // actual successful result and exact committed UUID in the real action body.
    const actionBody = await action.text();
    expect(actionBody).toContain('"ok":true');
    expect(actionBody).toContain(id!);
    const persisted = await writer.request.get(historyPath);
    diagnostics.statuses.push({ actor: "writer", path: historyPath, status: persisted.status() });
    expect(persisted.status()).toBe(200);
    const history: { messages: { id: string; content: string }[] } = await persisted.json();
    expect(history.messages.filter((message) => message.id === id && message.content === content)).toHaveLength(1);
    diagnostics.order.push("composer-action-success-and-authorized-history-uuid");
    await expect.poll(() => witness!.evaluate((observed) => observed.ids)).toContain(id);
    expect(await witness.evaluate((observed) => observed.errors)).toBe(0);
    diagnostics.order.push("actual-message-created-witness-before-reader-release");
    expect(diagnostics.attempts).toBe(1);
    expect(diagnostics.forwarded).toBe(0);
    await expect(reader.getByRole("log").getByText(content, { exact: true })).toHaveCount(0);

    released = true;
    diagnostics.order.push("release-unchanged-initial-request");
    release();
    await waitForLive(reader);
    diagnostics.order.push("reader-first-ready-open");
    await expect(reader.getByRole("log").locator(`li[data-message-id="${id}"]`),
      "committed message published before initial subscribe must arrive through first-open history catch-up")
      .toHaveCount(1, { timeout: 10_000 });
    await expect.poll(() => diagnostics.catchupIds.some((ids) => ids.includes(id!))).toBe(true);
    expect(diagnostics.attempts).toBe(1);
    expect(diagnostics.forwarded).toBe(1);
    await expect(reader).toHaveURL(channelUrl);
    expect(diagnostics.errors).toEqual([]);
    diagnostics.order.push("uuid-exactly-once-from-real-catchup-without-reconnect");
  } finally {
    release();
    if (reader) await reader.screenshot({ path: test.info().outputPath("initial-sync.png") }).catch(() => {});
    await writeFile(test.info().outputPath("error-context-initial-sync.md"), `Initial SSE ordering and HTTP statuses (no credentials):\n\n${JSON.stringify(diagnostics, null, 2)}\n`);
    if (witness) await witness.evaluate((observed) => observed.source.close()).catch(() => {});
    await reader?.context().close();
    await writer.context().close();
  }
});
