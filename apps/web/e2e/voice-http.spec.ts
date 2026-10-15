import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createCommunity, newUserPage, signUp } from "./helpers";

test("Voice HTTP uses the real browser session and registered enrollment without activating media", async ({ browser }) => {
  const page = await newUserPage(browser), consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.name));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource.*\b(403|405)\b/.test(message.text())) consoleErrors.push("unexpected-console-error"); });
  await signUp(page, "Voice Control HTTP");
  await createCommunity(page, "Voice HTTP browser");
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.getByLabel("Channel name").fill("control-http");
  await page.getByRole("radio", { name: /Voice/ }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Create channel" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "control-http" })).toBeVisible();
  const channelId = new URL(page.url()).pathname.split("/").at(-1)!;
  const anchor = { id: randomUUID(), secret: "a".repeat(64), name: "Explicit isolated HTTP test enrollment" };
  const input = { channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: "b".repeat(64), consent: true };
  // Only this disposable test browser's own cookie jar is used. No cookie/token value is read.
  const result = await page.evaluate(async ({ anchor, input }) => {
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
    };
    const registered = await post("/api/dm", { action: "register", input: anchor });
    const joined = await post("/api/voice/control", { action: "join", input }, { "x-dm-device": anchor.id, "x-dm-device-secret": anchor.secret });
    if (joined.status !== 200) return { registered: registered.status, joined: joined.status };
    const snapshot = joined.body;
    const binding = { callId: snapshot.callId, memberId: snapshot.memberId, joinNonce: snapshot.joinNonce, expectedGeneration: snapshot.generation };
    const headers = { "x-voice-member": snapshot.memberId, "x-voice-secret": input.enrollmentSecret };
    const heartbeat = await post("/api/voice/control", { action: "heartbeat", input: binding }, headers);
    const sync = await post("/api/voice/control", { action: "crypto", input: { ...binding, request: { kind: "sync" } } }, headers);
    const denied = await post("/api/voice/control", { action: "heartbeat", input: binding }, { ...headers, "x-voice-secret": "c".repeat(64) });
    const left = await post("/api/voice/control", { action: "leave", input: binding }, headers);
    return { registered: registered.status, joined: joined.status, heartbeat: heartbeat.status, sync: sync.status, empty: sync.body.events.length === 0, denied: denied.status, deniedCode: denied.body.code, left: left.status, caches: [joined.cache, heartbeat.cache, sync.cache, denied.cache, left.cache] };
  }, { anchor, input });
  expect(result).toMatchObject({ registered: 200, joined: 200, heartbeat: 200, sync: 200, empty: true, denied: 403, deniedCode: "forbidden", left: 200, caches: Array(5).fill("private, no-store") });
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    const response = await page.context().request.fetch("/api/voice/control", { method });
    expect(response.status()).toBe(405);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  }
  expect(consoleErrors).toEqual([]);
  await page.context().close();
});
